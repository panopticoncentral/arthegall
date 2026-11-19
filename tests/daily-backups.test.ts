import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DailyBackups, openCatalog } from '../scripts/daily-backups.js';
import { ServerStore } from '../apps/server/src/store.js';

test('daily schedule catches up once across downtime, retries durably, and rotates only verified owned copies', async () => {
  const root = mkdtempSync(join(tmpdir(),'arthegall-daily-'));
  const destination = join(root,'backups'), second = join(root,'second');
  mkdirSync(destination); mkdirSync(second);
  const store = new ServerStore(join(root,'server','server.sqlite'));
  const { serverId } = store.setup('synthetic-token');
  let now = new Date(2025,2,8,10), paused = false;
  const open = () => new DailyBackups(root,serverId,[join(root,'server')],()=>paused,()=>{},()=>now);
  let service = open();
  try {
    service.configure({destination,keep:2,enabled:true});
    const firstAttempt = service.tick(); assert.ok(firstAttempt);
    assert.equal(firstAttempt,service.tick());
    await firstAttempt;
    const first = service.status().lastPath!;
    assert.equal(service.status().error,null);
    assert.equal(service.status().nextDue,new Date(2025,2,9,3).getTime());
    await service.close(); service = open();
    assert.equal(service.tick(),undefined);
    now = new Date(2025,2,12,8);
    paused = true; assert.equal(service.tick(),undefined);
    paused = false; renameSync(destination,second + '-offline');
    await service.tick();
    assert.match(service.status().error!,/unavailable/);
    assert.equal(service.status().lastPath,first);
    await service.close(); service = open();
    assert.equal(service.tick(),undefined);
    renameSync(second + '-offline',destination);
    now = new Date(now.getTime() + 15*60_000);
    await service.tick();
    const middle = service.status().lastPath!;
    assert.equal(readdirSync(destination).length,2);
    assert.notEqual(first,middle);
    assert.equal(service.status().error,null);
    // Damage a kept archive. The oldest healthy copy must survive rotation failure.
    renameSync(join(middle,'server.sqlite'),join(middle,'aside'));
    now = new Date(2025,2,13,3);
    await service.tick();
    assert.ok(service.status().error);
    assert.equal(existsSync(first),true);
    renameSync(join(middle,'aside'),join(middle,'server.sqlite'));
    // An unexpected extra file is never removed during pruning.
    writeFileSync(join(first,'operator-note'),'synthetic');
    service.retry(); await service.tick();
    assert.match(service.status().error!,/Unexpected files/);
    assert.equal(existsSync(join(first,'operator-note')),true);
    rmSync(join(first,'operator-note'));
    service.retry(); await service.tick();
    assert.equal(service.status().error,null);
    assert.equal(existsSync(first),false);
    assert.equal(readdirSync(destination).length,2);
    service.configure({destination:second,keep:1,enabled:true});
    await service.tick();
    assert.equal(readdirSync(destination).length,2);
    assert.equal(readdirSync(second).length,1);
    const catalog = openCatalog(root);
    // The archive was published, but the process died before recording its checksum.
    try { catalog.prepare('UPDATE copies SET sha256=NULL WHERE name=?').run(readdirSync(second)[0]); } finally { catalog.close(); }
    service.retry(); await service.tick();
    assert.equal(service.status().error,null);
    assert.equal(readdirSync(second).length,1);
    service.configure({destination:second,keep:1,enabled:false});
    now = new Date(2025,3,1,10);
    assert.equal(service.tick(),undefined);
  } finally { await service.close(); store.close(); rmSync(root,{recursive:true,force:true}); }
});
