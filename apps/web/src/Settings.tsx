import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/contracts/src/index.js';
import { ReportingSettings, zone } from '../../../packages/contracts/src/reporting.js';
import { SystemSettings } from './SystemSettings.js';
import { AccessRequests } from './AccessRequests.js';
import { post, settingsPath } from './api.js';

type Conversation = Snapshot['conversations'][number];
type PageProps = { snapshot: Snapshot; online: boolean; refresh: () => Promise<unknown> };
type OpenDM = (id: string, messageId?: string) => void;

export default function Settings({ path, currentDM, navigationLocked, openDM, ...props }: PageProps & {
  path: string; currentDM: string; navigationLocked: boolean; openDM: OpenDM;
}) {
  const match = /^#settings\/agents\/([^/]+)(\/assignment)?$/.exec(path);
  const agents = props.snapshot.conversations.filter(dm => !dm.administrator);
  const dm = agents.find(item => item.id === match?.[1]);
  const assignment = Boolean(match?.[2]);
  const list = path === '#settings/agents';
  const system = path === '#settings/system';
  return <div className="settings-page">
    <nav className="settings-nav" aria-label="Settings navigation">
      <a href="#settings/system" aria-current={system ? 'page' : undefined}>System</a>
      <a href="#settings/agents" aria-current={list ? 'page' : undefined}>Agents</a>
      {dm && <><span aria-hidden="true">/</span><a href={settingsPath(dm.id)} aria-current={!assignment ? 'page' : undefined}>{dm.name}</a></>}
      {dm && assignment && <><span aria-hidden="true">/</span><span aria-current="page">Assignment</span></>}
    </nav>
    {system ? <SystemSettings {...props}/> : list ? <>
      <h1>Agents</h1><p>Reporting agent definitions, access and assignments.</p>
      {agents.length ? <ul className="settings-list">{agents.map(item => <li key={item.id}>
        <a href={settingsPath(item.id)}>{item.name}</a><span>{item.closed ? 'Closed reporting assignment' : 'Reporting agent'}</span>
      </li>)}</ul> : <p>Ask the Administrator to create a reporting agent.</p>}
    </> : dm ? <ReporterSettings key={dm.id} {...props} dm={dm} assignment={assignment}
      openDM={openDM} canOpenDM={!navigationLocked || currentDM === dm.id}/> : <p>This settings page is unavailable.</p>}
    <button className="return-to-dm" onClick={() => openDM(currentDM)}>Back to conversation</button>
  </div>;
}

function ReporterSettings({dm, assignment, snapshot, online, refresh, openDM, canOpenDM}: PageProps & {
  dm: Conversation; assignment: boolean; openDM: OpenDM; canOpenDM: boolean;
}) {
  const [details,setDetails] = useState<ReportingSettings | null>(null);
  const [loadError,setLoadError] = useState('');
  const [reload,setReload] = useState(0);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [edit,setEdit] = useState<{revision:number; text:string} | null>(null);
  const [proposal,setProposal] = useState<{activeId:string | null; time:string; backfill:boolean} | null>(null);
  const base = '/api/conversations/' + dm.id;
  const schedules = snapshot.schedules.filter(s => s.conversationId === dm.id);
  const active = schedules.find(s => s.state === 'active');
  const pending = schedules.find(s => s.state === 'pending');
  const disabled = !online || Boolean(snapshot.recovery) || Boolean(dm.closed) || busy;
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      try {
        const response = await fetch(base + '/settings', {signal:controller.signal});
        if (!response.ok) throw new Error('Settings could not be loaded.');
        const data = ReportingSettings.parse(await response.json());
        if (!controller.signal.aborted) { setDetails(data); setLoadError(''); }
      } catch {
        if (!controller.signal.aborted) setLoadError('Settings could not be loaded.');
      }
    }
    void read();
    return () => controller.abort();
  }, [base, snapshot.cursor, online, reload]);
  useEffect(() => {
    setError(''); setEdit(null); setProposal(null);
    title.current?.focus();
  }, [assignment]);

  async function save(action: string, body: unknown) {
    setBusy(true); setError('');
    try {
      await post(base + '/' + action, body);
      await refresh(); setReload(value => value + 1);
      setEdit(null); setProposal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Change could not be saved.');
      setReload(value => value + 1);
    } finally { setBusy(false); }
  }
  const assignmentName = active || pending ? 'Daily usage report' : 'Usage reporting assignment';
  const access = details && <>
    {details.access.map((grant,i) => <p key={i}>Local runner · read_usage · {grant.duration === 'assignment'
      ? 'Approved until this assignment closes' : grant.usedBy ? 'Approved for the current run only' : 'Approved for the next run only'}</p>)}
    {active && <p>Local runner · read_usage · Approved for each scheduled run and replies about its results</p>}
    {!details.access.length && !active && <p>{dm.closed ? 'Access ended when this assignment closed.' : 'No current grant.'}</p>}
  </>;
  return <>
    <h1 ref={title} tabIndex={-1}>{assignment ? assignmentName : dm.name}</h1>
    <p>{assignment ? <>Owned by <a href={settingsPath(dm.id)}>{dm.name}</a> · {dm.closed ? 'Closed' : 'Open'}</> : 'Reporting agent'}</p>
    {loadError && <p role="alert">{loadError} <button onClick={()=>setReload(v=>v+1)}>Retry</button></p>}
    {!details && !loadError && <p role="status">Loading settings…</p>}
    {details && (assignment ? <>
      <section className="details"><h2>Instructions and preferences</h2><p className="setting-text">{details.assignmentInstructions}</p>
        <h3>Saved preference</h3>{details.preference ? <><p className="setting-text">{details.preference.instructions}</p>
          <button disabled={!canOpenDM} onClick={()=>openDM(dm.id, details.preference!.messageId)}>View source reply</button>
        </> : <p>No saved preference.</p>}
      </section>
      <section className="details"><h2>Schedule and delivery</h2>
        <p>{active ? 'Daily at ' + active.time + ' · ' + zone : dm.closed ? 'Assignment closed' : 'On demand'}</p>
        {active && <p>{active.backfill ? 'Deliver every missed report.' : 'Deliver the latest report and record earlier missed dates.'}</p>}
        <button disabled={!canOpenDM} onClick={()=>openDM(dm.id)}>Open {dm.name}’s DM</button>
        {!dm.closed && !pending && !proposal && <button disabled={disabled} onClick={() => {
          setError(''); setProposal({activeId:active?.id ?? null,time:active?.time ?? '08:00',backfill:Boolean(active?.backfill)});
        }}>{active ? 'Change schedule' : 'Schedule daily reports'}</button>}
        {proposal && !pending && !dm.closed && <form className="settings-form" onSubmit={e=>{e.preventDefault(); void save('schedule',proposal);}}>
          <label>Daily time · Pacific<input type="time" required value={proposal.time} onChange={e=>setProposal({...proposal,time:e.target.value})}/></label>
          <label className="check"><input type="checkbox" checked={proposal.backfill} onChange={e=>setProposal({...proposal,backfill:e.target.checked})}/>Backfill every missed report</label>
          <div><button className="primary" disabled={disabled || (active?.time === proposal.time && Boolean(active.backfill) === proposal.backfill)}>Review change</button>
            <button type="button" onClick={()=>setProposal(null)}>Cancel</button></div>
        </form>}
      </section>
      <section className="details"><h2>Tools and access</h2>{access}</section>
      <AccessRequests snapshot={snapshot} conversationId={dm.id} disabled={disabled} refresh={refresh}/>
      {!dm.closed && <button disabled={disabled} onClick={()=>{
        if (window.confirm('Close this reporting assignment and end its access? Its conversation and reports will remain available.')) void save('close',{});
      }}>Close reporting assignment</button>}
    </> : <>
      <section className="details"><h2>Agent instructions</h2>
        {edit ? <form className="settings-form" onSubmit={e=>{e.preventDefault(); void save('definition',{revision:edit.revision,instructions:edit.text});}}>
          <label>Instructions for {dm.name}’s future work<textarea required maxLength={2000} autoFocus value={edit.text} onChange={e=>setEdit({...edit,text:e.target.value})}/></label>
          <div><button className="primary" disabled={disabled || !edit.text.trim()}>Save revision</button><button type="button" onClick={()=>{setEdit(null);setError('');}}>Cancel</button></div>
        </form> : <><p className="setting-text">{details.instructions}</p><button disabled={disabled || Boolean(loadError)} onClick={()=>setEdit({revision:details.revision,text:details.instructions})}>Edit instructions</button></>}
        <details><summary>Revision history · Revision {details.revision}</summary><ol className="revisions">
          {details.history.map(rev=><li key={rev.revision}><strong>Revision {rev.revision}</strong><p className="setting-text">{rev.instructions}</p></li>)}</ol></details>
        <h3>Execution preferences</h3><p>Codex · Runner default model and effort</p>
      </section>
      <section className="details"><h2>Assignments</h2><a href={settingsPath(dm.id,'assignment')}>{assignmentName}</a>
        <p>{dm.closed ? 'Closed' : active ? 'Daily at ' + active.time + ' Pacific' : 'On demand'}</p></section>
      <section className="details"><h2>Tools and access</h2>{access}<a href={settingsPath(dm.id,'assignment')}>Review assignment access</a></section>
    </>)}
    {error && <p role="alert">{error}</p>}
  </>;
}
