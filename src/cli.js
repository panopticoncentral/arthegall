#!/usr/bin/env node
// Compatibility for commands run directly from an older checkout.
import { parseArgs } from "node:util";

const { tokens } = parseArgs({
  allowPositionals: true,
  strict: false,
  tokens: true,
  options: Object.fromEntries(
    [
      "dir",
      "listen",
      "port",
      "name",
      "cert",
      "key",
      "url",
      "ca",
      "after",
      "command-id",
    ].map((key) => [key, { type: "string" }]),
  ),
});
const command = tokens.find((token) => token.kind === "positional");
if (command?.value === "runner") {
  process.argv.splice(command.index + 2, 1);
  await import("../packages/runner/cli.js");
} else {
  await import("../packages/control-plane/cli.js");
}
