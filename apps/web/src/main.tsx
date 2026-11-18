import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import './style.css';

import { Snapshot } from '../../../packages/contracts/src/index.js';

const Pending = z.object({ commandId: z.string().uuid(), text: z.string() });
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
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [online, setOnline] = useState(false);
  const [code, setCode] = useState('');
  const [draft, setDraft] = useState(() => sessionStorage.getItem('arthegall.draft') ?? '');
  const [pending, setPending] = useState<Pending | null>(restorePending);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [nav, setNav] = useState(false);
  const [activity, setActivity] = useState<string[] | null>(null);
  const [connections, setConnections] = useState(false);
  const cursor = useRef(0), socket = useRef<WebSocket | null>(null);
  const navButton = useRef<HTMLButtonElement>(null), composer = useRef<HTMLTextAreaElement>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/snapshot');
      if (response.status === 401) {
        setPaired(false); setSnapshot(null); setOnline(true); socket.current?.close(); cursor.current = 0;
        return null;
      }
      if (!response.ok) throw new Error('Server unavailable');
      const next = Snapshot.parse(await response.json());
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
  async function send() {
    const command = pending ?? { commandId: crypto.randomUUID(), text: draft.trim() };
    if (!command.text || sending || !online) return;
    setPending(command); sessionStorage.setItem('arthegall.pending', JSON.stringify(command));
    setSending(true); setError('');
    try {
      await post('/api/messages', command);
      setDraft(''); setPending(null); sessionStorage.removeItem('arthegall.pending');
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
  if (!snapshot) return <main className="pair"><h1>Arthegall</h1><p role="status">{online ? 'Loading your conversations…' : 'Connecting to your server…'}</p></main>;
  return <div className="app">
    <aside className={nav ? 'rail visible' : 'rail'} aria-label="Conversation navigation" onKeyDown={(e) => { if (e.key === 'Escape') { setNav(false); navButton.current?.focus(); } }}>
      <div className="brand">a<span>Arthegall</span></div><p className="section-label">DIRECT MESSAGES</p>
      <button className="selected" aria-label="Administrator" aria-current="page" onClick={() => { setNav(false); composer.current?.focus(); }}><span className="avatar small">A</span>Administrator</button>
      <div className="rail-bottom"><button onClick={() => setConnections(!connections)}>Connections</button><span className="muted">Your agents, working together.</span></div>
    </aside>
    <main className="conversation">
      <header><button className="nav-toggle" ref={navButton} aria-expanded={nav} aria-label="Open conversations" onClick={() => setNav(!nav)}>☰</button><div className="avatar">A</div><div><h1>Administrator</h1><p className="muted">Setup and coordination</p></div><button className="activity-toggle" aria-expanded={activity !== null} onClick={async () => {
        if (activity) { setActivity(null); return; }
        try {
          const response = await fetch('/api/activity');
          const rows = z.array(z.object({ kind: z.string(), data: z.string() })).parse(await response.json());
          setActivity(rows.map((row) => { const data = z.object({ message: z.string().optional() }).safeParse(JSON.parse(row.data)); return data.success && data.data.message ? data.data.message : row.kind.replaceAll('_', ' '); }));
        } catch { setError('Activity is temporarily unavailable'); }
      }}>Activity</button></header>
      <div className="status" role="status"><span className={status === 'Connected' ? 'dot connected' : 'dot'} />{status}{!snapshot.runnerConnected && snapshot.runs.some((run) => ['accepted', 'running', 'approval'].includes(run.state)) && ' · Existing work has an unknown outcome'}</div>
      {connections && <section className="details"><h2>Local runner</h2><p>{snapshot.runnerConnected ? 'Connected to the server' : 'Waiting for the runner to reconnect'}</p><p>Codex: {provider === 'sign_in_needed' ? 'Run codex login on the runner, then return here. Queued messages will wait.' : provider === 'ready' ? 'Ready' : 'Availability is checked when work starts.'}</p><button onClick={async () => { await post('/api/revoke', {}); await refresh(); }}>Unpair this browser</button></section>}
      {activity && <section className="details" aria-label="Activity"><h2>Activity</h2><ol>{activity.map((line, index) => <li key={index}>{line}</li>)}</ol></section>}
      <section className="messages" aria-label="Conversation messages">
        {snapshot.messages.length === 0 && <div className="welcome"><h2>Your administrator is here.</h2><p>Start a conversation. Your history stays with Arthegall.</p></div>}
        {snapshot.messages.map((message) => <article key={message.id} className="message"><span className={`avatar ${message.author === 'user' ? 'user' : ''}`}>{message.author === 'user' ? 'Y' : 'A'}</span><div><strong>{message.author === 'user' ? 'You' : 'Administrator'}</strong><p className="message-text">{message.text || (message.state === 'queued' ? 'Queued for the runner…' : 'Working…')}</p>{!['completed', 'complete'].includes(message.state) && <span className="message-state">{message.state === 'streaming' ? 'Responding…' : message.state.replaceAll('_', ' ')}</span>}</div></article>)}
        {snapshot.approvals.map((approval) => <section className="approval" key={approval.id}><h2>Approval needed</h2><p>The agent is waiting for your decision on this operation.</p><pre>{approval.command}</pre><div><button className="primary" disabled={!online} onClick={() => void decide(approval.id, 'accept')}>Approve once</button><button disabled={!online} onClick={() => void decide(approval.id, 'decline')}>Decline</button></div></section>)}
      </section>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}><label htmlFor="message">Message Administrator</label><textarea id="message" ref={composer} value={pending?.text ?? draft} disabled={Boolean(pending)} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder="Message Administrator…" rows={3} maxLength={16000} /><div className="composer-footer"><span className="muted">{!online ? 'Your draft is kept here until the server reconnects.' : pending ? 'Retry uses the same message to prevent duplicates.' : 'Enter to send · Shift + Enter for a new line'}</span><button className="primary" disabled={!online || sending || !(pending?.text || draft.trim())}>{sending ? 'Sending…' : pending ? 'Retry send' : snapshot.runnerConnected ? 'Send' : 'Queue message'}</button></div>{error && <p className="error" role="alert">{error}</p>}</form>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
