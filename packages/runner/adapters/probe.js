import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);

// The ordinary CLI help does not describe Codex's thread parameters.
let schemaVersion;
let schemaSupportsAgents;
async function codexAgentSupport(version) {
  if (version === schemaVersion) return schemaSupportsAgents;
  const dir = await mkdtemp(join(tmpdir(), "arthegall-schema-"));
  try {
    await execute(
      "codex",
      ["app-server", "generate-json-schema", "--out", dir],
      { timeout: 10000 },
    );
    const schemas = await Promise.all(
      ["ThreadStartParams", "ThreadResumeParams"].map(async (name) =>
        JSON.parse(await readFile(join(dir, "v2", name + ".json"), "utf8")),
      ),
    );
    schemaSupportsAgents = schemas.every(
      (schema) => !!schema.properties?.developerInstructions,
    );
    schemaVersion = version;
    return schemaSupportsAgents;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
      : {
          name,
          version,
          status: "available",
          steering,
          agentInstructions:
            name === "codex"
              ? await codexAgentSupport(version)
              : /--append-system-prompt(?:-file|\[-file\])/.test(help),
        };
  } catch (error) {
    return {
      name,
      status: error.code === "ENOENT" ? "unavailable" : "unknown",
      detail: error.code === "ENOENT" ? "Executable missing" : error.message,
    };
  }
}
