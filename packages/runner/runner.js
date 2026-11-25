import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import WebSocket from "ws";
import { exclusive } from "@arthegall/shared/sqlite";
import { RunnerStore } from "./store.js";
import {
  decodeControlMessage,
  protocolOffer,
  supportsEventParts,
  versionIssue,
  maxMessageBytes,
  proof,
  isPromptCommand,
} from "@arthegall/shared/protocol";
import { replayBatch } from "./replay.js";
import { harnessRegistry } from "./adapters/index.js";

export class Runner {
  constructor(dir) {
    this.lock = exclusive(dir);
    this.store = new RunnerStore(dir);
    this.harnesses = harnessRegistry(dir);
    this.adapters = new Map();
    this.sessions = new Map();
    this.lanes = new Map();
    this.retryTimers = new Map();
  }
  record(type, fields) {
    this.store.append({
      type,
      ...fields,
      time: new Date().toISOString(),
    });
    queueMicrotask(() => this.flush());
  }
  update(s, patch) {
    Object.assign(s, patch);
    if (!["working", "waiting", "submitting"].includes(s.state))
      s.steering = "unavailable";
    this.store.transaction(() => {
      this.store.sessions.put(s.id, s);
      this.record("session", {
        session: s.id,
        state: s.state,
        steering: s.steering,
        turn: s.turn,
        approvals: s.approvals,
        detail: s.detail,
      });
    });
    if (s.closing && s.state === "ready")
      queueMicrotask(() =>
        this.lane(s.id, () => {
          if (s.closing && s.state === "ready") this.finish(s);
        }),
      );
  }
  receipt(c, status, detail) {
    this.store.transaction(() => {
      this.store.receipts.put(c.id, { ...c, status, detail });
      const session = this.sessions.get(c.session);
      if (
        c.type === "end" &&
        session?.closing === c.id &&
        ["failed", "uncertain"].includes(status)
      ) {
        session.closing = null;
        this.store.sessions.put(session.id, session);
      }
      if (status === "delivered" && session?.input === c.id) {
        session.input = null;
        this.store.sessions.put(session.id, session);
      }
      this.record("receipt", {
        session: c.session,
        command: c.id,
        ...(c.type === "steer"
          ? { commandType: "steer", target: c.target, text: c.text }
          : {}),
        status,
        detail,
      });
    });
  }
  context(s) {
    const done = (id, status, detail) => {
      const c = this.store.receipts.get(id);
      if (!c || !["processing", "uncertain"].includes(c.status)) return;
      this.receipt(c, status, detail);
    };
    return {
      s,
      command: (id) => this.store.receipts.get(id),
      update: (p) => this.update(s, p),
      confirm: (id) => done(id, "delivered"),
      fail: (id, why) => done(id, "failed", why),
      uncertain: (id, why) => done(id, "uncertain", why),
      delta: (item, text) =>
        this.record("delta", { session: s.id, item, text }),
      activity: (id, value) => {
        if (!id) return;
        const key = s.id + "/" + id;
        if (JSON.stringify(this.store.items.get(key)) === JSON.stringify(value))
          return;
        this.store.transaction(() => {
          this.store.items.put(key, value);
          this.record("item", { session: s.id, item: id, value });
        });
      },
      lost: (why) => {
        if (!["ended", "failed"].includes(s.state)) {
          this.update(s, { state: "recovering", approvals: [], detail: why });
          this.retry(s);
        }
      },
      retry: () => this.retry(s),
    };
  }
  retry(s) {
    if (this.retryTimers.has(s.id)) return;
    this.retryTimers.set(
      s.id,
      setTimeout(() => {
        this.retryTimers.delete(s.id);
        this.lane(s.id, () => this.recover(s));
      }, 1500),
    );
  }
  lane(id, fn) {
    const p = (this.lanes.get(id) ?? Promise.resolve())
      .then(fn)
      .catch((e) => console.error("session:", e.message));
    this.lanes.set(id, p);
    return p.finally(() => {
      if (this.lanes.get(id) === p) this.lanes.delete(id);
    });
  }
  adapter(s) {
    const harness = this.harnesses.get(s.harness);
    if (!harness) throw Error("Unsupported harness: " + s.harness);
    const a = harness.create(this.context(s));
    this.adapters.set(s.id, a);
    return a;
  }
  async recover(s) {
    if (["failed", "ended"].includes(s.state)) return;
    if (!s.native) {
      this.update(s, {
        state: s.closing ? "ready" : "new",
        detail: "Launch interrupted before first-prompt submission",
      });
      return;
    }
    this.adapters.get(s.id)?.close();
    try {
      const a = this.adapter(s);
      await a.recover();
      if (s.closing && s.turn && ["working", "waiting"].includes(s.state)) {
        const end = this.store.receipts.get(s.closing);
        try {
          await a.interrupt(s.turn);
        } catch (error) {
          this.receipt(
            end,
            error.uncertain ? "uncertain" : "failed",
            error.message,
          );
        }
      }
    } catch (e) {
      this.update(s, { state: "recovering", detail: e.message });
      this.retry(s);
    }
  }
  finish(s) {
    if (s.state === "ended") return;
    this.adapters.get(s.id)?.close();
    this.adapters.delete(s.id);
    this.update(s, { state: "ended", turn: null, approvals: [] });
    if (s.closing) {
      const c = this.store.receipts.get(s.closing);
      if (c) this.receipt(c, "delivered");
    }
  }
  async handle(c) {
    let s = this.sessions.get(c.session);
    const known = this.store.receipts.get(c.id);
    if (known && known.status !== "queued") {
      if (known.status !== "processing")
        this.receipt(known, known.status, known.detail);
      return;
    }
    if (!s) {
      if (c.type !== "launch" && c.type !== "end" && c.type !== "cancel") {
        this.receipt(c, "failed", "Unknown local session");
        return;
      }
      s = {
        id: c.session,
        harness: c.harness,
        cwd: c.cwd,
        additionalDirs: c.additionalDirs ?? [],
        settings: c.settings,
        agent: c.agent,
        state: "new",
        approvals: [],
        turn: null,
      };
      this.sessions.set(s.id, s);
    }
    this.store.receipts.put(c.id, { ...c, status: "processing" });
    let submitted = false;
    try {
      if (c.type === "end") {
        if (s.state === "ended") {
          this.receipt(c, "delivered", "Session already ended");
          return;
        }
        this.update(s, { closing: c.id });
        if (["working", "waiting"].includes(s.state) && s.turn) {
          await this.adapters.get(s.id).interrupt(s.turn);
        } else if (!["observing", "recovering"].includes(s.state))
          this.finish(s);
        return;
      }
      if (c.type === "cancel") {
        const original = this.store.receipts.get(c.target);
        if (original && !["queued", "canceled"].includes(original.status))
          throw Error("delivery already " + original.status);
        this.receipt(
          original ?? { id: c.target, session: c.session, type: c.targetType },
          "canceled",
        );
        if (c.targetType === "launch") this.finish(s);
      } else if (c.type === "approval") {
        if (!s.approvals.some((x) => x.id === c.target))
          throw Error("approval is no longer pending");
        await this.adapters.get(s.id).approve(c.target, c.allow);
      } else if (c.type === "steer") {
        if (s.closing || !c.target || s.turn !== c.target)
          throw Error("Target turn is no longer active");
        if (!["working", "waiting"].includes(s.state))
          throw Error("Turn cannot currently be steered");
        await this.adapters.get(s.id).steer(c);
        return;
      } else if (c.type === "stop") {
        if (s.turn !== c.target || !s.turn) {
          this.receipt(c, "delivered", "Turn already ended");
          return;
        }
        await this.adapters.get(s.id).interrupt(c.target);
      } else if (isPromptCommand(c.type)) {
        if (s.closing || s.state === "ended") throw Error("session has ended");
        if (c.type === "launch" && !s.native) {
          const installed = this.store.settings
            .get("inventory")
            ?.find((h) => h.name === c.harness);
          if (installed?.status === "unavailable")
            throw Error(installed.detail);
          for (const path of [s.cwd, ...(s.additionalDirs ?? [])]) {
            if (!statSync(path).isDirectory())
              throw Error("expected a directory: " + path);
          }
          this.update(s, { state: "starting" });
          await this.adapter(s).create();
        }
        if (s.state !== "ready") {
          this.receipt(c, "queued");
          return;
        }
        this.update(s, {
          input: c.id,
          inputAfter: s.lastTurn ?? null,
          state: "submitting",
        });
        submitted = true;
        await this.adapters.get(s.id).input(c);
        return;
      } else throw Error("unknown command type");
      this.receipt(c, "delivered");
    } catch (e) {
      if (
        (submitted || c.type === "steer") &&
        this.store.receipts.get(c.id)?.status === "delivered"
      )
        return;
      if (submitted && e.refused) {
        this.receipt(c, "failed", e.message);
        this.update(s, { input: null, state: "ready", detail: e.message });
        return;
      }
      this.receipt(
        c,
        submitted || e.uncertain ? "uncertain" : "failed",
        e.message,
      );
      if (c.type === "launch" && !submitted)
        this.update(s, { state: "failed", detail: e.message });
      if (submitted) {
        this.update(s, { state: "recovering", detail: e.message });
        this.retry(s);
      }
    }
  }
  boot() {
    for (const s of this.store.sessions.list()) {
      this.sessions.set(s.id, s);
      // Older runners retained the close intent after an interrupt failed.
      if (
        s.closing &&
        s.state !== "ended" &&
        ["failed", "uncertain"].includes(
          this.store.receipts.get(s.closing)?.status,
        )
      ) {
        s.closing = null;
        this.store.sessions.put(s.id, s);
      }
      if (s.state === "ended" && s.closing) {
        const c = this.store.receipts.get(s.closing);
        if (c && c.status !== "delivered") this.receipt(c, "delivered");
      }
      if (!["ended", "failed"].includes(s.state)) {
        this.update(s, { state: "recovering", approvals: [] });
        this.lane(s.id, () => this.recover(s));
      }
    }
    for (const c of this.store.receipts
      .list()
      .filter((c) => c.status === "processing")) {
      if (c.type === "end" && this.sessions.get(c.session)?.closing === c.id)
        continue;
      if (
        c.type === "end" ||
        (isPromptCommand(c.type) &&
          this.sessions.get(c.session)?.input !== c.id)
      ) {
        this.receipt(c, "queued");
        continue;
      }
      this.receipt(
        c,
        "uncertain",
        "Runner restarted before recording the outcome",
      );
    }
  }
  async inventory() {
    const harnesses = await Promise.all(
      Array.from(this.harnesses.values(), (harness) => harness.probe()),
    );
    if (
      JSON.stringify(harnesses) !==
      JSON.stringify(this.store.settings.get("inventory"))
    ) {
      this.store.transaction(() => {
        this.store.settings.put("inventory", harnesses);
        this.record("inventory", { harnesses });
      });
    }
  }
  flush() {
    if (
      !this.online ||
      this.inflight ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    const batch = replayBatch(
      this.store.journalAfter(this.cursor, 8),
      this.replayLimit,
    );
    if (batch) {
      if (batch.body && !this.eventParts) {
        this.online = false;
        this.socket.close(
          4002,
          "Update the control plane to replay this oversized event.",
        );
        return;
      }
      this.inflight = batch.lastSeq;
      this.remainingEvent = batch.body;
      this.socket.send(batch.message);
    } else if (!this.ready) {
      this.ready = true;
      this.send({
        op: "ready",
        harnesses: this.store.settings.get("inventory"),
      });
    }
  }
  send(m) {
    this.socket.send(JSON.stringify(m));
  }
  connect(config) {
    let backoff = 500;
    const open = () => {
      const ws = new WebSocket(config.url, {
        ca: config.ca,
        handshakeTimeout: 10000,
        maxPayload: maxMessageBytes,
      });
      this.socket = ws;
      let phase = "challenge";
      let lastInbound = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastInbound > 48000) ws.terminate();
      }, 1000);
      ws.on("ping", () => {
        lastInbound = Date.now();
      });
      ws.on("error", (e) => console.error("connection:", e.message));
      ws.on("close", (code, reason) => {
        if (code === 4002) {
          console.error("Runner incompatible:", reason.toString());
          backoff = 30000;
        }
        clearInterval(watchdog);
        this.online = false;
        this.ready = false;
        this.inflight = false;
        this.remainingEvent = null;
        setTimeout(open, backoff + (Math.random() * backoff) / 4);
        backoff = Math.min(15000, backoff * 2);
      });
      ws.on("message", (buf) => {
        try {
          if (ws.readyState !== WebSocket.OPEN) return;
          lastInbound = Date.now();
          const m = decodeControlMessage(buf);
          if (phase === "challenge" && m.op !== "challenge")
            throw Error("expected challenge");
          if (phase === "identity" && !["pair", "welcome"].includes(m.op))
            throw Error("expected pairing or welcome");
          if (phase === "pair" && m.op !== "welcome")
            throw Error("expected welcome");
          if (m.op === "challenge") {
            if (phase !== "challenge") throw Error("unexpected challenge");
            phase = "identity";
            this.send({
              op: "identify",
              ...protocolOffer,
              name: config.name,
              runner: config.runner,
              publicKey: config.publicKey,
              signature: sign(null, proof(m.nonce), config.privateKey).toString(
                "base64",
              ),
            });
            const issue = versionIssue(m.protocolVersion, "control plane");
            if (issue) ws.close(4002, issue);
          } else if (m.op === "pair") {
            if (phase !== "identity") throw Error("unexpected pairing request");
            phase = "pair";
            console.log("Pairing code:", m.code);
          } else if (m.op === "welcome") {
            if (phase !== "pair" && phase !== "identity")
              throw Error("unexpected welcome");
            phase = "connected";
            if (config.runner && config.runner !== m.runner)
              throw Error("runner identity changed");
            if (m.seq > this.store.sequence())
              throw Error("runner event history is missing");
            const issue = versionIssue(m.protocolVersion, "control plane");
            if (issue) {
              ws.close(4002, issue);
              return;
            }
            config.runner = m.runner;
            this.store.settings.put("identity", config);
            this.eventParts = supportsEventParts(m);
            this.replayLimit = this.eventParts
              ? m.replayPartBytes
              : maxMessageBytes;
            this.cursor = m.seq;
            this.inflight = false;
            this.online = true;
            backoff = 500;
            console.log("Connected as", m.runner);
            this.flush();
          } else if (m.op === "eventContinue") {
            if (!this.remainingEvent?.length)
              throw Error("unexpected event continuation");
            const part = this.remainingEvent.subarray(0, this.replayLimit);
            ws.send(part);
            this.remainingEvent = this.remainingEvent.subarray(part.length);
            if (!this.remainingEvent.length) this.remainingEvent = null;
          } else if (m.op === "ack") {
            if (
              !this.online ||
              m.seq !== this.inflight ||
              this.remainingEvent?.length
            )
              throw Error("unexpected replay acknowledgment");
            this.cursor = m.seq;
            this.inflight = false;
            this.flush();
          } else if (m.op === "inspect") {
            if (!this.ready) throw Error("unexpected inspection before replay");
            const outcomes = m.ids.map((id) => {
              const c = this.store.receipts.get(id);
              return { id, status: c?.status ?? "missing", detail: c?.detail };
            });
            this.send({ op: "inspected", outcomes });
          } else if (m.op === "command") {
            if (
              !this.online ||
              !this.ready ||
              m.command.runner !== config.runner
            )
              throw Error("unexpected runner command");
            this.lane(m.command.session, () => this.handle(m.command));
          }
        } catch (e) {
          console.error("runner protocol:", e.message);
          ws.terminate();
        }
      });
    };
    open();
  }
}
export async function run(dir, opt) {
  const r = new Runner(dir);
  let config = r.store.settings.get("identity");
  if (!config) {
    if (!opt.url || new URL(opt.url).protocol !== "wss:")
      throw Error("first run requires --url wss://host:port/runner");
    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    config = {
      ...keys,
      name: opt.name ?? hostname(),
      url: opt.url,
      ca: opt.ca ? readFileSync(opt.ca, "utf8") : undefined,
    };
    r.store.settings.put("identity", config);
  } else if (opt.url && config.url !== opt.url)
    throw Error("state directory belongs to another control plane");
  r.boot();
  await r.inventory();
  setInterval(() => r.inventory().catch(console.error), 30000);
  r.connect(config);
}
