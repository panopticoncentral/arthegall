import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** OS-backed SQLite locks release even after SIGKILL; PID files cannot ensure that. */
export function acquireProcessLock(root: string, role: 'server' | 'runner' | 'server-maintenance') {
  const directory = join(root, role === 'server-maintenance' ? 'server' : role);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new Database(join(directory, role === 'server-maintenance' ? 'maintenance-lock.sqlite' : 'process-lock.sqlite'));
  try {
    db.pragma('busy_timeout = 0');
    db.pragma('journal_mode = DELETE');
    db.exec('BEGIN EXCLUSIVE');
  } catch {
    db.close();
    throw new Error(`Another ${role} process already owns this data directory`);
  }
  return () => db.close();
}
