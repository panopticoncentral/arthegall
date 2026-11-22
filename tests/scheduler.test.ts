import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServerStore } from '../apps/server/src/store.js';
import { reportingUpgrade } from './helpers/reporting-upgrade.js';
import { readUsage } from '../apps/runner/src/usage.js';

test('scheduled work cannot renew a one-run usage grant and replaying evidence is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-schedule-grant-'));
  const old = await reportingUpgrade(root);
  let clock = new Date('2020-07-01T00:00:00Z');
  const store = new ServerStore(old.serverPath, () => clock);
  try {
    store.db.prepare("UPDATE report_access SET duration='run', used_by=? WHERE id=?").run(old.run,old.grant);
    store.scheduler.operate(old.assignment, old.ids.runner, {tool: 'schedule_item', args: {
      instruction: 'Report June usage', when: {kind: 'after',seconds: 60}, missed: 'latest' }});
    clock = new Date('2020-07-01T00:01:00Z');
    store.scheduler.tick();
    assert.equal(store.nextDispatch(old.ids.runner), undefined);
    const approval = store.snapshot().grants[0] as { id: string };
    store.reporting.decide(old.session, approval.id, 'accept','run');
    const dispatch = store.nextDispatch(old.ids.runner)!;
    assert.equal(dispatch.context.access?.approvalId, approval.id);
    const range = {start:'2020-06-01',end:'2020-06-30'};
    const report = await readUsage(range, old.roots);
    const delivery = {type:'delivery',version:1,runId:dispatch.context.runId,deliveryId:randomUUID(),sequence:1,event:{kind:'usage',report}};
    store.receive(old.ids.runner, delivery);
    store.receive(old.ids.runner, delivery);
    assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT requested_range FROM report_context WHERE run_id=?').pluck().get(dispatch.context.runId))), range);
    assert.equal(store.db.prepare('SELECT used_by FROM report_access WHERE id=?').pluck().get(approval.id),dispatch.context.runId);
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});
