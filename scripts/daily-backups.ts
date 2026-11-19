/// <reference lib="esnext.temporal" />
import Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import { isAbsolute, join, resolve } from 'node:path';
import type { BackupSettings, DailyBackupStatus } from '../packages/contracts/src/index.js';
import { Conflict } from '../apps/server/src/reporting.js';

export type BackupJob = { root: string; destination: string; keep: number; day: string; serverId: string; protectedPaths: string[] };
export function openCatalog(root: string) {
  const db = new Database(join(root, 'server', 'daily-backups.sqlite'));
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, destination TEXT NOT NULL DEFAULT '',
    keep INTEGER NOT NULL DEFAULT 7, nextDue INTEGER, lastSuccess INTEGER, lastPath TEXT, error TEXT);
    INSERT OR IGNORE INTO settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS copies (destination TEXT NOT NULL, day TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
      sha256 TEXT, retiring INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(destination,day));`);
  return db;
}

export class DailyBackups {
  private db: Database.Database;
  private active: Promise<void> | undefined;
  private closing = false;
  constructor(private root: string, private serverId: string, private protectedPaths: string[],
    private paused: () => boolean, private changed: () => void, private now = () => new Date()) {
    this.db = openCatalog(root);
  }
  status(): DailyBackupStatus {
    const row = this.db.prepare('SELECT enabled,destination,keep,nextDue,lastSuccess,lastPath,error FROM settings').get() as
      Omit<DailyBackupStatus,'running'|'timeZone'|'enabled'> & { enabled: number };
    return { ...row, enabled: Boolean(row.enabled), running: Boolean(this.active), timeZone: Temporal.Now.timeZoneId() };
  }
  configure(settings: BackupSettings) {
    if (this.active) throw new Conflict('A daily backup is in progress');
    if (settings.enabled && (!isAbsolute(settings.destination) || settings.destination.includes('\0')))
      throw new Conflict('Enter the absolute path of an existing folder on the server');
    const destination = settings.destination ? resolve(settings.destination) : '';
    const old = this.status();
    if (old.enabled === settings.enabled && old.destination === destination && old.keep === settings.keep) return;
    this.db.prepare('UPDATE settings SET enabled=?,destination=?,keep=?,nextDue=?,error=NULL').run(
      Number(settings.enabled), destination, settings.keep, settings.enabled ? this.now().getTime() : null);
    this.changed();
  }
  retry() {
    if (this.active) return;
    if (!this.status().enabled) throw new Conflict('Enable daily backups first');
    this.db.prepare('UPDATE settings SET nextDue=?').run(this.now().getTime());
    this.changed();
  }
  tick() {
    if (this.active || this.closing) return this.active;
    const status = this.status(), now = this.now();
    if (!status.enabled || status.nextDue === null || status.nextDue > now.getTime() || this.paused()) return;
    const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(status.timeZone).toPlainDate();
    const tomorrow = today.add({ days: 1 }).toZonedDateTime({ timeZone: status.timeZone, plainTime: '03:00' });
    const job: BackupJob = { root: this.root, destination: status.destination, keep: status.keep, serverId: this.serverId,
      day: today.toString(), protectedPaths: this.protectedPaths };
    this.active = this.run(job, tomorrow.epochMilliseconds).finally(() => { this.active = undefined; this.changed(); });
    this.changed();
    return this.active;
  }
  private async run(job: BackupJob, nextDue: number) {
    try {
      await new Promise<void>((done, fail) => {
        const worker = new Worker(new URL('./daily-copy.js', import.meta.url), { workerData: job });
        worker.once('error', fail);
        worker.once('exit', code => code === 0 ? done() : fail(new Error('Backup worker stopped unexpectedly')));
      });
      this.db.prepare('UPDATE settings SET nextDue=?,error=NULL').run(nextDue);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backup failed';
      this.db.prepare('UPDATE settings SET nextDue=?,error=?').run(this.now().getTime() + 15 * 60_000, message.slice(0,1000));
    }
  }
  async close() { this.closing = true; await this.active; this.db.close(); }
}
