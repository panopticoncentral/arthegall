#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "./server.js";
process.umask(0o077);
const help = `arthegall serve [--dir DIR] [--listen ADDRESS] [--port PORT] [--name TLS_HOSTNAME]
               [--cert CERT --key PRIVATE_KEY]
arthegall pair CODE
arthegall runners | sessions
arthegall launch RUNNER HARNESS ABSOLUTE_DIRECTORY "FIRST PROMPT"
arthegall send SESSION "FOLLOW-UP"
arthegall steer SESSION TURN "UPDATED INSTRUCTION"
arthegall commands [SESSION] | history SESSION [--after SEQUENCE] [--follow]
arthegall approve SESSION REQUEST | deny SESSION REQUEST
arthegall cancel COMMAND | stop SESSION TURN | end SESSION

arthegall schedule create launch RUNNER HARNESS ABSOLUTE_DIRECTORY "PROMPT" TIMING
arthegall schedule create send SESSION "FOLLOW-UP" TIMING
arthegall schedule edit SCHEDULE TIMING | schedule cancel SCHEDULE
arthegall schedule list | schedule history SCHEDULE
TIMING: --in 5m | --at ISO_TIMESTAMP_WITH_OFFSET | --time HH:MM [--days weekdays|daily|mon,wed,...]
        [--zone America/Los_Angeles] [--missed latest|backfill (recurring only)]

Session and schedule actions accept --command-id UUID for retrying the same request.
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
  if (!op || o.help || op === "help") console.log(help);
  else if (op === "serve") {
    if (!!o.cert !== !!o.key) throw Error("supply --cert and --key together");
    if (o["command-id"])
      throw Error("--command-id requires a session or schedule action");
    serve(dir, o);
  } else {
    const forms = {
      "schedule-create":
        target === "send"
          ? ["session", "text"]
          : ["runner", "harness", "cwd", "text"],
      "schedule-edit": ["id"],
      "schedule-list": [],
      "schedule-history": ["id"],
      "schedule-cancel": ["id"],
      pair: ["code"],
      runners: [],
      sessions: [],
      launch: ["runner", "harness", "cwd", "text"],
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
    if (target) args.target = target;
    Object.assign(args, calendar);
    const action = ![
      "schedule-list",
      "schedule-history",
      "pair",
      "runners",
      "sessions",
      "commands",
      "history",
    ].includes(op);
    if (!action && o["command-id"] !== undefined)
      throw Error("--command-id requires a session or schedule action");
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
        console.log(
          JSON.stringify(
            await request(
              dir,
              action ? { op: "submit", action: op, ...args } : { op, ...args },
            ),
            null,
            2,
          ),
        );
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
