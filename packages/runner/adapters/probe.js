import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function probeHarness(name, helpArgs, required, steering) {
  try {
    const { stdout } = await execute(name, ["--version"], { timeout: 5000 });
    const version = stdout.trim();
    const { stdout: help } = await execute(name, helpArgs, { timeout: 5000 });
    const missing = required.filter((flag) => !help.includes(flag));
    return missing.length
      ? {
          name,
          version,
          status: "unavailable",
          detail: "Missing interface: " + missing.join(", "),
        }
      : { name, version, status: "available", steering };
  } catch (error) {
    return {
      name,
      status: error.code === "ENOENT" ? "unavailable" : "unknown",
      detail: error.code === "ENOENT" ? "Executable missing" : error.message,
    };
  }
}
