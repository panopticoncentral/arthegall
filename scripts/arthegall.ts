import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ServerStore } from '../apps/server/src/store.js';
import { createServer } from '../apps/server/src/server.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import { DailyBackups } from './daily-backups.js';
import { backupServer, restoreServer } from './backup.js';
import { acquireProcessLock } from './process-lock.js';
import { manageService } from './service.js';
import { startRunner } from '../apps/runner/src/runner.js';

process.umask(0o077);
const configuredRoot = resolve(process.env.ARTHEGALL_DATA_DIR ?? join(homedir(), '.arthegall'));
const root = existsSync(configuredRoot) ? realpathSync(configuredRoot) : configuredRoot;
const configPath = join(root, 'local.json');
const Config = z.strictObject({ runnerId: z.string().uuid(), token: z.string(), origin: z.string().url(), port: z.number().int().min(1).max(65535) });
const readConfig = () => Config.parse(JSON.parse(readFileSync(configPath, 'utf8')));
const command = process.argv[2];
// Serialize short-lived CLI writers with the validated database replacement.
if (['setup', 'pair', 'backup', 'restore'].includes(command ?? '')) {
  process.once('exit', acquireProcessLock(root, 'server-maintenance'));
}
if (command === 'setup') {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const old = existsSync(configPath) ? readConfig() : undefined;
  const tokenPath = join(root, 'runner-token');
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, old?.token ?? randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  const token = readFileSync(tokenPath, 'utf8');
  const store = new ServerStore(join(root, 'server', 'server.sqlite'));
  try {
    const ids = store.setup(token);
    const port = old?.port ?? z.coerce.number().int().min(1).max(65535).parse(process.env.ARTHEGALL_PORT ?? 4317);
    const origin = old?.origin ?? process.env.ARTHEGALL_ORIGIN ?? `http://127.0.0.1:${port}`;
    const config = Config.parse({ runnerId: ids.runnerId, token, origin, port });
    if (!old) writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    const runner = new RunnerStore(join(root, 'runner', 'runner.sqlite'), ids.runnerId);
    runner.close();
    console.log(`Server address: ${origin}\nPairing code (valid for ten minutes): ${store.createPairingCode()}\nOnce services are running, open Arthegall.app and enter the address and code.`);
  } finally { store.close(); }
} else if (command === 'pair') {
  const config = readConfig();
  const store = new ServerStore(join(root, 'server', 'server.sqlite'));
  try { console.log(`Server address: ${config.origin}\nPairing code (valid for ten minutes): ${store.createPairingCode()}`); } finally { store.close(); }
} else if (command === 'backup' || command === 'restore') {
  if (process.argv.length !== 4) throw new Error('Specify one backup directory');
  const directory = resolve(process.argv[3]!);
  if (command === 'backup') {
    await backupServer(root, directory);
    console.log('Verified server backup saved to ' + directory);
  } else {
    await restoreServer(root, directory, readConfig());
    console.log('Server restored with dispatch paused. Start services and open a paired client to reconcile.');
  }
} else if (command === 'server') {
  const unlock = acquireProcessLock(root, 'server');
  const config = readConfig();
  const store = new ServerStore(join(root, 'server', 'server.sqlite'));
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
  const serverId = z.uuid().parse(store.db.prepare("SELECT value FROM metadata WHERE key='server'").pluck().get());
  const backups = new DailyBackups(root, serverId,
    [dirname(webRoot), join(root,'releases'), join(root,'server'), join(root,'runner'), join(root,'workspaces')],
    () => store.recovery.paused(), () => store.reporting.event('backup_status', {}));
  const server = await createServer(store, config.origin, existsSync(webRoot) ? webRoot : undefined, backups);
  await server.listen({ host: '127.0.0.1', port: config.port });
  console.log(`Arthegall server listening at ${config.origin}`);
  const close = async () => { await server.close(); store.close(); unlock(); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
} else if (command === 'runner') {
  const unlock = acquireProcessLock(root, 'runner');
  const config = readConfig();
  const store = new RunnerStore(join(root, 'runner', 'runner.sqlite'), config.runnerId);
  const runner = await startRunner(store, {
    runnerId: config.runnerId, token: config.token, serverUrl: config.origin,
    workspaceRoot: join(root, 'workspaces'),
    ...(process.env.ARTHEGALL_CODEX_BIN ? { codex: process.env.ARTHEGALL_CODEX_BIN } : {}),
    fake: process.argv.includes('--fake'),
    approvalExercise: process.argv.includes('--approval-exercise'),
  });
  console.log(process.argv.includes('--fake') ? 'Arthegall runner: deterministic test provider' : 'Arthegall runner: Codex provider');
  const close = async () => { await runner.close(); store.close(); unlock(); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
} else if (['install', 'start', 'stop', 'restart', 'status'].includes(command ?? '')) {
  manageService(command!, root, resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
} else {
  console.log('Usage: arthegall <setup|pair|backup|restore|server|runner|install|start|stop|restart|status>\nUse ARTHEGALL_DATA_DIR for an alternate private data directory.\nThe runner --fake option is for deterministic tests only.');
  if (command && command !== 'help') process.exitCode = 1;
}
