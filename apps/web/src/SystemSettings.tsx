import { useState } from 'react';
import type { Snapshot } from '../../../packages/contracts/src/index.js';
import { BackupControls } from './BackupControls.js';
import { post } from './api.js';

function HistorySettings({days,disabled,refresh}: {days:number;disabled:boolean;refresh:()=>Promise<unknown>}) {
  const [value,setValue] = useState(String(days)), [error,setError] = useState('');
  return <div className="backup-settings">
    <p>Pin a run under its message’s Run details to keep its execution history and dedicated workspace. Reports and recorded usage stay in the DM.</p>
    <form onSubmit={async e => {
      e.preventDefault();
      try { await post('/api/retention',{days:Number(value)}); setError(''); await refresh(); }
      catch (err) { setError(err instanceof Error ? err.message : 'Retention could not be saved'); }
    }}><label>Days to keep completed run details<input type="number" min="1" required value={value} onChange={e=>setValue(e.target.value)} /></label>
    <button disabled={disabled || Number(value) === days}>Save history retention</button></form>
    {error && <p role="alert">{error}</p>}
  </div>;
}
export function SystemSettings({snapshot,online,refresh}: {snapshot:Snapshot; online:boolean; refresh:()=>Promise<unknown>}) {
  const [error,setError] = useState('');
  const [backupOpen,setBackupOpen] = useState(Boolean(snapshot.backups?.error));
  const provider = snapshot.runners[0]?.status;
  return <>
    <h1>System settings</h1><p>Connections and data policies for this installation.</p>
    <section className="details"><h2>Connections</h2><strong>Local runner</strong>
      <p>{snapshot.runnerConnected ? 'Connected to the server' : 'Waiting for the runner to reconnect'}</p>
      <p>Codex · {!snapshot.runnerConnected ? 'Status available when the runner reconnects.' : provider === 'sign_in_needed' ? 'Run codex login on the runner, then return here.' : provider === 'ready' ? 'Ready' : 'Availability is checked when work starts.'}</p>
      <details><summary>Paired browsers ({snapshot.pairings.length})</summary>
        <ul>{snapshot.pairings.map((p,i)=><li key={i}>{p.current ? 'This browser' : 'Other browser'} · Pairing expires {new Date(p.expires).toLocaleString()}</li>)}</ul>
      </details>
      <button disabled={!online} onClick={async () => {
        try { await post('/api/revoke',{}); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not unpair browser'); }
      }}>Unpair this browser</button>{error && <p role="alert">{error}</p>}
    </section>
    <h2>Data and history</h2>
    <div className="system-policies">
      {snapshot.backups && <details open={backupOpen} onToggle={e => setBackupOpen(e.currentTarget.open)}>
        <summary>Daily server backups <span>{snapshot.backups.enabled ? 'Daily · Keep ' + snapshot.backups.keep + ' copies' : 'Off'}</span></summary>
        <BackupControls key={JSON.stringify([snapshot.backups.destination,snapshot.backups.keep,snapshot.backups.enabled])}
          status={snapshot.backups} online={online} paused={Boolean(snapshot.recovery)}
          save={async (destination,keep,enabled) => { await post('/api/backups/settings',{destination,keep,enabled}); await refresh(); }}
          retry={async () => { await post('/api/backups/retry',{}); await refresh(); }} />
      </details>}
      <details><summary>Execution history <span>Keep run details for {snapshot.retentionDays} days</span></summary>
        <HistorySettings key={snapshot.retentionDays} days={snapshot.retentionDays} disabled={!online || Boolean(snapshot.recovery)} refresh={refresh} />
      </details>
    </div>
  </>;
}
