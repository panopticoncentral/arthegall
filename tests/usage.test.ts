import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsage } from '../apps/runner/src/usage.js';
import { yesterday } from '../packages/contracts/src/reporting.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-usage-'));
  const roots = { codex: join(root, 'codex'), claude: join(root, 'claude') };
  function log(directory: string, rows: unknown[]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'synthetic.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
  }
  return { roots, log, close: () => rmSync(root, { recursive: true, force: true }) };
}
function response(timestamp: string, id: string, n = 10) {
  return { type: 'token_usage_record', timestamp, payload: { response_id: id, usage: {
    input_tokens: n, cached_input_tokens: n / 2, output_tokens: n, reasoning_output_tokens: n / 2, total_tokens: n * 2,
  } } };
}

test('spring and fall Pacific calendar days include exact boundaries and distinct responses across archives', async () => {
  for (const [date, start, end] of [
    ['2020-03-08', '2020-03-08T08:00:00Z', '2020-03-09T07:00:00Z'],
    ['2020-11-01', '2020-11-01T07:00:00Z', '2020-11-02T08:00:00Z'],
  ] as const) {
    const f = fixture();
    try {
      const before = (instant: string) => new Date(Date.parse(instant) - 1).toISOString();
      const first = response(start, 'first');
      f.log(join(f.roots.codex, 'sessions', 'older-start-day'), [
        response(before(start), 'outside'), first, response(before(end), 'last'), response(end, 'outside2'), response(start, 'outside'),
        { type: 'event_msg', timestamp: start, payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 } } } },
      ]);
      f.log(join(f.roots.codex, 'archived_sessions'), [first]);
      const r = await readUsage({ start: date, end: date }, f.roots);
      assert.equal(r.codex.coverage, 'recorded');
      assert.deepEqual([r.codex.responses, r.codex.input, r.codex.cachedInput, r.codex.output, r.codex.reasoningOutput, r.codex.total], [2, 20, 10, 20, 10, 40]);
      assert.equal(r.claude.coverage, 'no_records'); assert.equal(r.claude.total, null);
      assert.equal(r.codex.actualSpendUsd, null); assert.equal(r.combinedTokens, null);
      assert.deepEqual(yesterday(new Date(end)), r.range);
    } finally { f.close(); }
  }
});

test('explicit zero, malformed records, conflicting duplicates and unknown spend remain distinct', async () => {
  const f = fixture(), time = '2020-06-01T12:00:00Z', day = { start: '2020-06-01', end: '2020-06-01' };
  try {
    f.log(join(f.roots.codex, 'sessions'), [response(time, 'zero', 0)]);
    const r = await readUsage(day, f.roots);
    assert.equal(r.codex.total, 0); assert.equal(r.codex.coverage, 'recorded'); assert.equal(r.codex.actualSpendUsd, null);
    f.log(join(f.roots.codex, 'archived_sessions'), [response(time, 'a'), response(time, 'a', 30), { type: 'token_usage_record', timestamp: time }]);
    const claude = { type: 'assistant', timestamp: time, costUSD: 99, message: { id: 'synthetic-response', model: 'synthetic-test-model',
      usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 5 } } };
    f.log(join(f.roots.claude, 'projects'), [claude, claude]);
    const partial = await readUsage(day, f.roots);
    assert.equal(partial.codex.coverage, 'partial'); assert.equal(partial.codex.responses, 1);
    assert.deepEqual([partial.claude.coverage, partial.claude.responses, partial.claude.total, partial.claude.cachedInput, partial.claude.reasoningOutput, partial.claude.actualSpendUsd],
      ['partial', 1, 20, 2, null, null]);
    await assert.rejects(readUsage({ start: '2021-02-29', end: '2021-03-01' }, f.roots));
    await assert.rejects(readUsage({ start: '2021-05-01', end: '2021-03-01' }, f.roots));
  } finally { f.close(); }
});

test('cross-check discrepancies flag partial coverage without inflating response totals', async () => {
  const f = fixture(), day = { start: '2020-06-01', end: '2020-06-01' }, time = '2020-06-01T12:00:00Z';
  try {
    const event = (n: number) => ({ type: 'event_msg', timestamp: time, payload: { type: 'token_count',
      info: { last_token_usage: { total_tokens: n }, total_token_usage: { total_tokens: n } } } });
    f.log(join(f.roots.codex, 'sessions'), [response(time, 'one'), event(20), event(20)]);
    assert.equal((await readUsage(day, f.roots)).codex.coverage, 'recorded');
    f.log(join(f.roots.codex, 'sessions'), [response(time, 'one'), event(30)]);
    const report = await readUsage(day, f.roots);
    assert.equal(report.codex.coverage, 'partial');
    assert.equal(report.codex.total, 20);
    assert(report.codex.notes.some((note) => note.includes('cross-check')));
  } finally { f.close(); }
});
