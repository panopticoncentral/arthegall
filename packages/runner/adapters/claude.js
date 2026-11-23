import { probeHarness } from "./probe.js";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const steeringHooks = Object.fromEntries(
  ["PostToolUse", "PostToolUseFailure", "Stop"].map((event) => [
    event,
    [{ hookCallbackIds: ["arthegall-" + event] }],
  ]),
);

function transcript(id) {
  const root = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "projects",
  );
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(root, entry.name, id + ".jsonl");
    if (existsSync(p)) return p;
  }
}
function processIdentity(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    if (e.status === 1) return "";
    throw e;
  }
}
export class ClaudeAdapter {
  static probe() {
    return probeHarness(
      "claude",
      ["--help"],
      ["--replay-user-messages", "--input-format", "--permission-prompts"],
      "callback",
    );
  }
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map();
    this.steers = [];
    this.hookDeliveries = new Map();
  }
  async create() {
    this.ctx.update({ native: randomUUID(), state: "ready" });
  }
  async recover() {
    const { ctx } = this,
      s = ctx.s;
    if (!s.native) throw Error("missing Claude session ID");
    const checkUnrecordedWorker = !s.pid && !!s.input;
    let pid = s.pid;
    // A crash can occur after spawn but before the PID reaches the journal.
    if (!pid && checkUnrecordedWorker) {
      const rows = execFileSync("ps", ["-axo", "pid=,command="], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      const line = rows
        .split("\n")
        .find(
          (row) =>
            row.includes(" --input-format stream-json ") &&
            (row.includes("--session-id " + s.native) ||
              row.includes("--resume " + s.native)),
        );
      if (line) pid = Number(line.trim().split(/\s+/)[0]);
    }
    const identity = pid ? processIdentity(pid) : "";
    const live =
      identity &&
      (identity === s.processIdentity || identity.includes(s.native));
    const file = transcript(s.native);
    if (file) {
      const lines = createInterface({
        input: createReadStream(file),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          m.sessionId === s.native &&
          !m.isSidechain &&
          !m.isMeta &&
          m.uuid &&
          ["assistant", "user"].includes(m.type)
        )
          this.record(m);
      }
    }
    if (live) {
      ctx.update({
        pid,
        state: "observing",
        approvals: [],
        detail: "Waiting for the previous Claude worker to exit",
      });
      this.watch = setTimeout(() => ctx.retry(), 2000);
      return;
    }
    ctx.update({
      state: "ready",
      turn: null,
      approvals: [],
      pid: null,
      processIdentity: null,
      detail: null,
      hasHistory: s.hasHistory || !!file,
    });
  }
  record(m) {
    const id = m.uuid ?? m.message?.id;
    if (!id || !m.message) return;
    this.ctx.activity(id, { type: m.type, content: m.message.content });
    if (m.type === "user" && id === this.ctx.s.input) this.ctx.confirm(id);
  }
  async input(c) {
    const { ctx } = this,
      s = ctx.s;
    const args = [
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--replay-user-messages",
      "--permission-prompts",
      "host",
      "--permission-prompt-tool",
      "stdio",
      s.hasHistory ? "--resume" : "--session-id",
      s.native,
    ];
    if (s.additionalDirs?.length) args.push("--add-dir", ...s.additionalDirs);
    const child = spawn("claude", args, {
      cwd: s.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    this.result = false;
    this.interrupting = false;
    this.stderr = "";
    this.turn = c.id;
    this.initRequest = randomUUID();
    this.hooksAvailable = undefined;
    child.stderr.on("data", (data) => {
      this.stderr = (this.stderr + data).slice(-1500);
    });
    child.stdin.on("error", () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        this.message(JSON.parse(line));
      } catch (e) {
        console.error("Claude event:", e.message);
      }
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (e) => reject(Object.assign(e, { refused: true })));
    });
    ctx.update({
      pid: child.pid,
      processIdentity: processIdentity(child.pid),
      steering: this.hooksAvailable === false ? "unavailable" : "callback",
      state: "working",
      turn: c.id,
    });
    child.once("close", (code) => {
      this.loseInterrupt();
      this.finishSteering();
      this.child = null;
      this.pending.clear();
      if (!this.result && ctx.s.input)
        ctx.uncertain(ctx.s.input, "Claude exited before acknowledging input");
      ctx.update({
        state: "ready",
        pid: null,
        processIdentity: null,
        turn: null,
        approvals: [],
        hasHistory: s.hasHistory || this.result || !!transcript(s.native),
        detail: this.result
          ? ctx.s.detail
          : "Claude exited (" + code + "): " + this.stderr,
      });
    });
    await this.send({
      type: "control_request",
      request_id: this.initRequest,
      request: { subtype: "initialize", hooks: steeringHooks },
    });
    await this.send({
      type: "user",
      uuid: c.id,
      session_id: s.native,
      parent_tool_use_id: null,
      message: { role: "user", content: c.text },
    });
  }
  send(msg) {
    if (!this.child?.stdin.writable)
      throw Error("Claude input stream is unavailable");
    return new Promise((resolve, reject) =>
      this.child.stdin.write(JSON.stringify(msg) + "\n", (e) => {
        if (e) reject(Object.assign(e, { uncertain: true }));
        else resolve();
      }),
    );
  }
  steer(command) {
    if (
      !this.child ||
      this.result ||
      this.interrupting ||
      this.turn !== command.target
    )
      throw Error("Target Claude turn is no longer controllable");
    if (this.hooksAvailable === false)
      throw Error("Claude declined the steering hooks");
    this.steers.push(command);
  }
  expireSteers(reason) {
    for (const c of this.steers.splice(0)) this.ctx.fail(c.id, reason);
  }
  finishSteering() {
    this.expireSteers("Turn ended before steering was delivered");
    for (const batch of this.hookDeliveries.values())
      for (const c of batch)
        this.ctx.uncertain(c.id, "Claude exited before confirming steering");
    this.hookDeliveries.clear();
  }
  async answerHook(m) {
    const { callback_id, input } = m.request;
    const event = input?.hook_event_name;
    const sameTurn =
      this.turn === this.ctx.s.turn &&
      !this.ctx.s.closing &&
      !this.result &&
      input?.session_id === this.ctx.s.native &&
      !input.agent_id &&
      Object.hasOwn(steeringHooks, event) &&
      callback_id === "arthegall-" + event;
    const batch = sameTurn ? this.steers.splice(0) : [];
    let response = {};
    if (batch.length) {
      const instruction =
        "The user sent the following instructions for your current turn:\n" +
        batch.map((c) => c.text).join("\n\n");
      response =
        event === "Stop"
          ? { decision: "block", reason: instruction }
          : {
              hookSpecificOutput: {
                hookEventName: event,
                additionalContext: instruction,
              },
            };
      this.hookDeliveries.set(m.request_id, batch);
    }
    try {
      await this.send({
        type: "control_response",
        response: { subtype: "success", request_id: m.request_id, response },
      });
    } catch (e) {
      this.hookDeliveries.delete(m.request_id);
      for (const c of batch) this.ctx.uncertain(c.id, e.message);
    }
  }
  message(m) {
    const ctx = this.ctx;
    if (m.type === "assistant" || m.type === "user") {
      this.record(m);
      if (m.type === "assistant" && ctx.s.input) ctx.confirm(ctx.s.input);
    } else if (m.type === "control_response") {
      const r = m.response;
      if (this.interruptRequest && r.request_id === this.interruptRequest.id) {
        if (r.subtype === "success") this.interruptRequest.resolve();
        else
          this.interruptRequest.reject(
            Error(r.error ?? "Claude rejected the interrupt"),
          );
        return;
      }
      if (r.request_id === this.initRequest) {
        this.hooksAvailable = r.subtype === "success";
        ctx.update({
          steering: this.hooksAvailable ? "callback" : "unavailable",
        });
        if (!this.hooksAvailable)
          this.expireSteers("Claude declined the steering hooks");
      }
      const batch = this.hookDeliveries.get(r.request_id);
      if (batch) {
        this.hookDeliveries.delete(r.request_id);
        for (const c of batch) {
          if (r.subtype === "success") ctx.confirm(c.id);
          else
            ctx.fail(c.id, r.error ?? "Claude rejected the steering response");
        }
      }
    } else if (m.type === "control_request") {
      if (m.request?.subtype === "hook_callback") {
        void this.answerHook(m);
        return;
      }
      if (m.request?.subtype !== "can_use_tool") {
        this.send({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: m.request_id,
            error: "Unsupported request",
          },
        }).catch((e) => console.error("Claude response:", e.message));
        return;
      }
      this.pending.set(m.request_id, m.request);
      ctx.update({
        state: "waiting",
        approvals: [...this.pending].map(([id, request]) => ({ id, request })),
      });
    } else if (m.type === "result") {
      this.result = true;
      this.expireSteers("Turn ended before steering was delivered");
      if (ctx.s.input) {
        if (m.is_error)
          ctx.uncertain(
            ctx.s.input,
            "Claude returned an error before acknowledging input",
          );
        else ctx.confirm(ctx.s.input);
      }
      ctx.activity(m.uuid ?? this.turn + "/result", {
        type: "result",
        text: m.result,
        errors: m.errors,
        status: m.subtype,
      });
      ctx.update({ detail: m.is_error ? (m.result ?? m.subtype) : null });
      this.child.stdin.end();
    }
  }
  async approve(id, allow) {
    const r = this.pending.get(id);
    if (!r) throw Error("approval is no longer pending");
    await this.send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: id,
        response: allow
          ? { behavior: "allow", updatedInput: r.input }
          : { behavior: "deny", message: "Denied by operator" },
      },
    });
    this.pending.delete(id);
    this.ctx.update({
      state: this.pending.size ? "waiting" : "working",
      approvals: this.ctx.s.approvals.filter((x) => x.id !== id),
    });
  }
  async interrupt() {
    if (!this.child)
      throw Error(
        "previous Claude worker is still running without a controller",
      );
    const request = { id: randomUUID(), ...Promise.withResolvers() };
    this.interruptRequest = request;
    this.interrupting = true;
    const timer = setTimeout(
      () => this.loseInterrupt("Interrupt confirmation timed out"),
      10000,
    );
    try {
      this.send({
        type: "control_request",
        request_id: request.id,
        request: { subtype: "interrupt" },
      }).catch(request.reject);
      await request.promise;
      this.expireSteers("Turn interrupted before steering was delivered");
    } catch (error) {
      this.interrupting = false;
      throw error;
    } finally {
      clearTimeout(timer);
      this.interruptRequest = null;
    }
  }
  loseInterrupt(
    message = "Claude connection closed before interrupt confirmation",
  ) {
    this.interruptRequest?.reject(
      Object.assign(Error(message), { uncertain: true }),
    );
  }
  close() {
    this.loseInterrupt();
    clearTimeout(this.watch);
    this.child?.stdin.end();
  }
}
