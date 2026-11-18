import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunnerStore } from '../../apps/runner/src/store.js';
import { startRunner } from '../../apps/runner/src/runner.js';
import { CodexRpc } from '../../apps/runner/src/codex/rpc.js';
const root = process.argv[2]!;
const config = JSON.parse(readFileSync(join(root, 'local.json'), 'utf8'));
const store = new RunnerStore(join(root, 'runner', 'runner.sqlite'), config.runnerId);
const runner = await startRunner(store, {
  runnerId: config.runnerId, token: config.token, serverUrl: config.origin, workspaceRoot: join(root, 'workspaces'),
  rpcFactory: (workspace) => new CodexRpc(process.execPath, [resolve('dist/tests/fixtures/provider.js'), root], workspace),
});
process.once('SIGTERM', () => { void runner.close().then(() => store.close()); });
