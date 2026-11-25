#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "./server.js";
process.umask(0o077);
const sessionFlags = {
  model: "model",
  effort: "effort",
  "approval-policy": "approvalPolicy",
  "approval-reviewer": "approvalsReviewer",
  "permission-mode": "permissionMode",
  "permission-prompts": "permissionPrompts",
};
const help = `arthegall serve [--dir DIR] [--listen ADDRESS] [--port PORT] [--name TLS_HOSTNAME]
               [--cert CERT --key PRIVATE_KEY]
arthegall pair CODE
arthegall runners | sessions [PROJECT] [--agent AGENT_ID] | session show SESSION
arthegall agent add NAME (--prompt TEXT | --prompt-file PATH)
arthegall agent edit AGENT_ID [--name NAME] [--prompt TEXT | --prompt-file PATH]
arthegall agent list | agent show AGENT_ID | agent archive AGENT_ID | agent restore AGENT_ID
arthegall project add RUNNER NAME PRIMARY_PATH [ADDITIONAL_PATH ...]
arthegall project edit PROJECT NAME PRIMARY_PATH [ADDITIONAL_PATH ...]
arthegall project list | project archive PROJECT
arthegall launch PROJECT HARNESS "FIRST PROMPT" [SESSION OPTIONS]
arthegall send SESSION "FOLLOW-UP"
arthegall steer SESSION TURN "UPDATED INSTRUCTION"
arthegall commands [SESSION] | history SESSION [--after SEQUENCE] [--follow]
arthegall approve SESSION REQUEST | deny SESSION REQUEST
arthegall cancel COMMAND | stop SESSION TURN | end SESSION

arthegall schedule create launch PROJECT HARNESS "PROMPT" TIMING [SESSION OPTIONS]
arthegall schedule create send SESSION "FOLLOW-UP" TIMING
arthegall schedule edit SCHEDULE TIMING | schedule cancel SCHEDULE
arthegall schedule list | schedule history SCHEDULE
TIMING: --in 5m | --at ISO_TIMESTAMP_WITH_OFFSET | --time HH:MM [--days weekdays|daily|mon,wed,...]
        [--zone America/Los_Angeles] [--missed latest|backfill (recurring only)]

Session options for both harnesses: --agent AGENT_ID --model MODEL --effort LEVEL
Codex: --approval-policy untrusted|on-request|never --approval-reviewer user|auto_review
Claude: --permission-mode manual|acceptEdits|plan|auto|dontAsk|bypassPermissions
        --permission-prompts host|none

Agent, project, session and schedule actions accept --command-id UUID for retrying the same request.
Operator commands use --dir DIR or ARTHEGALL_CONTROL_DIR to locate the local control plane.`;
function request(dir, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: join(dir, "admin.sock"), path: "/", method: "POST" },
      (res) => {
        let body = "";
        res.on("error", reject);
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const r = JSON.parse(body);
            if (res.statusCode !== 200) throw Error(r.error);
            resolve(r);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(data));
  });
}
try {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "dir",
        "listen",
        "port",
        "name",
        "cert",
        "key",
        "after",
        "command-id",
        "in",
        "at",
        "time",
        "days",
        "zone",
        "missed",
        "agent",
        "prompt",
        "prompt-file",
        ...Object.keys(sessionFlags),
      ]
        .map((k) => [k, { type: "string" }])
        .concat([
          ["help", { type: "boolean" }],
          ["follow", { type: "boolean" }],
        ]),
    ),
  });
  let [op, ...p] = positionals;
  const calendar = {};
  for (const key of ["in", "at", "time", "days", "zone", "missed"]) {
    if (o[key] === undefined) continue;
    if (op !== "schedule" || !["create", "edit"].includes(p[0]))
      throw Error("timing options require schedule create or edit");
    calendar[key] = o[key];
  }
  let target;
  if (["agent", "project", "session"].includes(op)) op += "-" + p.shift();
  if (op === "schedule") {
    op = "schedule-" + p.shift();
    if (op === "schedule-create") {
      target = p.shift();
      if (!["launch", "send"].includes(target)) throw Error(help);
      calendar.zone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
  }
  const dir = resolve(
    o.dir ??
      process.env.ARTHEGALL_CONTROL_DIR ??
      join(homedir(), ".arthegall", "control"),
  );
  const settings = Object.fromEntries(
    Object.entries(sessionFlags)
      .filter(([flag]) => o[flag] !== undefined)
      .map(([flag, key]) => [key, o[flag]]),
  );
  const configured = Object.keys(settings).length > 0;
  if (
    configured &&
    op !== "launch" &&
    !(op === "schedule-create" && target === "launch")
  )
    throw Error("session options require launch or schedule create launch");
  if (
    o.agent !== undefined &&
    op !== "launch" &&
    op !== "sessions" &&
    !(op === "schedule-create" && target === "launch")
  )
    throw Error("--agent requires sessions, launch, or schedule create launch");
  if (o.prompt !== undefined || o["prompt-file"] !== undefined) {
    if (!["agent-add", "agent-edit"].includes(op))
      throw Error("agent prompt requires agent add or edit");
    if (o.prompt !== undefined && o["prompt-file"] !== undefined)
      throw Error("choose --prompt or --prompt-file");
  }
  if (!op || o.help || op === "help") console.log(help);
  else if (op === "serve") {
    if (!!o.cert !== !!o.key) throw Error("supply --cert and --key together");
    if (o["command-id"])
      throw Error(
        "--command-id requires an agent, project, session or schedule action",
      );
    serve(dir, o);
  } else {
    // Older clients specify the runner and primary directory directly.
    const launchKeys =
      p.length === 4
        ? ["runner", "harness", "cwd", "text"]
        : ["project", "harness", "text"];
    const paths = ["project-add", "project-edit"].includes(op)
      ? p.splice(3)
      : null;
    const forms = {
      "agent-add": ["name"],
      "agent-edit": ["id"],
      "agent-show": ["id"],
      "agent-list": [],
      "agent-archive": ["id"],
      "agent-restore": ["id"],
      "session-show": ["id"],
      "project-list": [],
      "project-add": ["runner", "name", "cwd"],
      "project-edit": ["id", "name", "cwd"],
      "project-archive": ["id"],
      "schedule-create": target === "send" ? ["session", "text"] : launchKeys,
      "schedule-edit": ["id"],
      "schedule-list": [],
      "schedule-history": ["id"],
      "schedule-cancel": ["id"],
      pair: ["code"],
      runners: [],
      sessions: p.length ? ["project"] : [],
      launch: launchKeys,
      send: ["session", "text"],
      steer: ["session", "turn", "text"],
      commands: p.length ? ["session"] : [],
      history: ["session"],
      approve: ["session", "request"],
      deny: ["session", "request"],
      cancel: ["id"],
      stop: ["session", "turn"],
      end: ["session"],
    };
    const keys = forms[op];
    if (!Array.isArray(keys) || keys.length !== p.length) throw Error(help);
    const args = Object.fromEntries(keys.map((k, i) => [k, p[i]]));
    if (op === "agent-edit" && o.name !== undefined) args.name = o.name;
    if (o.prompt !== undefined) args.prompt = o.prompt;
    if (o["prompt-file"] !== undefined)
      args.prompt = readFileSync(o["prompt-file"], "utf8");
    if (o.agent !== undefined) args.agentId = o.agent;
    if (paths) args.additionalDirs = paths;
    if (configured) args.settings = settings;
    if (target) args.target = target;
    Object.assign(args, calendar);
    const action = ![
      "agent-list",
      "agent-show",
      "session-show",
      "project-list",
      "schedule-list",
      "schedule-history",
      "pair",
      "runners",
      "sessions",
      "commands",
      "history",
    ].includes(op);
    if (!action && o["command-id"] !== undefined)
      throw Error(
        "--command-id requires an agent, project, session or schedule action",
      );
    if (action) args.commandId = o["command-id"] ?? randomUUID();
    if (o.after) args.after = Number(o.after);
    if (o.after && (!Number.isSafeInteger(args.after) || args.after < 0))
      throw Error("invalid event sequence");
    if (o.follow && op !== "history") throw Error("--follow requires history");
    if (o.follow) {
      for (;;) {
        for (const row of await request(dir, { op, ...args })) {
          console.log(JSON.stringify(row));
          args.after = row.seq;
        }
        await delay(500);
      }
    } else {
      try {
        // Older servers must reject launches that require newer capabilities.
        let operation = op;
        if (action) {
          operation = configured ? "submit-configured-launch" : "submit";
          if (o.agent !== undefined) operation = "submit-agent-launch";
          args.action = op;
        } else if (op === "sessions" && o.agent !== undefined) {
          operation = "agent-sessions";
        }
        const result = await request(dir, { op: operation, ...args });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        if (action) console.error("Command ID for retry:", args.commandId);
        throw error;
      }
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
