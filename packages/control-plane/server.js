import https from "node:https";
import http from "node:http";
import { WebSocketServer } from "ws";
import { createPublicKey, verify, randomBytes, randomUUID } from "node:crypto";
import {
  readFileSync,
  chmodSync,
  rmSync,
  lstatSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Control } from "./control.js";
import { exclusive } from "@arthegall/shared/sqlite";
import { ControlStore } from "./store.js";
import { IncomingEvent } from "./replay.js";
import {
  protocolOffer,
  replayFeature,
  versionIssue,
  decodeRunnerMessage,
  validEventRow,
  proof,
  maxMessageBytes,
  replayPartBytes,
} from "@arthegall/shared/protocol";

export function serve(dir, opt) {
  const lock = exclusive(dir),
    store = new ControlStore(dir),
    control = new Control(store);
  const cert = opt.cert ?? join(dir, "server.crt"),
    key = opt.key ?? join(dir, "server.key");
  if (!opt.cert && !opt.key && !existsSync(cert)) {
    const name = opt.name ?? "localhost";
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name))
      throw Error("invalid TLS hostname");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:3072",
        "-nodes",
        "-days",
        "365",
        "-subj",
        "/CN=" + name,
        "-addext",
        "subjectAltName=DNS:" + name + ",DNS:localhost,IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
  }
  const tls = https.createServer({
    cert: readFileSync(cert),
    key: readFileSync(key),
  });
  const ws = new WebSocketServer({
    server: tls,
    path: "/runner",
    maxPayload: maxMessageBytes,
    perMessageDeflate: false,
  });
  const live = new Map(),
    codes = new Map();
  const send = (peer, msg) => peer.socket.send(JSON.stringify(msg));
  function stamp(peer) {
    const r = store.runners.get(peer.id);
    if (r) {
      r.lastSeen = new Date().toISOString();
      store.runners.put(r.id, r);
    }
  }
  function pump(peer) {
    if (!peer.ready || live.get(peer.id) !== peer) return;
    for (const command of control.dispatch(peer.id, peer.sent))
      send(peer, { op: "command", command });
  }
  function admit(peer, r) {
    const prev = live.get(r.id);
    live.set(r.id, peer);
    peer.id = r.id;
    delete r.compatibilityIssue;
    store.runners.put(r.id, r);
    stamp(peer);
    if (prev && prev !== peer) prev.socket.terminate();
    send(peer, {
      op: "welcome",
      runner: r.id,
      seq: store.sequence(r.id),
      ...protocolOffer,
      features: peer.parts ? [replayFeature] : [],
      ...(peer.parts ? { replayPartBytes } : {}),
    });
  }
  ws.on("connection", (socket) => {
    const peer = {
      socket,
      nonce: randomBytes(32).toString("hex"),
      seen: Date.now(),
      created: Date.now(),
      sent: new Set(),
    };
    socket.arthegallPeer = peer;
    send(peer, { op: "challenge", nonce: peer.nonce, ...protocolOffer });
    socket.on("error", () => socket.terminate());
    socket.on("pong", () => {
      peer.seen = Date.now();
      if (peer.id && live.get(peer.id) === peer) stamp(peer);
    });
    socket.on("close", () => {
      if (live.get(peer.id) === peer) {
        stamp(peer);
        live.delete(peer.id);
      }
      if (peer.code) codes.delete(peer.code);
    });
    socket.on("message", (data, binary) => {
      try {
        let m;
        if (binary) {
          if (live.get(peer.id) !== peer || !peer.incoming)
            throw Error("unexpected event part");
          peer.seen = Date.now();
          const row = peer.incoming.accept(data);
          if (!row) {
            send(peer, { op: "eventContinue" });
            return;
          }
          if (!validEventRow(row)) throw Error("invalid multipart event");
          peer.incoming = null;
          m = { op: "events", rows: [row] };
        } else {
          m = decodeRunnerMessage(data);
          if (peer.incoming && m.op !== "inspected")
            throw Error("event transfer already active");
        }
        peer.seen = Date.now();
        if (!peer.id) {
          if (m.op !== "identify" || !peer.nonce)
            throw Error("expected identity");
          const pk = createPublicKey(m.publicKey);
          if (
            pk.asymmetricKeyType !== "ed25519" ||
            !verify(
              null,
              proof(peer.nonce),
              pk,
              Buffer.from(m.signature, "base64"),
            )
          )
            throw Error("invalid proof");
          peer.nonce = null;
          peer.publicKey = pk.export({ type: "spki", format: "pem" });
          const known = store.runners
            .list()
            .find((r) => r.publicKey === peer.publicKey);
          const issue = versionIssue(m.protocolVersion, "runner");
          if (issue) {
            if (known && !live.has(known.id))
              store.runners.put(known.id, {
                ...known,
                compatibilityIssue: issue,
              });
            socket.close(4002, issue);
            return;
          }
          peer.parts =
            m.protocolVersion === undefined ||
            m.features?.includes(replayFeature);
          if (known) {
            admit(peer, known);
            return;
          }
          if (m.runner) throw Error("unknown runner identity");
          peer.name = String(m.name ?? "runner").slice(0, 128);
          peer.code = randomBytes(6).toString("hex");
          peer.expires = Date.now() + 300000;
          codes.set(peer.code, peer);
          send(peer, { op: "pair", code: peer.code, expires: peer.expires });
          return;
        }
        if (live.get(peer.id) !== peer) throw Error("connection superseded");
        stamp(peer);
        if (m.op === "eventStart") {
          if (!peer.parts || m.seq !== store.sequence(peer.id) + 1)
            throw Error("unexpected event sequence");
          peer.incoming = new IncomingEvent(m.seq, m.bytes);
          send(peer, { op: "eventContinue" });
          return;
        }
        if (m.op === "events") {
          store.transaction(() => {
            let cursor = store.sequence(peer.id);
            for (const row of m.rows) {
              if (row.seq <= cursor) continue;
              if (row.seq !== cursor + 1) throw Error("missing event");
              control.ingest(peer.id, row);
              cursor = row.seq;
              if (row.event.type === "receipt")
                peer.sent.delete(row.event.command);
            }
          });
          send(peer, { op: "ack", seq: store.sequence(peer.id) });
        } else if (m.op === "ready") {
          if (peer.ready || peer.inspect) throw Error("unexpected ready");
          const runner = store.runners.get(peer.id);
          runner.harnesses = m.harnesses;
          store.runners.put(peer.id, runner);
          const ids = control.unresolved(peer.id).map((c) => c.id);
          if (ids.length) {
            peer.inspect = ids;
            send(peer, { op: "inspect", ids });
          } else peer.ready = true;
        } else if (m.op === "inspected") {
          if (
            !peer.inspect ||
            !Array.isArray(m.outcomes) ||
            m.outcomes.length !== peer.inspect.length ||
            m.outcomes.some((o, i) => o.id !== peer.inspect[i])
          )
            throw Error("unexpected delivery report");
          control.reconcile(peer.id, m.outcomes, peer.sent);
          peer.inspect = null;
          peer.ready = true;
        } else throw Error("unknown runner message");
        pump(peer);
      } catch (e) {
        console.error("runner connection:", e.message);
        socket.close(1008, "protocol error");
      }
    });
  });
  const timer = setInterval(() => {
    for (const socket of ws.clients) {
      const peer = socket.arthegallPeer;
      if (!peer) continue;
      const age = Date.now() - peer.seen;
      if (
        age > 45000 ||
        (!peer.id && Date.now() - peer.created > 300000) ||
        (peer.code && !peer.id && Date.now() > peer.expires)
      )
        socket.terminate();
      else if (age >= 15000 && Date.now() - (peer.lastPing ?? 0) >= 15000) {
        peer.lastPing = Date.now();
        socket.ping();
      }
    }
  }, 1000);
  // The operator API is reachable only through the owning account's Unix socket.
  const socketPath = join(dir, "admin.sock");
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket())
      throw Error("admin socket path is occupied by a file");
    rmSync(socketPath);
  }
  const admin = http.createServer(async (req, res) => {
    try {
      req.setEncoding("utf8");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw Error("request too large");
      }
      const { op, ...a } = JSON.parse(body);
      let result;
      if (op === "pair") {
        const peer = codes.get(a.code);
        if (!peer || peer.expires < Date.now() || peer.socket.readyState !== 1)
          throw Error("unknown or expired code");
        codes.delete(a.code);
        const id = randomUUID();
        const r =
          store.runners.list().find((r) => r.publicKey === peer.publicKey) ??
          store.runners.put(id, {
            id,
            name: peer.name,
            publicKey: peer.publicKey,
            harnesses: [],
          });
        admit(peer, r);
        result = { id: r.id, name: r.name };
      } else if (op === "runners")
        result = store.runners.list().map(({ publicKey, ...r }) => {
          const peer = live.get(r.id);
          return {
            ...r,
            online: !!peer,
            connectionState: peer
              ? peer.ready
                ? "ready"
                : "catching_up"
              : r.compatibilityIssue
                ? "incompatible"
                : "offline",
          };
        });
      else if (op === "sessions")
        result = store.sessions
          .list()
          .map((s) =>
            s.closing && s.state !== "ended"
              ? { ...s, activity: s.state, state: "ending" }
              : s,
          );
      else if (op === "commands")
        result = store.commands
          .list()
          .filter((c) => !a.session || c.session === a.session);
      else if (op === "history") {
        control.session(a.session);
        result = store.history(a.session, a.after ?? 0);
      } else if (op === "submit") {
        const { action, ...args } = a;
        if (!args.commandId) throw Error("submit requires a command ID");
        result = control.action(action, args);
      } else result = control.action(op, a);
      res.end(JSON.stringify(result));
      for (const peer of live.values()) pump(peer);
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  admin.listen(socketPath, () => chmodSync(socketPath, 0o600));
  tls.listen(Number(opt.port ?? 7843), opt.listen ?? "127.0.0.1", () =>
    console.log("Runner listener", tls.address(), "certificate", cert),
  );
  const close = () => {
    clearInterval(timer);
    for (const s of ws.clients) s.terminate();
    tls.close();
    admin.close();
    lock.close();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
