import test from "node:test";
import assert from "node:assert/strict";
import { replayBatch } from "../packages/runner/replay.js";
import { IncomingEvent } from "../packages/control-plane/replay.js";

test("replay batches fit the byte limit including JSON envelopes and separators", () => {
  const event = { text: "🐟".repeat(10) };
  const rows = [1, 2, 3].map((seq) => ({ seq, body: JSON.stringify(event) }));
  const limit = Buffer.byteLength(replayBatch(rows.slice(0, 2), 1024).message);
  const batch = replayBatch(rows, limit);
  assert.equal(Buffer.byteLength(batch.message), limit);
  assert.deepEqual(JSON.parse(batch.message).rows, [
    { seq: 1, event },
    { seq: 2, event },
  ]);
  assert.equal(JSON.parse(replayBatch(rows, limit - 1).message).rows.length, 1);
});

test("an interrupted oversized event restarts from its original sequence and reassembles intact", () => {
  const limit = 128;
  const event = { text: '🐟"'.repeat(200) };
  const rows = [{ seq: 7, body: JSON.stringify(event) }];
  const { message, body } = replayBatch(rows, limit);
  const start = JSON.parse(message);
  assert.deepEqual(start, { op: "eventStart", seq: 7, bytes: body.length });
  assert.equal(
    new IncomingEvent(start.seq, start.bytes, limit).accept(
      body.subarray(0, limit),
    ),
    undefined,
  );
  const fresh = new IncomingEvent(start.seq, start.bytes, limit);
  assert.throws(() => fresh.accept(body.subarray(0, limit + 1)), /length/);
  for (let offset = 0; offset < body.length; offset += limit) {
    const row = fresh.accept(body.subarray(offset, offset + limit));
    if (offset + limit < body.length) assert.equal(row, undefined);
    else assert.deepEqual(row, { seq: 7, event });
  }
});
