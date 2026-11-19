import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { BackupControls } from './BackupControls.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import './style.css';

import { Snapshot } from '../../../packages/contracts/src/index.js';

const Pending = z.object({ commandId: z.string().uuid(), text: z.string(), conversationId: z.uuid().optional(), replyTo: z.uuid().optional() });
type Pending = z.infer<typeof Pending>;
function restorePending(): Pending | null {
  try { return Pending.parse(JSON.parse(sessionStorage.getItem('arthegall.pending') ?? 'null')); } catch { return null; }
}
async function post(path: string, data: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(await response.json());
    throw new Error(error.success ? error.data.error : 'Request failed');
  }
  return response;
}
function RunHistory({run, disabled, refresh}: {run: Snapshot['runs'][number]; disabled: boolean; refresh: () => Promise<unknown>}) {
  const [error,setError] = useState('');
  return <details className="original"><summary>Run details{run.pinned ? ' · Pinned' : ''}</summary>
    <p>Run {run.id}</p>
    {run.history === 'full' ? <button type="button" disabled={disabled} onClick={async () => {
      try { await post('/api/runs/' + run.id + '/pin',{pinned:!run.pinned}); setError(''); await refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : 'Pin could not be saved'); }
    }}>{run.pinned ? 'Unpin run' : 'Pin run'}</button> :
      <p>{run.history === 'pending' ? 'Cleanup awaiting runner confirmation' : 'Detailed execution history pruned'}</p>}
    {(error || run.historyError) && <p role="alert">{error || run.historyError}</p>}
  </details>;
}
function HistorySettings({days,disabled,refresh}: {days:number;disabled:boolean;refresh:()=>Promise<unknown>}) {
  const [value,setValue] = useState(String(days)), [error,setError] = useState('');
  return <section className="details backup-settings"><h2>Execution history</h2>
    <p>Pin a run under its message’s Run details to keep its execution history and dedicated workspace. Reports and recorded usage stay in the DM.</p>
    <form onSubmit={async e => {
      e.preventDefault();
      try { await post('/api/retention',{days:Number(value)}); setError(''); await refresh(); }
      catch (err) { setError(err instanceof Error ? err.message : 'Retention could not be saved'); }
    }}><label>Days to keep completed run details<input type="number" min="1" required value={value} onChange={e=>setValue(e.target.value)} /></label>
    <button disabled={disabled || Number(value) === days}>Save history retention</button></form>
    {error && <p role="alert">{error}</p>}
  </section>;
}
function RecordedUsage({ report }: { report: NonNullable<Snapshot['messages'][number]['evidence']> }) {
  const number = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString();
  return <details className="usage"><summary>Recorded usage · {report.range.start}{report.range.start !== report.range.end && ' – ' + report.range.end}</summary>
    <p>{report.timeZone} · Local runner records</p>
    {(['codex','claude'] as const).map((provider) => {
      const source = report[provider];
      return <div key={provider}><strong>{provider === 'codex' ? 'Codex' : 'Claude'}</strong>
        <p>{source.coverage === 'no_records' ? 'No local records' : source.coverage === 'partial' ? 'Partial coverage' : 'Recorded responses'} · {number(source.responses)} distinct responses found</p>
        <p>Input {number(source.input)} (cached {number(source.cachedInput)}) · Output {number(source.output)} (reasoning {number(source.reasoningOutput)}) · Total {number(source.total)}</p>
        <p>Actual spend {source.actualSpendUsd === null ? 'unavailable' : '$' + source.actualSpendUsd}</p>
        {source.notes.filter((note) => !note.startsWith('Actual spend')).map((note) => <p key={note}>{note}</p>)}
      </div>;
    })}</details>;
}
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [online, setOnline] = useState(false);
  const [code, setCode] = useState('');
  const [draft, setDraft] = useState(() => sessionStorage.getItem('arthegall.draft') ?? '');
  const [selected, setSelected] = useState(() => sessionStorage.getItem('arthegall.dm'));
  const [replyTo, setReplyTo] = useState<string | undefined>(() => sessionStorage.getItem('arthegall.reply') ?? undefined);
  const [pending, setPending] = useState<Pending | null>(restorePending);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [nav, setNav] = useState(false);
  const [activity, setActivity] = useState<string[] | null>(null);
  const [connections, setConnections] = useState(false);
  const cursor = useRef(0), socket = useRef<WebSocket | null>(null);
  const navButton = useRef<HTMLButtonElement>(null), composer = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const started = generation.current;
    try {
      const response = await fetch('/api/snapshot');
      if (response.status === 401) {
        setPaired(false); setSnapshot(null); setOnline(true); socket.current?.close(); cursor.current = 0;
        return null;
      }
      if (!response.ok) throw new Error('Server unavailable');
      const next = Snapshot.parse(await response.json());
      if (started !== generation.current) return null;
      if (next.cursor >= cursor.current) { cursor.current = next.cursor; setSnapshot(next); }
      setPaired(true); setOnline(true);
      return next;
    } catch { setOnline(false); return null; }
  }, []);
  useEffect(() => {
    let disposed = false, connecting = false;
    const connect = async () => {
      if (disposed || connecting || (socket.current?.readyState === WebSocket.OPEN || socket.current?.readyState === WebSocket.CONNECTING)) return;
      connecting = true;
      generation.current++; cursor.current = 0; // A restored server may have an earlier event cursor.
      const next = await refresh();
      if (next && !disposed) {
        const url = new URL('/events', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('after', String(next.cursor));
        const ws = new WebSocket(url); socket.current = ws;
        ws.onmessage = () => { void refresh(); };
        ws.onclose = () => { if (!disposed && socket.current === ws) setOnline(false); };
        ws.onerror = () => ws.close();
      }
      connecting = false;
    };
    void connect();
    const timer = setInterval(() => { void connect(); }, 2_000);
    return () => { disposed = true; clearInterval(timer); socket.current?.close(); };
  }, [refresh]);
  useEffect(() => { sessionStorage.setItem('arthegall.draft', draft); }, [draft]);
  const dm = snapshot?.conversations.find((item) => item.id === selected) ?? snapshot?.conversations[0];
  const schedule = snapshot?.schedules.find(s => s.conversationId === dm?.id && s.state === 'active');
  const messages = snapshot?.messages.filter((message) => message.conversationId === dm?.id) ?? [];
  const runsByMessage = new Map(snapshot?.runs.map(run => [run.messageId,run]));
  function choose(id: string) {
    if (id !== dm?.id) {
      sessionStorage.setItem('arthegall.draft.' + dm?.id, draft);
      setDraft(sessionStorage.getItem('arthegall.draft.' + id) ?? '');
      setReplyTo(undefined); sessionStorage.removeItem('arthegall.reply');
    }
    setSelected(id); sessionStorage.setItem('arthegall.dm', id);
    setNav(false); setError(''); composer.current?.focus();
  }
  async function send() {
    const command = pending ?? { commandId: crypto.randomUUID(), text: draft.trim(), conversationId: dm?.id, replyTo };
    if (!command.text || sending || !online) return;
    setPending(command); sessionStorage.setItem('arthegall.pending', JSON.stringify(command));
    setSending(true); setError('');
    try {
      await post('/api/messages', command);
      setDraft(''); setReplyTo(undefined); sessionStorage.removeItem('arthegall.reply'); sessionStorage.removeItem('arthegall.draft.' + dm?.id); setPending(null); sessionStorage.removeItem('arthegall.pending');
      await refresh(); composer.current?.focus();
    } catch (e) { setError(e instanceof Error ? e.message : 'Sending failed. Retry this message.'); }
    finally { setSending(false); }
  }
  async function decide(id: string, decision: 'accept' | 'decline') {
    try { await post(`/api/approvals/${id}`, { decision }); setError(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Decision could not be saved'); }
  }
  const provider = snapshot?.runners[0]?.status;
  const status = !online ? 'Server unavailable' : !snapshot?.runnerConnected ? 'Runner disconnected' : provider === 'sign_in_needed' ? 'Codex sign-in needed' : provider === 'unavailable' ? 'Checking Codex' : 'Connected';
  if (paired === false) return <main className="pair"><div className="brand">a<span>Arthegall</span></div><h1>Pair this browser</h1><p>Enter the pairing code from your server’s setup command.</p><form onSubmit={async (e) => {
    e.preventDefault(); setError('');
    try { await post('/api/pair', { code }); setCode(''); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Pairing failed'); }
  }}><label htmlFor="code">Pairing code</label><input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoFocus required /><button className="primary" disabled={!online}>Pair browser</button></form>{error && <p role="alert">{error}</p>}</main>;
  if (!snapshot || !dm) return <main className="pair"><h1>Arthegall</h1><p role="status">{online ? 'Loading your conversations…' : 'Connecting to your server…'}</p></main>;
  return <div className="app">
    <aside className={nav ? 'rail visible' : 'rail'} aria-label="Conversation navigation" onKeyDown={(e) => { if (e.key === 'Escape') { setNav(false); navButton.current?.focus(); } }}>
      <div className="brand">a<span>Arthegall</span></div><p className="section-label">DIRECT MESSAGES</p>
      {snapshot.conversations.map((item) => <button key={item.id} className={dm.id === item.id ? 'selected' : ''} aria-label={item.name} aria-current={dm.id === item.id ? 'page' : undefined} disabled={Boolean(pending) || sending} onClick={() => choose(item.id)}><span className="avatar small">{item.name.charAt(0)}</span>{item.name}</button>)}
      <div className="rail-bottom"><button onClick={() => setConnections(!connections)}>Connections</button><span className="muted">Your agents, working together.</span></div>
    </aside>
    <main className="conversation">
      <header><button className="nav-toggle" ref={navButton} aria-expanded={nav} aria-label="Open conversations" onClick={() => setNav(!nav)}>☰</button><div className="avatar">{dm.name.charAt(0)}</div><div><h1>{dm.name}</h1><p className="muted">{dm.administrator ? 'Setup and coordination' : dm.closed ? 'Closed reporting assignment' : schedule ? `Daily usage reporting · ${schedule.time} Pacific` : 'On-demand usage reporting'}</p></div><button className="activity-toggle" aria-expanded={activity !== null} onClick={async () => {
        if (activity) { setActivity(null); return; }
        try {
          const response = await fetch('/api/activity');
          const rows = z.array(z.object({ kind: z.string(), data: z.string() })).parse(await response.json());
          setActivity(rows.map((row) => { const data = z.object({ message: z.string().optional() }).safeParse(JSON.parse(row.data)); return data.success && data.data.message ? data.data.message : row.kind.replaceAll('_', ' '); }));
        } catch { setError('Activity is temporarily unavailable'); }
      }}>Activity</button></header>
      <div className="status" role="status"><span className={status === 'Connected' ? 'dot connected' : 'dot'} />{status}{!snapshot.runnerConnected && snapshot.runs.some((run) => ['accepted', 'running', 'approval'].includes(run.state)) && ' · Existing work has an unknown outcome'}</div>
      {snapshot.backups?.enabled && snapshot.backups.error && <div className="details" role="alert">
        <strong>Daily backup needs attention</strong><p>{snapshot.backups.error}</p>
        {!connections && <button onClick={() => setConnections(true)}>Open backup settings</button>}
      </div>}
      {connections && <HistorySettings key={snapshot.retentionDays} days={snapshot.retentionDays} disabled={!online || Boolean(snapshot.recovery)} refresh={refresh} />}
      {connections && snapshot.backups && <BackupControls key={JSON.stringify([snapshot.backups.destination,snapshot.backups.keep,snapshot.backups.enabled])}
        status={snapshot.backups} online={online} paused={Boolean(snapshot.recovery)}
        save={async (destination,keep,enabled) => { await post('/api/backups/settings',{destination,keep,enabled}); await refresh(); }}
        retry={async () => { await post('/api/backups/retry',{}); await refresh(); }} />}
      {snapshot.recovery && <section className="approval" aria-label="Restore recovery">
        <h2>Dispatch paused after restore</h2>
        {snapshot.recovery.runners.map(r => <p key={r.id}>Runner {r.id} · {r.status === 'offline' ? 'Offline — waiting for reconnect' : r.status === 'unsupported' ? 'Update the runner to check its durable records' : r.status === 'checking' ? 'Checking durable records' : 'Inventory checked'}</p>)}
        {snapshot.recovery.issues.map(issue => <p key={issue.runId}>Run {issue.runId} · {issue.reason}</p>)}
        {snapshot.recovery.ready && <p>All runner records agree. Dispatch can safely resume.</p>}
        {(['resume','recheck'] as const).map(action => <button key={action} disabled={!online || (action === 'resume' && !snapshot.recovery?.ready)}
          onClick={async () => {
            try { await post('/api/recovery/' + action, {}); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : 'Recovery request failed'); }
          }}>{action === 'resume' ? 'Resume dispatch' : 'Check runners again'}</button>)}
      </section>}
      {connections && <section className="details"><h2>Local runner</h2><p>{snapshot.runnerConnected ? 'Connected to the server' : 'Waiting for the runner to reconnect'}</p><p>Codex: {provider === 'sign_in_needed' ? 'Run codex login on the runner, then return here. Queued messages will wait.' : provider === 'ready' ? 'Ready' : 'Availability is checked when work starts.'}</p>{!dm.administrator && !dm.closed && <button disabled={Boolean(snapshot.recovery)} onClick={async () => {
        if (!window.confirm('Close this reporting assignment and end its access? Its conversation and reports will remain available.')) return;
        try { await post('/api/conversations/' + dm.id + '/close', {}); await refresh(); }
        catch (e) { setError(e instanceof Error ? e.message : 'Could not close assignment'); }
      }}>Close reporting assignment</button>}<button onClick={async () => { await post('/api/revoke', {}); await refresh(); }}>Unpair this browser</button></section>}
      {activity && <section className="details" aria-label="Activity"><h2>Activity</h2><ol>{activity.map((line, index) => <li key={index}>{line}</li>)}</ol></section>}
      <section className="messages" aria-label="Conversation messages">
        {messages.length === 0 && <div className="welcome"><h2>{dm.administrator ? 'Your administrator is here.' : 'Usage reports appear here.'}</h2><p>Start a conversation. Your history stays with Arthegall.</p></div>}
        {messages.map((message) => <article key={message.id} className="message">
          <span className={`avatar ${message.author === 'user' ? 'user' : ''}`}>{message.author === 'user' ? 'Y' : dm.name.charAt(0)}</span>
          <div>
            <strong>{message.requestedReport ? 'Report request' : message.author === 'user' ? 'You' : dm.name}</strong>
            {message.text && message.state !== 'streaming'
              ? <MessageMarkdown text={message.text} />
              : <p className="message-text plain">{message.text || (message.state === 'awaiting_access' ? 'Waiting for your access decision…' : message.state === 'queued' ? 'Queued for the runner…' : 'Working…')}</p>}
            {!['completed', 'complete'].includes(message.state) && <span className="message-state">{message.state === 'streaming' ? 'Responding…' : message.state.replaceAll('_', ' ')}</span>}
            {message.evidence && <>
              <details className="original"><summary>Original message text</summary><pre>{message.text}</pre></details>
              <RecordedUsage report={message.evidence} />
              <button type="button" disabled={Boolean(pending)} onClick={() => { setReplyTo(message.id); sessionStorage.setItem('arthegall.reply', message.id); composer.current?.focus(); }}>Reply to report</button>
            </>}
            {runsByMessage.has(message.id) && <RunHistory run={runsByMessage.get(message.id)!}
              disabled={!online || Boolean(snapshot.recovery)} refresh={refresh} />}
          </div>
        </article>)}
        {snapshot.schedules.filter(s => (dm.administrator || s.conversationId === dm.id) && s.state === 'pending').map(s =>
          <section className="approval" key={s.id}><h2>Recurring reporting access requested</h2>
            <p>Allow {s.name} to use the local runner and read_usage for this reporting assignment every day at {s.time} America/Los_Angeles? Each report covers the previous Pacific calendar day.</p>
            <p>{s.backfill ? 'After downtime, deliver every missed report.' : 'After downtime, deliver the latest report and record earlier missed dates.'} Access includes replies about saved evidence and lasts until the schedule is replaced or the assignment closes.</p>
            <p>Assignment {s.assignmentId} · Runner {s.runnerId}</p>
            {(['accept','decline'] as const).map(decision => <button key={decision} disabled={!online || Boolean(snapshot.recovery)} onClick={async () => {
              try { await post('/api/schedules/' + s.id, { decision }); setError(''); await refresh(); }
              catch (e) { setError(e instanceof Error ? e.message : 'Decision could not be saved'); }
            }}>{decision === 'accept' ? 'Allow recurring reports' : 'Decline schedule'}</button>)}</section>)}
        {snapshot.grants.filter((grant) => dm.administrator || grant.conversationId === dm.id).map((grant) => <section className="approval" key={grant.id}>
          <h2>Reporting access requested</h2><p>{grant.name} needs the local runner and the read-only usage tool for its on-demand reporting assignment. The tool reads local Codex and Claude activity and returns aggregate counts and coverage.</p>
          <div>{(['assignment', 'run', 'decline'] as const).map((choice) => <button key={choice} disabled={!online || Boolean(snapshot.recovery)} onClick={async () => {
            try { await post('/api/access/' + grant.id, { decision: choice === 'decline' ? 'decline' : 'accept', duration: choice === 'run' ? 'run' : 'assignment' }); setError(''); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : 'Decision could not be saved'); }
          }}>{choice === 'assignment' ? 'Allow for this assignment' : choice === 'run' ? 'Allow next run only' : 'Decline'}</button>)}</div></section>)}
        {snapshot.approvals.filter((approval) => approval.conversationId === dm.id).map((approval) => <section className="approval" key={approval.id}><h2>Approval needed</h2><p>The agent is waiting for your decision on this operation.</p><pre>{approval.command}</pre><div><button className="primary" disabled={!online || Boolean(snapshot.recovery)} onClick={() => void decide(approval.id, 'accept')}>Approve once</button><button disabled={!online || Boolean(snapshot.recovery)} onClick={() => void decide(approval.id, 'decline')}>Decline</button></div></section>)}
      </section>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>{replyTo && <p>Replying to the report for {messages.find((m) => m.id === replyTo)?.evidence?.range.start} <button type="button" onClick={() => { setReplyTo(undefined); sessionStorage.removeItem('arthegall.reply'); }}>Cancel reply</button></p>}<label htmlFor="message">Message {dm.name}</label><textarea id="message" ref={composer} value={pending?.text ?? draft} disabled={Boolean(pending || dm.closed)} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder={`Message ${dm.name}…`} rows={3} maxLength={16000} /><div className="composer-footer"><span className="muted">{!online ? 'Your draft is kept here until the server reconnects.' : pending ? 'Retry uses the same message to prevent duplicates.' : 'Enter to send · Shift + Enter for a new line'}</span><button className="primary" disabled={Boolean(dm.closed) || !online || sending || !(pending?.text || draft.trim())}>{sending ? 'Sending…' : pending ? 'Retry send' : snapshot.runnerConnected && !snapshot.recovery ? 'Send' : 'Queue message'}</button></div>{error && <p className="error" role="alert">{error}</p>}</form>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
