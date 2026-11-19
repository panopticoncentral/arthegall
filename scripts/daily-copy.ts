import { isMainThread, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { backupServer, verifyBackup } from './backup.js';
import { openCatalog, type BackupJob } from './daily-backups.js';

type Copy = { day: string; name: string; sha256: string | null; retiring: number };
const archiveFiles = ['manifest.json', 'server.sqlite'];
const partialFiles = [...archiveFiles, 'server.sqlite-wal', 'server.sqlite-shm', 'server.sqlite-journal'];

// Only remove known files in directories reserved in this installation's catalog.
// Refuse a replaced directory, unexpected contents, or a changed verified copy.
function removeFiles(path: string, allowed: string[]) {
  if (!lstatSync(path).isDirectory()) throw new Error('Managed backup directory was replaced');
  const entries = readdirSync(path);
  if (entries.some(name => !allowed.includes(name) || !lstatSync(join(path,name)).isFile()))
    throw new Error('Unexpected files in managed backup directory ' + path);
  for (const name of entries) unlinkSync(join(path,name));
  rmdirSync(path);
}

export async function dailyCopy(job: BackupJob) {
  const { root, day, keep, serverId } = job;
  if (!existsSync(job.destination)) throw new Error('Backup folder is unavailable. Check the path or reconnect the drive: ' + job.destination);
  const destination = realpathSync(job.destination); // A disconnected destination must not be recreated.
  if (!lstatSync(destination).isDirectory()) throw new Error('Backup destination must be an existing directory');
  for (const path of job.protectedPaths) {
    const offset = relative(existsSync(path) ? realpathSync(path) : path, destination);
    if (offset === '' || (!offset.startsWith('..' + sep) && offset !== '..' && !isAbsolute(offset)))
      throw new Error('Choose a backup folder outside the application, server stores and runner workspaces');
  }
  const db = openCatalog(root);
  try {
    db.prepare('INSERT OR IGNORE INTO copies(destination,day,name) VALUES (?,?,?)')
      .run(destination, day, 'arthegall-daily-' + day + '-' + randomUUID());
    const copy = db.prepare('SELECT * FROM copies WHERE destination=? AND day=?').get(destination,day) as Copy;
    const published = join(destination,copy.name), staging = published + '.partial';
    let hash: string;
    if (existsSync(published)) {
      // A crash after rename can leave the verified archive ahead of the catalog.
      hash = await verifyBackup(published,serverId,copy.sha256 ?? undefined);
    } else {
      if (copy.sha256) throw new Error('Verified daily backup is missing: ' + published);
      if (existsSync(staging)) removeFiles(staging,partialFiles);
      await backupServer(root,staging);
      hash = await verifyBackup(staging,serverId);
      renameSync(staging,published);
    }
    db.transaction(() => {
      db.prepare('UPDATE copies SET sha256=? WHERE name=?').run(hash,copy.name);
      if (!copy.sha256) db.prepare('UPDATE settings SET lastSuccess=?,lastPath=?').run(Date.now(),published);
    })();

    // A shutdown across midnight can strand yesterday's staging directory or
    // leave its completed rename unrecorded. Recover it before counting copies.
    const pending = db.prepare('SELECT * FROM copies WHERE destination=? AND sha256 IS NULL').all(destination) as Copy[];
    for (const prior of pending) {
      const path = join(destination,prior.name);
      if (existsSync(path)) {
        const digest = await verifyBackup(path,serverId);
        db.prepare('UPDATE copies SET sha256=? WHERE name=?').run(digest,prior.name);
      } else {
        if (existsSync(path + '.partial')) removeFiles(path + '.partial',partialFiles);
        db.prepare('DELETE FROM copies WHERE name=?').run(prior.name);
      }
    }
    const copies = db.prepare('SELECT * FROM copies WHERE destination=? AND sha256 IS NOT NULL ORDER BY day DESC').all(destination) as Copy[];
    const eligible = copies.filter(row => !row.retiring);
    const retiring = copies.filter(row => row.retiring);
    if (eligible.length > keep || retiring.length) {
      // If a retained copy was altered or went missing, preserve older recovery points.
      for (const saved of eligible.slice(0,keep)) {
        if (saved.name !== copy.name) await verifyBackup(join(destination,saved.name),serverId,saved.sha256!);
      }
      retiring.push(...eligible.slice(keep));
    }
    for (const saved of retiring) {
      const path = join(destination,saved.name), retired = path + '.retiring';
      if (existsSync(path)) {
        await verifyBackup(path,serverId,saved.sha256!);
        if (readdirSync(path).some(name => !archiveFiles.includes(name))) throw new Error('Unexpected files in ' + path);
        db.prepare('UPDATE copies SET retiring=1 WHERE name=?').run(saved.name);
        if (existsSync(retired)) throw new Error('Retirement path already exists: ' + retired);
        renameSync(path,retired);
        saved.retiring = 1;
      }
      if (saved.retiring && existsSync(retired)) removeFiles(retired,archiveFiles);
      db.prepare('DELETE FROM copies WHERE name=?').run(saved.name);
    }
  } finally { db.close(); }
}

if (!isMainThread) await dailyCopy(workerData as BackupJob);
