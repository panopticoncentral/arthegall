import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Runner } from "../packages/runner/runner.js";
import {
  decodeRunnerMessage,
  decodeControlMessage,
  supportsEventParts,
  versionIssue,
} from "@arthegall/shared/protocol";

test("wire contracts reject malformed receipts, commands and acknowledgments", () => {
  const decode = (fn, m) => fn(JSON.stringify(m));
  assert.throws(() =>
    decode(decodeRunnerMessage, {
      op: "events",
      rows: [
        {
          seq: 1,
          event: {
            type: "receipt",
            session: "s",
            command: "c",
            status: "unknown",
          },
        },
      ],
    }),
  );
  assert.throws(() =>
    decode(decodeControlMessage, {
      op: "command",
      command: {
        id: "c",
        session: "s",
        runner: "r",
        type: "approval",
        target: "p",
        allow: "false",
      },
    }),
  );
  assert.throws(() => decode(decodeControlMessage, { op: "ack", seq: -1 }));
  assert.throws(() => decode(decodeRunnerMessage, { op: "ack", seq: 1 }));
  assert.equal(supportsEventParts({ replayPartBytes: 256 }), true);
  assert.equal(
    supportsEventParts({
      protocolVersion: 1,
      features: [],
      replayPartBytes: 256,
    }),
    false,
  );
  assert.match(versionIssue(2, "control plane"), /Update the runner/);
});
test("a legacy peer without multipart support cannot advance an oversized journal entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "arthegall-legacy-"));
  const r = new Runner(dir);
  try {
    r.store.append({
      type: "delta",
      session: "s",
      item: "i",
      text: "x".repeat(300),
    });
    r.cursor = 0;
    r.online = true;
    r.eventParts = false;
    r.replayLimit = 128;
    let reason;
    r.socket = {
      readyState: WebSocket.OPEN,
      close: (code, detail) => {
        assert.equal(code, 4002);
        reason = detail;
      },
    };
    r.flush();
    assert.match(reason, /Update the control plane/);
    assert.equal(r.cursor, 0);
    assert.equal(r.store.sequence(), 1);
  } finally {
    r.lock.close();
    r.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
