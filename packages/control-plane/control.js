import { randomUUID, createHash } from "node:crypto";
import { Scheduler } from "./scheduler.js";
import { isPromptCommand } from "@arthegall/shared/protocol";

const open = new Set(["queued", "dispatching", "uncertain"]);
const requireValue = (value, message) => {
  if (!value) throw Object.assign(Error(message), { code: "INVALID_ACTION" });
  return value;
};

export class Control {
  constructor(store) {
    this.store = store;
    this.scheduler = new Scheduler(this);
  }
  session(id) {
    return requireValue(this.store.sessions.get(id), "unknown session");
  }
  command(id) {
    return requireValue(this.store.commands.get(id), "unknown command");
  }
  add(session, type, data = {}, id = randomUUID()) {
    const c = {
      id,
      session: session.id,
      runner: session.runner,
      type,
      ...data,
      status: "queued",
    };
    return this.store.commands.put(c.id, c);
  }
  action(op, { commandId, ...args }) {
    return this.store.transaction(() => {
      if (commandId === undefined) return this.apply(op, args);
      if (
        typeof commandId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          commandId,
        )
      )
        throw Error("command ID must be a UUID v4");
      commandId = commandId.toLowerCase();
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            op,
            Object.entries(args).sort(([a], [b]) => a.localeCompare(b)),
          ]),
        )
        .digest("hex");
      const receipt = this.store.requests.get(commandId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw Error("command ID already used for different input");
        return receipt.result;
      }
      if (this.store.commands.get(commandId))
        throw Error("command ID already exists");
      const result = this.apply(op, args, commandId);
      this.store.requests.put(commandId, { fingerprint, result });
      return result;
    });
  }
  openSession(id) {
    const s = this.session(id);
    requireValue(
      !s.closing && !["ended", "failed"].includes(s.state),
      "session is closed",
    );
    return s;
  }
  launchProject(a) {
    let project;
    if (a.project !== undefined) {
      project = requireValue(
        this.store.projects.get(a.project),
        "unknown project",
      );
    } else {
      requireValue(this.store.runners.get(a.runner), "unknown runner");
      project = this.store.projects.forDirectory(a.runner, a.cwd);
    }
    requireValue(!project.archived, "project is archived");
    const runner = requireValue(
      this.store.runners.get(project.runner),
      "unknown runner",
    );
    requireValue(
      runner.harnesses?.some((h) => h.name === a.harness),
      "runner has not advertised this harness",
    );
    requireValue(typeof a.text === "string" && a.text.trim(), "empty prompt");
    return project;
  }
  apply(op, a, commandId) {
    const projects = this.store.projects;
    if (op === "project-add") {
      requireValue(this.store.runners.get(a.runner), "unknown runner");
      return projects.define({
        runner: a.runner,
        name: a.name,
        cwd: a.cwd,
        additionalDirs: a.additionalDirs,
      });
    }
    if (op === "project-edit" || op === "project-archive") {
      const p = projects.require(a.id);
      if (op === "project-archive")
        return projects.put(p.id, { ...p, archived: true });
      requireValue(!p.archived, "project is archived");
      return projects.define({
        id: p.id,
        runner: p.runner,
        name: a.name,
        cwd: a.cwd,
        additionalDirs: a.additionalDirs,
      });
    }
    if (op === "schedule-create") return this.scheduler.create(a);
    if (op === "schedule-edit") return this.scheduler.edit(a);
    if (op === "schedule-cancel") return this.scheduler.cancel(a.id);
    if (op === "launch") {
      const project = this.launchProject(a);
      const s = {
        id: randomUUID(),
        project: project.id,
        runner: project.runner,
        harness: a.harness,
        cwd: project.cwd,
        additionalDirs: project.additionalDirs,
        state: "new",
        closing: false,
      };
      this.store.sessions.put(s.id, s);
      return this.add(
        s,
        "launch",
        {
          text: a.text,
          project: s.project,
          cwd: s.cwd,
          additionalDirs: s.additionalDirs,
          harness: a.harness,
        },
        commandId,
      );
    }
    if (op === "cancel") {
      const c = this.command(a.id),
        s = this.session(c.session);
      requireValue(
        isPromptCommand(c.type),
        "only prompts and launches can be canceled",
      );
      if (c.status === "queued") {
        this.cancelLocal(c);
        return c;
      }
      if (c.status === "canceled") return c;
      requireValue(
        ["dispatching", "uncertain"].includes(c.status),
        "command already " + c.status,
      );
      return this.add(
        s,
        "cancel",
        { target: c.id, targetType: c.type },
        commandId,
      );
    }
    const s =
      op === "end" ? this.session(a.session) : this.openSession(a.session);
    if (op === "end") {
      this.scheduler.closeSession(s.id);
      if (s.state === "ended") return s;
      if (s.closing) {
        // Earlier databases stored a boolean without the end command ID.
        const active = s.endCommand
          ? this.command(s.endCommand)
          : this.store.commands
              .list()
              .findLast((c) => c.session === s.id && c.type === "end");
        if (active && !["failed", "uncertain"].includes(active.status))
          return s;
      }
      for (const c of this.store.commands
        .list()
        .filter((c) => c.session === s.id && c.status === "queued"))
        this.cancelLocal(c, false);
      const end = this.add(s, "end", {}, commandId);
      Object.assign(s, { closing: true, endCommand: end.id, endError: null });
      this.store.sessions.put(s.id, s);
      return end;
    }
    if (op === "send") {
      requireValue(a.text?.trim(), "empty prompt");
      return this.add(s, "prompt", { text: a.text }, commandId);
    }
    if (op === "steer") {
      requireValue(
        typeof a.text === "string" && a.text.trim(),
        "empty steering instruction",
      );
      requireValue(
        a.turn && s.turn === a.turn,
        "target turn is no longer active",
      );
      requireValue(
        ["working", "waiting", "recovering"].includes(s.state),
        "turn cannot currently be steered",
      );
      requireValue(
        s.steering !== "unavailable" || s.state === "recovering",
        "Steering unavailable for this turn",
      );
      return this.add(s, "steer", { target: a.turn, text: a.text }, commandId);
    }
    if (op === "stop") {
      requireValue(a.turn, "supply the turn ID to stop");
      return this.add(s, "stop", { target: a.turn }, commandId);
    }
    if (op === "approve" || op === "deny") {
      requireValue(
        a.request && s.approvals?.some((p) => p.id === a.request),
        "approval is no longer pending",
      );
      return this.add(
        s,
        "approval",
        {
          target: a.request,
          allow: op === "approve",
        },
        commandId,
      );
    }
    throw Error("unknown operation");
  }
  cancelLocal(c, close = true) {
    c.status = "canceled";
    this.scheduler.receipt(c, "canceled");
    this.store.commands.put(c.id, c);
    if (close && c.type === "launch") {
      const s = this.session(c.session);
      s.state = "ended";
      this.scheduler.closeSession(s.id);
      this.store.sessions.put(s.id, s);
      for (const next of this.store.commands
        .list()
        .filter((x) => x.session === s.id && x.status === "queued"))
        this.cancelLocal(next, false);
    }
  }
  ingest(runner, { seq, event: e }) {
    const session = e.session && this.session(e.session);
    if (session && session.runner !== runner) throw Error("foreign session");
    this.store.append(runner, seq, e);
    if (e.type === "session" || e.type === "item")
      this.scheduler.observe(session, e);
    if (e.type === "session") {
      const s = session;
      Object.assign(s, {
        state: e.state,
        steering: e.steering,
        turn: e.turn,
        approvals: e.approvals,
        detail: e.detail,
      });
      this.store.sessions.put(s.id, s);
      if (["failed", "ended"].includes(s.state)) {
        this.scheduler.closeSession(s.id);
        for (const c of this.store.commands
          .list()
          .filter(
            (c) =>
              c.session === s.id &&
              c.status === "queued" &&
              isPromptCommand(c.type),
          ))
          this.cancelLocal(c, false);
      }
    } else if (e.type === "receipt") {
      const c = this.command(e.command);
      if (c.runner !== runner || c.session !== e.session)
        throw Error("foreign command");
      this.outcome(c, e.status, e.detail);
    } else if (e.type === "inventory") {
      const r = this.store.runners.get(runner);
      r.harnesses = e.harnesses;
      this.store.runners.put(runner, r);
    }
  }
  outcome(c, status, detail) {
    this.scheduler.receipt(c, status, detail);
    const updated = this.store.commands.put(c.id, { ...c, status, detail });
    if (status === "queued") this.scheduler.requeued(updated);
    if (c.type === "end" && ["failed", "uncertain"].includes(status)) {
      const s = this.session(c.session);
      if (s.closing && (!s.endCommand || s.endCommand === c.id)) {
        s.closing = false;
        s.endError = detail ?? status;
        this.store.sessions.put(s.id, s);
      }
    }
  }
  unresolved(runner) {
    return this.store.commands
      .list()
      .filter(
        (c) =>
          c.runner === runner &&
          ["dispatching", "uncertain"].includes(c.status),
      );
  }
  reconcile(runner, outcomes, sent) {
    this.store.transaction(() => {
      for (const outcome of outcomes) {
        const c = this.command(outcome.id);
        if (c.runner !== runner) throw Error("foreign command");
        if (!["dispatching", "uncertain"].includes(c.status)) continue;
        if (outcome.status === "processing") {
          sent.add(c.id);
          continue;
        }
        if (outcome.status === "missing" || outcome.status === "queued") {
          if (c.status === "uncertain") continue;
          const s = this.session(c.session);
          if (
            (isPromptCommand(c.type) || c.type === "steer") &&
            (s.closing || s.state === "ended")
          )
            this.cancelLocal(c, false);
          else {
            this.outcome(c, "queued");
          }
        } else if (
          ["delivered", "failed", "canceled", "uncertain"].includes(
            outcome.status,
          )
        ) {
          this.outcome(c, outcome.status, outcome.detail);
        } else throw Error("invalid delivery report");
      }
    });
  }
  dispatch(runner, sent, supportsProjectPaths = true) {
    const cmds = this.store.commands
      .list()
      .filter((c) => c.runner === runner && open.has(c.status));
    const result = [];
    for (const s of this.store.sessions
      .list()
      .filter((s) => s.runner === runner)) {
      const group = cmds.filter((c) => c.session === s.id);
      const c =
        group.find((c) => c.type === "end" && c.status !== "uncertain") ??
        group.find(
          (c) =>
            !isPromptCommand(c.type) &&
            c.type !== "steer" &&
            c.status !== "uncertain",
        ) ??
        group.find(
          (c) =>
            c.type === "steer" && !sent.has(c.id) && c.status !== "uncertain",
        ) ??
        group.find((c) => isPromptCommand(c.type));
      if (!c || sent.has(c.id) || c.status === "uncertain") continue;
      if (isPromptCommand(c.type)) {
        if (s.closing || s.state === "ended" || s.state === "failed") continue;
        if (
          c.status === "queued" &&
          !(c.type === "launch"
            ? ["new", "ready"].includes(s.state)
            : s.state === "ready")
        )
          continue;
      }
      if (
        !supportsProjectPaths &&
        s.additionalDirs?.length &&
        (isPromptCommand(c.type) || c.type === "steer")
      ) {
        const detail =
          "Update the runner to send input to sessions with additional project paths";
        if (c.detail !== detail)
          this.store.commands.put(c.id, { ...c, detail });
        continue;
      }
      if (c.status === "queued") {
        this.store.transaction(() => {
          delete c.detail;
          c.status = "dispatching";
          this.store.commands.put(c.id, c);
          if (isPromptCommand(c.type)) {
            const scheduled = this.scheduler.setStatus(c.id, "dispatching");
            if (scheduled || s.scheduleCommand) {
              s.scheduleCommand = scheduled ? c.id : null;
              this.store.sessions.put(s.id, s);
            }
          }
        });
      }
      sent.add(c.id);
      result.push(c);
    }
    return result;
  }
}
