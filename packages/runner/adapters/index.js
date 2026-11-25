import { CodexAdapter, CodexHost } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";

export function harnessRegistry(dir) {
  const host = new CodexHost(dir);
  return new Map([
    [
      "codex",
      {
        probe: CodexAdapter.probe,
        create: (ctx) => new CodexAdapter(ctx, host),
      },
    ],
    [
      "claude",
      { probe: ClaudeAdapter.probe, create: (ctx) => new ClaudeAdapter(ctx, dir) },
    ],
  ]);
}
