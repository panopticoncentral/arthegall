import { probeHarness } from "./probe.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

function connect(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws+unix://" + path + ":/", {
      maxPayload: 64 * 1024 * 1024,
      handshakeTimeout: 4000,
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

export class CodexHost {
  constructor(dir) {
    this.path = join(dir, "codex.sock");
  }
  async open() {
    try {
      return await connect(this.path);
    } catch (e) {
      if (!["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
    }
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    await this.starting;
    return connect(this.path);
  }
  async start() {
    if (existsSync(this.path)) {
      if (!lstatSync(this.path).isSocket())
        throw Error("Codex socket path is occupied by a file");
      rmSync(this.path);
    }
    const proc = spawn(
      "codex",
      ["app-server", "--listen", "unix://" + this.path],
      { detached: true, stdio: "ignore" },
    );
    let error;
    proc.on("error", (e) => {
      error = e;
    });
    proc.unref();
    for (let i = 0; i < 100; i++) {
      if (error) throw error;
      if (proc.exitCode !== null)
        throw Error("Codex App Server exited during startup");
      if (existsSync(this.path)) return;
      await delay(100);
    }
    throw Error("Codex App Server startup timed out");
  }
}

export class CodexAdapter {
  static probe() {
    return probeHarness(
      "codex",
      ["app-server", "--help"],
      ["unix://", "--listen"],
      "native",
    );
  }
  constructor(ctx, host) {
    this.ctx = ctx;
    this.host = host;
    this.requests = new Map();
    this.approvals = new Map();
  }
  async connect() {
    this.ws = await this.host.open();
    const ws = this.ws;
    ws.on("message", (buf) => {
      try {
        this.message(JSON.parse(buf.toString()));
      } catch (e) {
        console.error("Codex event:", e.message);
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      for (const waiter of this.requests.values())
        waiter.reject(Error("App Server disconnected"));
      this.requests.clear();
      for (const a of this.approvals.values())
        a.fail?.("Connection closed before approval confirmation");
      this.approvals.clear();
      if (!this.closed) this.ctx.lost("Codex App Server connection closed");
    });
    await this.call("initialize", {
      clientInfo: { name: "arthegall", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  call(method, params) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(Error(method + " timed out"));
      }, 60000);
      this.requests.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send({ id, method, params });
      } catch (e) {
        this.requests.get(id).reject(e);
        this.requests.delete(id);
      }
    });
  }
  workspaceParams() {
    const { cwd, additionalDirs } = this.ctx.s;
    return additionalDirs?.length
      ? { cwd, runtimeWorkspaceRoots: [cwd, ...additionalDirs] }
      : {};
  }
  verifyWorkspace(response) {
    if (
      this.ctx.s.additionalDirs?.some(
        (path) => !response.runtimeWorkspaceRoots?.includes(path),
      )
    ) {
      this.close();
      throw Error(
        "Codex did not accept the additional workspace roots. Check the installed Codex version.",
      );
    }
  }
  async create() {
    await this.connect();
    const r = await this.call("thread/start", {
      cwd: this.ctx.s.cwd,
      ...this.workspaceParams(),
      historyMode: "paginated",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    this.verifyWorkspace(r);
    this.ctx.update({ native: r.thread.id, state: "ready" });
  }
  async recover() {
    await this.connect();
    const threadId = this.ctx.s.native;
    if (!threadId) throw Error("native thread ID was not recorded");
    // Subscribe first and buffer live changes until the history snapshot is applied.
    this.buffer = [];
    const r = await this.call("thread/resume", {
      threadId,
      excludeTurns: true,
      ...this.workspaceParams(),
    });
    this.verifyWorkspace(r);
    let cursor = null,
      active = null,
      lastTurn = null;
    const pending = this.ctx.s.input;
    const expected = pending && this.ctx.command(pending);
    let afterAnchor = !this.ctx.s.inputAfter;
    do {
      const page = await this.call("thread/turns/list", {
        threadId,
        cursor,
        sortDirection: "asc",
        itemsView: "full",
      });
      for (const t of page.data) {
        this.turnRecord(t);
        for (const item of t.items) this.recordItem(t.id, item);
        if (afterAnchor && expected) {
          const msg = t.items.find((i) => i.type === "userMessage");
          if (
            msg?.content?.length === 1 &&
            msg.content[0].text === expected.text
          )
            this.ctx.confirm(pending);
          afterAnchor = false;
        }
        if (t.id === this.ctx.s.inputAfter) afterAnchor = true;
        lastTurn = t.id;
        if (t.status === "inProgress") active = t.id;
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.ctx.update({
      turn: active,
      steering: "native",
      lastTurn,
      state: r.thread.status.type === "active" ? "working" : "ready",
      approvals: [],
      detail: null,
    });
    const buffered = this.buffer;
    this.buffer = null;
    for (const m of buffered) this.message(m);
  }
  recordItem(turn, item) {
    this.ctx.activity(item.id, item);
    if (item.type !== "userMessage" || !item.clientId) return;
    const c = this.ctx.command(item.clientId);
    if (c?.type === "steer" && c.session === this.ctx.s.id && c.target === turn)
      this.ctx.confirm(c.id);
  }
  turnRecord(t) {
    this.ctx.activity("turn/" + t.id, {
      type: "turn",
      turn: t.id,
      status: t.status,
      error: t.error ?? null,
    });
  }
  message(m) {
    if (!m.method) {
      const w = this.requests.get(m.id);
      if (!w) return;
      this.requests.delete(m.id);
      if (m.error)
        w.reject(Object.assign(Error(m.error.message), { refused: true }));
      else w.resolve(m.result);
      return;
    }
    if (this.buffer) {
      this.buffer.push(m);
      return;
    }
    const p = m.params ?? {},
      ctx = this.ctx;
    if (p.threadId && ctx.s.native && p.threadId !== ctx.s.native) return;
    if (m.method === "turn/started") {
      this.turnRecord(p.turn);
      if (this.submitting) ctx.confirm(this.submitting);
      ctx.update({
        state: "working",
        steering: "native",
        turn: p.turn.id,
        lastTurn: p.turn.id,
      });
    } else if (m.method === "turn/completed") {
      this.turnRecord(p.turn);
      this.approvals.clear();
      ctx.update({
        state: "ready",
        turn: null,
        approvals: [],
        detail: p.turn.error?.message ?? null,
      });
    } else if (m.method === "item/started" || m.method === "item/completed") {
      this.recordItem(p.turnId, p.item);
    } else if (
      m.method === "item/agentMessage/delta" ||
      m.method === "item/commandExecution/outputDelta"
    ) {
      ctx.delta(p.itemId, p.delta);
    } else if (
      m.id !== undefined &&
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(m.method)
    ) {
      const id = String(p.approvalId ?? p.itemId ?? m.id);
      this.approvals.set(id, { method: m.method, rpc: m.id, params: p });
      ctx.update({
        state: "waiting",
        steering: "native",
        turn: p.turnId,
        approvals: [...this.approvals].map(([id, v]) => ({
          id,
          kind: v.method,
          request: v.params,
        })),
      });
    } else if (m.method === "serverRequest/resolved") {
      for (const [id, v] of this.approvals)
        if (v.rpc === p.requestId) {
          v.confirm?.();
          this.approvals.delete(id);
        }
      const approvals = ctx.s.approvals.filter((p) => this.approvals.has(p.id));
      if (approvals.length !== ctx.s.approvals.length)
        ctx.update({
          approvals,
          state: approvals.length ? "waiting" : "working",
        });
    } else if (m.id !== undefined) {
      this.send({
        id: m.id,
        error: {
          code: -32601,
          message: "Unsupported runner request: " + m.method,
        },
      });
    }
  }
  async input(command) {
    this.submitting = command.id;
    let r;
    try {
      r = await this.call("turn/start", {
        threadId: this.ctx.s.native,
        input: [{ type: "text", text: command.text }],
      });
    } finally {
      this.submitting = null;
    }
    this.ctx.confirm(command.id);
    if (r.turn.status === "inProgress" && this.ctx.s.state === "submitting")
      this.ctx.update({
        state: "working",
        steering: "native",
        turn: r.turn.id,
        lastTurn: r.turn.id,
      });
  }
  async steer(command) {
    try {
      const r = await this.call("turn/steer", {
        threadId: this.ctx.s.native,
        expectedTurnId: command.target,
        clientUserMessageId: command.id,
        input: [{ type: "text", text: command.text }],
      });
      if (r.turnId !== command.target)
        throw Error("App Server did not confirm the target turn");
      this.ctx.confirm(command.id);
    } catch (e) {
      if (!e.refused) e.uncertain = true;
      throw e;
    }
  }
  async approve(id, allow) {
    const a = this.approvals.get(id);
    if (!a) throw Error("approval is no longer pending");
    const result =
      a.method === "item/permissions/requestApproval"
        ? { permissions: allow ? a.params.permissions : {}, scope: "turn" }
        : { decision: allow ? "accept" : "decline" };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => a.fail("Approval confirmation timed out"),
        10000,
      );
      a.confirm = () => {
        clearTimeout(timer);
        resolve();
      };
      a.fail = (message) => {
        clearTimeout(timer);
        reject(Object.assign(Error(message), { uncertain: true }));
      };
      try {
        this.send({ id: a.rpc, result });
      } catch (e) {
        a.fail(e.message);
      }
    });
  }
  async interrupt(turn) {
    await this.call("turn/interrupt", {
      threadId: this.ctx.s.native,
      turnId: turn,
    });
  }
  close() {
    this.closed = true;
    this.ws?.close();
  }
}
