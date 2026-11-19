import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { migrations } from '../apps/server/src/migrations.js';
import { ServerStore } from '../apps/server/src/store.js';
import { acquireProcessLock } from './process-lock.js';

const Manifest = z.strictObject({ format: z.literal(1), serverId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function validate(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length)
      throw new Error('Server snapshot failed SQLite integrity checks');
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version < 1 || version > migrations.length) throw new Error('Unsupported server snapshot schema');
    return z.uuid().parse(db.prepare("SELECT value FROM metadata WHERE key='server'").pluck().get());
  } finally { db.close(); }
}
export async function verifyBackup(directory: string, serverId: string, expectedHash?: string) {
  const manifestPath = join(directory, 'manifest.json'), database = join(directory, 'server.sqlite');
  if (!(await lstat(directory)).isDirectory() || !(await lstat(manifestPath)).isFile() || !(await lstat(database)).isFile())
    throw new Error('Backup directory or files were replaced');
  const manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest.serverId !== serverId || (expectedHash && manifest.sha256 !== expectedHash) || await digest(database) !== manifest.sha256)
    throw new Error('Backup identity or checksum differs from the verified snapshot');
  return manifest.sha256;
}
export async function backupServer(root: string, destination: string) {
  const path = join(destination, 'server.sqlite');
  mkdirSync(destination, { mode: 0o700 }); // Exclusive destination, manifest published last.
  try {
    const db = new Database(join(root, 'server', 'server.sqlite'), { readonly: true, fileMustExist: true });
    try { await db.backup(path); } finally { db.close(); }
    const snapshot = new Database(path, { fileMustExist: true });
    try { snapshot.pragma('journal_mode = DELETE'); } finally { snapshot.close(); }
    // Conversations, evidence, definitions and all other server-owned content
    // in these schema versions are inline in SQLite.
    const manifest = { format: 1, serverId: validate(path), sha256: await digest(path) };
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}
export async function restoreServer(root: string, source: string, config: { runnerId: string; token: string }) {
  const unlock = acquireProcessLock(root, 'server');
  const directory = join(root, 'server'), path = join(directory, 'server.sqlite');
  const stage = join(directory, '.restore-' + randomUUID());
  try {
    const manifest = Manifest.parse(JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')));
    await copyFile(join(source, 'server.sqlite'), stage);
    if (await digest(stage) !== manifest.sha256) throw new Error('Server snapshot checksum mismatch');
    if (validate(stage) !== manifest.serverId) throw new Error('Snapshot manifest identity mismatch');
    const restored = new ServerStore(stage);
    try {
      if (!restored.authenticateRunner(config.runnerId, config.token)) throw new Error('Snapshot belongs to another installation');
      restored.recovery.initialize();
      restored.db.pragma('journal_mode = DELETE');
    } finally { restored.close(); }
    validate(stage);
    if (existsSync(path)) {
      const current = new Database(path, { fileMustExist: true });
      try {
        if (current.prepare("SELECT value FROM metadata WHERE key='server'").pluck().get() !== manifest.serverId)
          throw new Error('Current server identity differs from the backup');
        // Fold any old WAL into its own database before replacing its main file.
        if (current.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Current server is busy');
      } finally { current.close(); }
    }
    if (['-wal', '-shm', '-journal'].some(suffix => existsSync(path + suffix)))
      throw new Error('Current database still has SQLite sidecars; inspect it before restoring');
    renameSync(stage, path);
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(stage + suffix, { force: true });
    unlock();
  }
}
