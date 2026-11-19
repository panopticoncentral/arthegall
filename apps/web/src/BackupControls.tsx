import { useState } from 'react';
import type { DailyBackupStatus } from '../../../packages/contracts/src/index.js';

export function BackupControls({ status, save, retry, online, paused }: {
  status: DailyBackupStatus; save: (destination: string, keep: number, enabled: boolean) => Promise<void>;
  retry: () => Promise<void>; online: boolean; paused: boolean;
}) {
  const [destination, setDestination] = useState(status.destination);
  const [keep, setKeep] = useState(String(status.keep));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function act(operation: () => Promise<void>) {
    setError(''); setSaving(true);
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : 'Backup settings could not be saved'); }
    finally { setSaving(false); }
  }
  const disabled = !online || saving || status.running;
  return <div className="backup-settings">
    <p>{status.enabled ? 'Daily at 3:00 AM (' + status.timeZone + ')' : 'Off. Enabling takes the first backup immediately.'}</p>
    {status.lastPath && status.lastSuccess && <p>Last verified {new Date(status.lastSuccess).toLocaleString()} · <code>{status.lastPath}</code></p>}
    {paused && status.enabled ? <p>Daily backups will resume after restore reconciliation.</p> : status.running ? <p role="status">Checking backup and retention…</p> :
      status.enabled && status.nextDue !== null && <p>Next attempt {new Date(status.nextDue).toLocaleString()}</p>}
    <form onSubmit={e => { e.preventDefault(); void act(() => save(destination,Number(keep),true)); }}>
      <label>Backup folder on the server<input required value={destination} onChange={e => setDestination(e.target.value)} placeholder="Absolute path to an existing folder" /></label>
      <label>Daily copies to keep<input required type="number" min="1" value={keep} onChange={e => setKeep(e.target.value)} /></label>
      <button disabled={disabled}>{status.enabled ? 'Save backup settings' : 'Enable daily backups'}</button>
      {status.enabled && <button type="button" disabled={disabled} onClick={() => void act(() => save(status.destination,status.keep,false))}>Turn off daily backups</button>}
      {status.enabled && status.error && <button type="button" disabled={disabled} onClick={() => void act(retry)}>Retry daily backup</button>}
    </form>
    {error && <p role="alert">{error}</p>}
  </div>;
}
