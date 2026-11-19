import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServerStore } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import type { Scan } from '../apps/server/src/restore-recovery.js';

for (const conflict of ['approval','outcome','interrupted'] as const) {
  test('restore reports the run and holds dispatch for ' + conflict, () => {
    const root = mkdtempSync(join(tmpdir(),'arthegall-decision-'));
    const server = new ServerStore(join(root,'server.sqlite'));
    const { runnerId } = server.setup('synthetic-token');
    const session = server.pair(server.createPairingCode(),'synthetic')!;
    const runner = new RunnerStore(join(root,'runner.sqlite'),runnerId);
    try {
      const { runId } = server.send(session.id,{commandId:randomUUID(),text:'Synthetic request'});
      const dispatch = runner.accept(server.nextDispatch(runnerId));
      server.accept(runnerId,dispatch.dispatchId);
      runner.start(runId);
      if (conflict === 'approval') {
        const approvalId = randomUUID();
        runner.publish(runId,{kind:'approval',approval:{approvalId,command:'Synthetic approval request'}});
        server.receive(runnerId,runner.nextDelivery());
        server.decide(session.id,approvalId,'decline');
        runner.decision({type:'decision',version:1,runId,approvalId,decision:'accept'});
      }
      server.recovery.initialize();
      const outcome = conflict === 'interrupted' ? {status:'blocked' as const,message:'Synthetic uncertain outcome'}
        : {status:'completed' as const,message:'Synthetic result'};
      runner.finish(runId,outcome);
      if (conflict === 'outcome')
        runner.db.prepare('UPDATE executions SET outcome=? WHERE run_id=?').run(JSON.stringify({...outcome,message:'Conflicting synthetic result'}),runId);
      function check() {
        server.recovery.begin(runnerId);
        const scan: Scan = {received:0,failed:false};
        for (const item of runner.inventory()) server.recovery.apply(runnerId,scan,item);
        const status = server.recovery.status()!;
        assert.equal(status.ready,false);
        assert.deepEqual(status.issues.map(i=>i.runId),[runId]);
        assert.match(status.issues[0]!.reason,conflict === 'approval' ? /Approval decision conflicts/ : conflict === 'outcome' ? /Terminal delivery differs/ : /uncertain/);
        assert.throws(()=>server.recovery.resume(),/needs attention/);
        assert.equal(server.nextDispatch(runnerId),undefined);
      }
      check();
      server.recovery.initialize(); // A backup taken during the pause retains the reason.
      check();
    } finally { runner.close(); server.close(); rmSync(root,{recursive:true,force:true}); }
  });
}
