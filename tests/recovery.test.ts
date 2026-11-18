import { availablePort } from './helpers/port.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ServerStore } from '../apps/server/src/store.js';
import { createServer } from '../apps/server/src/server.js';
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Recovery condition timed out');
};
const stop = async (child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', resolve));
  child.kill(signal); await closed;
};
for (const mode of ['signed-out', 'hold-account', 'hold-turn-response', 'hold-completion', 'expired-turn']) {
  test(`application recovery at ${mode} boundary avoids replay`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'arthegall-recovery-'));
    const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
    execFileSync(process.execPath, [resolve('dist/scripts/arthegall.js'), 'setup'], { env: { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_PORT: String(port) }, stdio: 'ignore' });
    const server = new ServerStore(join(root, 'server', 'server.sqlite'));
    const config = JSON.parse(readFileSync(join(root, 'local.json'), 'utf8'));
    const session = server.pair(server.createPairingCode(), 'synthetic')!;
    const app = await createServer(server, origin);
    const db = new Database(join(root, 'runner', 'runner.sqlite'));
    const launch = () => spawn(process.execPath, [resolve('dist/tests/fixtures/runner-child.js'), root], { stdio: 'ignore' });
    writeFileSync(join(root, 'mode'), mode);
    let runner: ChildProcess | undefined;
    try {
      await app.listen({ port, host: '127.0.0.1' });
      const { runId } = server.send(session.id, { commandId: randomUUID(), text: 'Synthetic recovery check' });
      runner = launch();
      const row = () => db.prepare('SELECT state,outcome,turn_id FROM executions WHERE run_id=?').get(runId) as { state: string; outcome: string | null; turn_id: string | null } | undefined;
      const calls = () => { try { return readFileSync(join(root, 'calls'), 'utf8').split('\n'); } catch { return []; } };
      if (mode === 'signed-out') await until(() => (server.snapshot().runners[0] as { status: string }).status === 'sign_in_needed');
      else if (mode === 'hold-account') await until(() => calls().includes('account/read'));
      else if (mode === 'hold-turn-response') await until(() => calls().includes('turn/start'));
      else if (mode === 'hold-completion') await until(() => Boolean(row()?.outcome) && existsSync(join(root, 'completed')));
      else await until(() => row()?.state === 'done');
      if (['signed-out', 'hold-account'].includes(mode)) assert.equal(row()?.state, 'queued');
      if (mode === 'hold-turn-response') { assert.equal(row()?.state, 'running'); assert.equal(row()?.turn_id, null); }
      if (mode === 'expired-turn') {
        await until(() => (server.snapshot().runners[0] as { status: string }).status === 'sign_in_needed');
        assert.equal(JSON.parse(row()!.outcome!).status, 'blocked');
      }
      await stop(runner);
      writeFileSync(join(root, 'mode'), 'complete');
      runner = launch();
      await until(() => server.nextDispatch(config.runnerId) === undefined);
      const outcome = JSON.parse(row()!.outcome!);
      assert.equal(outcome.status, ['hold-turn-response', 'expired-turn'].includes(mode) ? 'blocked' : 'completed');
      assert.equal(calls().filter((method) => method === 'turn/start').length, 1);
      assert.equal(server.snapshot().messages.length, 2);
      assert.equal(server.events(0).filter((event) => (event as { kind: string }).kind === 'outcome').length, 1);
    } finally { if (runner) await stop(runner); await app.close(); db.close(); server.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
