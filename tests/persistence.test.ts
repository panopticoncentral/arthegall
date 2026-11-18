import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServerStore } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';

test('repeat setup, command retries, dispatch retries, and result retries survive reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-store-test-'));
  let server = new ServerStore(join(root, 'server.sqlite'));
  let runner: RunnerStore | undefined;
  try {
    const ids = server.setup('synthetic-runner-token');
    assert.deepEqual(server.setup('synthetic-runner-token'), ids);
    assert.throws(() => server.setup('wrong-token'));
    const code = server.createPairingCode();
    const session = server.pair(code, 'synthetic-client')!;
    assert(session);
    assert.equal(server.pair(code, 'synthetic-client'), undefined);
    const command = { commandId: randomUUID(), text: 'Remember synthetic context' };
    const accepted = server.send(session.id, command);
    assert.deepEqual(server.send(session.id, command), accepted);
    assert.throws(() => server.send(session.id, { ...command, text: 'different' }));
    const dispatch = server.nextDispatch(ids.runnerId)!;
    assert.equal(dispatch.context.runId, accepted.runId);
    runner = new RunnerStore(join(root, 'runner.sqlite'), ids.runnerId);
    runner.accept(dispatch);
    runner.accept(dispatch); // Lost acknowledgment.
    assert.throws(() => runner!.accept({ ...dispatch, context: { ...dispatch.context, instructions: 'different' } }));
    runner.start(accepted.runId);
    runner.publish(accepted.runId, { kind: 'progress', text: 'Synthetic partial' });
    runner.stageOutcome(accepted.runId, { status: 'completed', message: 'Synthetic result' });
    runner.finish(accepted.runId, { status: 'completed', message: 'Synthetic result' });
    runner.close();
    server.close();
    runner = new RunnerStore(join(root, 'runner.sqlite'), ids.runnerId);
    server = new ServerStore(join(root, 'server.sqlite'));
    assert.equal(server.session(session.token), session.id);
    assert.deepEqual(server.nextDispatch(ids.runnerId), dispatch);
    server.accept(ids.runnerId, dispatch.dispatchId);
    for (let delivery = runner.nextDelivery(); delivery; delivery = runner.nextDelivery()) {
      server.receive(ids.runnerId, delivery);
      server.receive(ids.runnerId, delivery); // Lost result acknowledgment.
      assert.throws(() => server.receive(ids.runnerId, { ...delivery, sequence: delivery.sequence + 1 }));
      runner.acknowledge(delivery.deliveryId);
    }
    assert.equal(server.nextDispatch(ids.runnerId), undefined);
    const snapshot = server.snapshot();
    assert.equal(snapshot.messages.length, 2);
    assert.equal((snapshot.messages[1] as { text: string }).text, 'Synthetic result');
    assert.equal((snapshot.messages[1] as { state: string }).state, 'completed');
    assert.equal(server.events(0).filter((row) => (row as { kind: string }).kind === 'outcome').length, 1);
    server.revokeSession(session.id);
    assert.equal(server.session(session.token), undefined);
  } finally { runner?.close(); server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('queued follow-up context includes the preceding result; stale approval cannot grant later work', () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-order-test-'));
  const server = new ServerStore(join(root, 'server.sqlite'));
  const ids = server.setup('synthetic');
  const session = server.pair(server.createPairingCode(), 'client')!;
  const runner = new RunnerStore(join(root, 'runner.sqlite'), ids.runnerId);
  try {
    const first = server.send(session.id, { commandId: randomUUID(), text: 'First' });
    const second = server.send(session.id, { commandId: randomUUID(), text: 'Second' });
    const dispatch = server.nextDispatch(ids.runnerId)!;
    runner.accept(dispatch); runner.start(first.runId);
    const approvalId = randomUUID();
    runner.publish(first.runId, { kind: 'approval', approval: { approvalId, command: 'Synthetic operation' } });
    const approval = runner.nextDelivery()!;
    server.receive(ids.runnerId, approval); runner.acknowledge(approval.deliveryId);
    // Provider commentary can arrive while its native operation awaits approval.
    runner.publish(first.runId, { kind: 'progress', text: 'Waiting for your decision' });
    const progress = runner.nextDelivery()!;
    server.receive(ids.runnerId, progress); runner.acknowledge(progress.deliveryId);
    server.decide(session.id, approvalId, 'decline');
    assert.throws(() => server.decide(session.id, approvalId, 'accept'));
    assert.equal(server.decisions(ids.runnerId)[0]?.decision, 'decline');
    runner.finish(first.runId, { status: 'completed', message: 'First result' });
    server.receive(ids.runnerId, runner.nextDelivery()!);
    assert.throws(() => server.decide(session.id, approvalId, 'accept'));
    assert.equal(server.decisions(ids.runnerId).length, 0);
    const next = server.nextDispatch(ids.runnerId)!;
    assert.equal(next.context.runId, second.runId);
    assert.deepEqual(next.context.messages.map((m) => m.text), ['First', 'First result', 'Second']);
  } finally { runner.close(); server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('invalid and expired pairing codes are bounded; migration rejects newer database', () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-pair-test-'));
  const server = new ServerStore(join(root, 'server.sqlite'));
  try {
    server.setup('synthetic');
    const code = server.createPairingCode(0);
    assert.equal(server.pair(code, 'expired-client', 600_000), undefined);
    const active = server.createPairingCode(0);
    for (let i = 0; i < 5; i++) assert.equal(server.pair('bad', 'limited-client', 0), undefined);
    assert.equal(server.pair(active, 'limited-client', 0), undefined);
    assert(server.pair(active, 'limited-client', 60_001));
    server.db.pragma('user_version = 99');
    assert.throws(() => new ServerStore(join(root, 'server.sqlite')), /newer/);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
