#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { run } from "./runner.js";

process.umask(0o077);
const help = `arthegall-runner [--dir DIR] [--url wss://HOST:PORT/runner --ca CERT --name LABEL]

The first run pairs this installation with the control plane. Subsequent runs use the saved identity.
Use --dir or ARTHEGALL_RUNNER_DIR to select a state directory.`;

try {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      url: { type: "string" },
      ca: { type: "string" },
      name: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(help);
  else {
    const dir = resolve(
      values.dir ??
        process.env.ARTHEGALL_RUNNER_DIR ??
        join(homedir(), ".arthegall", "runner"),
    );
    await run(dir, values);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
