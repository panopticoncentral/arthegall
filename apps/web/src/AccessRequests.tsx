import { useState } from 'react';
import type { Snapshot } from '../../../packages/contracts/src/index.js';
import { post } from './api.js';

export function AccessRequests({ snapshot, conversationId, disabled, refresh }: {
  snapshot: Snapshot; conversationId?: string; disabled: boolean; refresh: () => Promise<unknown>;
}) {
  const [error, setError] = useState('');
  return <>
        {snapshot.schedules.filter(s => (!conversationId || s.conversationId === conversationId) && s.state === 'pending').map(s =>
          <section className="approval" key={s.id}><h2>Recurring reporting access requested</h2>
            <p>Allow {s.name} to use the local runner and read_usage for this reporting assignment every day at {s.time} America/Los_Angeles? Each report covers the previous Pacific calendar day.</p>
            <p>{s.backfill ? 'After downtime, deliver every missed report.' : 'After downtime, deliver the latest report and record earlier missed dates.'} Access includes replies about saved evidence and lasts until the schedule is replaced or the assignment closes.</p>
            <p>Assignment {s.assignmentId} · Runner {s.runnerId}</p>
            {(['accept','decline'] as const).map(decision => <button key={decision} disabled={disabled} onClick={async () => {
              try { await post('/api/schedules/' + s.id, { decision }); setError(''); await refresh(); }
              catch (e) { setError(e instanceof Error ? e.message : 'Decision could not be saved'); }
            }}>{decision === 'accept' ? 'Allow recurring reports' : 'Decline schedule'}</button>)}</section>)}
        {snapshot.grants.filter((grant) => !conversationId || grant.conversationId === conversationId).map((grant) => <section className="approval" key={grant.id}>
          <h2>Reporting access requested</h2><p>{grant.name} needs the local runner and the read-only usage tool for its on-demand reporting assignment. The tool reads local Codex and Claude activity and returns aggregate counts and coverage.</p>
          <div>{(['assignment', 'run', 'decline'] as const).map((choice) => <button key={choice} disabled={disabled} onClick={async () => {
            try { await post('/api/access/' + grant.id, { decision: choice === 'decline' ? 'decline' : 'accept', duration: choice === 'run' ? 'run' : 'assignment' }); setError(''); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : 'Decision could not be saved'); }
          }}>{choice === 'assignment' ? 'Allow for this assignment' : choice === 'run' ? 'Allow next run only' : 'Decline'}</button>)}</div></section>)}
    {error && <p role="alert">{error}</p>}
  </>;
}
