import React, { useCallback, useEffect, useState } from 'react';
import { api, baseUrl } from './api.js';

const DEMO_USERS = [
  [1, 'Asha Admin', 'Access administrator'], [2, 'Arjun Workflow Lead', 'Workflow administrator'],
  [3, 'Priya Maker-Checker', 'Maker and limited Checker'], [4, 'Rahul Import Checker', 'Aster/Mumbai import Checker'],
  [5, 'Meera Maker', 'Maker'], [6, 'Dev Filer', 'Filer'], [7, 'Sameer Absent Checker', 'Absent Checker'],
  [8, 'Nina Client User', 'BluePeak read-only client'], [9, 'Night Parser Service', 'Parser service account'],
  [10, 'Aditi Temporary Checker', 'Temporary Checker'], [11, 'Kabir Maker', 'Delhi Maker'],
  [12, 'Ira Checker', 'BluePeak Delhi Checker'], [13, 'Rohan Maker', 'Chennai Maker'],
  [14, 'Tara Checker', 'Chennai Checker'], [15, 'Veer Filer', 'Kolkata Filer'],
  [16, 'Mira Maker', 'Kolkata Maker'], [17, 'Neil Checker', 'Ahmedabad Checker'],
  [18, 'Sara Maker', 'Ahmedabad Maker'], [19, 'Omni Ops', 'Narrow Delhi export Maker'],
  [20, 'Pia Client Viewer', 'Cedar read-only client']
].map(([id, name, context]) => ({ id, name, context }));

const WORKFLOW_ACTIONS = ['prepare_job', 'check_job', 'file_job', 'cancel_job', 'cancel_filed_job', 'reopen_filed_job'];
const REASON_ACTIONS = new Set(['cancel_job', 'cancel_filed_job', 'reopen_filed_job']);
const pretty = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase());
const dateTime = value => value ? new Date(value).toLocaleString() : '—';

function ErrorMessage({ error }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

function App() {
  const [actorId, setActorId] = useState(4);
  const [queue, setQueue] = useState(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [jobIdInput, setJobIdInput] = useState('1');
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [jobLoading, setJobLoading] = useState(false);
  const [jobError, setJobError] = useState('');
  const [decisions, setDecisions] = useState({});
  const [actionLoading, setActionLoading] = useState('');
  const [notice, setNotice] = useState('');
  const actor = DEMO_USERS.find(user => user.id === actorId);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true); setQueueError('');
    try { setQueue(await api.queue(actorId)); }
    catch (error) { setQueue(null); setQueueError(error.message); }
    finally { setQueueLoading(false); }
  }, [actorId]);

  const loadJob = useCallback(async (requestedId = jobIdInput) => {
    const id = Number(requestedId);
    if (!Number.isSafeInteger(id) || id < 1) { setJobError('Enter a positive job ID.'); return; }
    setJobLoading(true); setJobError(''); setNotice(''); setDecisions({});
    try {
      const [jobResponse, historyResponse] = await Promise.all([api.job(actorId, id), api.history(actorId, id)]);
      setJob(jobResponse.job); setHistory(historyResponse.history || []); setJobIdInput(String(id));
      const nextDecisions = {};
      await Promise.all(WORKFLOW_ACTIONS.map(async action => {
        try { nextDecisions[action] = await api.decision(actorId, id, action); }
        catch (error) { nextDecisions[action] = { allowed: false, reason: error.message, code: error.code || 'UNAVAILABLE' }; }
      }));
      setDecisions(nextDecisions);
    } catch (error) { setJob(null); setHistory([]); setJobError(error.message); }
    finally { setJobLoading(false); }
  }, [actorId, jobIdInput]);

  useEffect(() => { loadQueue(); }, [loadQueue]);
  useEffect(() => { setJob(null); setHistory([]); setDecisions({}); setJobError(''); setNotice(''); }, [actorId]);

  async function runAction(action) {
    if (!job || actionLoading) return;
    const reason = REASON_ACTIONS.has(action) ? window.prompt(`Reason for ${pretty(action)} (at least 8 characters):`) : '';
    if (REASON_ACTIONS.has(action) && reason === null) return;
    if (REASON_ACTIONS.has(action) && reason.trim().length < 8) { setJobError('Provide a meaningful reason of at least 8 characters.'); return; }
    setActionLoading(action); setJobError(''); setNotice('');
    try {
      const result = await api.workflow(actorId, job.id, action, reason);
      setNotice(`${pretty(action)} succeeded. Job is now ${result.job.stage}.`);
      await Promise.all([loadQueue(), loadJob(job.id)]);
    } catch (error) { setJobError(`${pretty(action)} was denied: ${error.message}`); }
    finally { setActionLoading(''); }
  }

  return <main>
    <header>
      <div><p className="eyebrow">NFPL Access Control Service</p><h1>Workflow demonstration</h1></div>
      <span className="api">API: {baseUrl}</span>
    </header>

    <section className="context panel">
      <label>Demonstration user
        <select value={actorId} onChange={event => setActorId(Number(event.target.value))}>
          {DEMO_USERS.map(user => <option key={user.id} value={user.id}>{user.id} — {user.name}</option>)}
        </select>
      </label>
      <div><strong>{actor?.name}</strong><span>{actor?.context}</span></div>
      <p>This changes only the API’s documented <code>x-demo-user-id</code> header. It is not authentication; server-side authorization remains authoritative.</p>
    </section>

    <section className="grid">
      <article className="panel">
        <h2>Dashboard and pending work</h2>
        {queueLoading && <p>Loading the current user’s actionable queue…</p>}
        <ErrorMessage error={queueError} />
        {queue && <><p className="metric">{queue.count}</p><p>actionable jobs for this user</p>
          {queue.jobs.length ? <table><thead><tr><th>Job</th><th>Stage</th><th>Next action</th></tr></thead><tbody>
            {queue.jobs.map(item => <tr key={item.id}><td><button className="link" onClick={() => loadJob(item.id)}>{item.reference}</button></td><td><span className="badge">{item.stage}</span></td><td>{pretty(item.nextAction)}</td></tr>)}
          </tbody></table> : <p className="muted">No actionable jobs are currently returned by the API.</p>}</>}
        <button onClick={loadQueue} disabled={queueLoading}>Refresh queue</button>
      </article>

      <article className="panel">
        <h2>Jobs and audit history</h2>
        <form onSubmit={event => { event.preventDefault(); loadJob(); }} className="lookup">
          <label>Job ID<input value={jobIdInput} onChange={event => setJobIdInput(event.target.value)} inputMode="numeric" /></label>
          <button disabled={jobLoading}>{jobLoading ? 'Loading…' : 'Load job'}</button>
        </form>
        <p className="muted">The API has no general jobs-list endpoint. This screen uses the real actionable queue or a specific real job ID.</p>
        <ErrorMessage error={jobError} />
        {notice && <p className="success">{notice}</p>}
        {job && <JobDetail job={job} decisions={decisions} busyAction={actionLoading} onAction={runAction} />}
        {job && <History events={history} />}
      </article>
    </section>
  </main>;
}

function JobDetail({ job, decisions, busyAction, onAction }) {
  return <section className="job-detail"><h3>{job.reference} <span className="badge">{job.stage}</span></h3>
    <dl><div><dt>Client ID</dt><dd>{job.clientId}</dd></div><div><dt>Branch ID</dt><dd>{job.branchId}</dd></div><div><dt>Route</dt><dd>{job.direction} / {job.mode}</dd></div><div><dt>Prepared by</dt><dd>{job.preparedById ?? '—'}</dd></div></dl>
    <p>{job.description || 'No description supplied.'}</p>
    <h4>Available workflow actions</h4>
    <div className="actions">{WORKFLOW_ACTIONS.map(action => {
      const decision = decisions[action];
      return <button key={action} title={decision?.reason || 'Checking permission…'} disabled={!decision?.allowed || Boolean(busyAction)} onClick={() => onAction(action)}>
        {busyAction === action ? 'Working…' : pretty(action)}
      </button>;
    })}</div>
    {Object.values(decisions).some(decision => decision?.allowed === false) && <details><summary>Why are some actions disabled?</summary><ul>{WORKFLOW_ACTIONS.filter(action => decisions[action]?.allowed === false).map(action => <li key={action}><strong>{pretty(action)}:</strong> {decisions[action].reason}</li>)}</ul></details>}
  </section>;
}

function History({ events }) {
  return <section className="history"><h3>Audit history</h3>
    {!events.length ? <p className="muted">No audit records were returned for this job.</p> : <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Reason</th></tr></thead><tbody>
      {events.map(event => <tr key={event.id}><td>{dateTime(event.created_at)}</td><td>{event.actor_name || 'System baseline'}</td><td>{event.action}</td><td>{event.reason || '—'}</td></tr>)}
    </tbody></table>}
  </section>;
}

export default App;
