'use strict';

// End-to-end smoke test. Requires a seeded PostgreSQL database and a running API.
// It creates one uniquely named custom role and one temporary parser-created job.
const assert = require('node:assert/strict');

const baseUrl = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');

async function request(method, path, actorId, body) {
  const headers = { 'x-demo-user-id': String(actorId) };
  const options = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: expected HTTP ${status}, got ${result.status}; body=${JSON.stringify(result.data)}`);
}

async function main() {
  const health = await request('GET', '/health', 1);
  expectStatus(health, 200, 'health');
  assert.equal(health.data.database, 'connected');
  console.log('PASS database health');

  const rahulCanCheck = await request('GET', '/authorization/check?userId=4&jobId=1&action=check_job', 1);
  expectStatus(rahulCanCheck, 200, 'Rahul in-scope decision');
  assert.equal(rahulCanCheck.data.allowed, true);

  const rahulCannotCheckExport = await request('GET', '/authorization/check?userId=4&jobId=2&action=check_job', 1);
  expectStatus(rahulCannotCheckExport, 200, 'Rahul out-of-scope decision');
  assert.equal(rahulCannotCheckExport.data.allowed, false);
  assert.equal(rahulCannotCheckExport.data.code, 'NO_MATCHING_PERMISSION');

  const priyaSelfCheck = await request('GET', '/authorization/check?userId=3&jobId=4&action=check_job', 1);
  expectStatus(priyaSelfCheck, 200, 'maker/checker separation');
  assert.equal(priyaSelfCheck.data.code, 'SEPARATION_OF_DUTIES');

  const absentCheck = await request('GET', '/authorization/check?userId=7&jobId=1&action=check_job', 1);
  expectStatus(absentCheck, 200, 'absent user');
  assert.equal(absentCheck.data.code, 'USER_NOT_ACTIVE');

  const clientBoundary = await request('GET', '/authorization/check?userId=8&jobId=1&action=view_job', 8);
  expectStatus(clientBoundary, 200, 'client boundary');
  assert.equal(clientBoundary.data.code, 'CLIENT_BOUNDARY');

  const queue = await request('GET', '/users/4/jobs-needing-me', 4);
  expectStatus(queue, 200, 'actionable queue');
  assert.ok(queue.data.count >= 1, 'total actionable queue count should include Job 1');
  assert.ok(queue.data.jobs.some(job => String(job.id) === '1'), 'Rahul queue should include in-scope Job 1');
  assert.ok(!queue.data.jobs.some(job => String(job.id) === '2'), 'Rahul queue must exclude export Job 2');
  assert.equal(queue.data.returned, queue.data.jobs.length);
  console.log('PASS scoped decisions, maker/checker conflict, absence, client boundary and queue');

  const selfEscalation = await request('POST', '/permissions', 1, {
    userId: 1, role: 'workflow_admin', reason: 'Attempt self escalation'
  });
  expectStatus(selfEscalation, 403, 'admin self-escalation');
  assert.equal(selfEscalation.data.code, 'SELF_ESCALATION_BLOCKED');

  // Create a data-driven role, grant it briefly in a narrow scope, verify live effect, then revoke it.
  const roleName = `smoke_checker_${Date.now()}`;
  const roleResult = await request('POST', '/roles', 1, {
    role: roleName,
    description: 'Temporary end-to-end smoke-test checker',
    appliesTo: 'internal',
    actions: ['view_job', 'check_job'],
    reason: 'Verify configurable roles and live permission changes'
  });
  expectStatus(roleResult, 201, 'create custom role');
  const grantResult = await request('POST', '/permissions', 1, {
    userId: 11,
    role: roleName,
    scope: { clientId: 1, branchId: 1, direction: 'IMPORT' },
    reason: 'Temporary smoke-test review cover',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  });
  expectStatus(grantResult, 201, 'grant scoped permission');
  const assignmentId = grantResult.data.assignment.id;
  try {
    const newlyAllowed = await request('GET', '/authorization/check?userId=11&jobId=1&action=check_job', 1);
    expectStatus(newlyAllowed, 200, 'new grant effect');
    assert.equal(newlyAllowed.data.allowed, true);
    const revoke = await request('DELETE', `/permissions/${assignmentId}`, 1, { reason: 'Smoke-test grant has served its purpose' });
    expectStatus(revoke, 200, 'revoke scoped permission');
    const revoked = await request('GET', '/authorization/check?userId=11&jobId=1&action=check_job', 1);
    expectStatus(revoked, 200, 'revoked grant effect');
    assert.equal(revoked.data.allowed, false);
  } finally {
    // Best-effort cleanup if an assertion fails before the explicit revoke.
    const cleanup = await request('DELETE', `/permissions/${assignmentId}`, 1, { reason: 'Clean up smoke-test grant' }).catch(() => null);
    void cleanup;
  }
  console.log('PASS custom role creation, scoped grant, immediate revocation and self-escalation protection');

  // Use a temporary parser-created job so this smoke test doesn't mutate the curated demo jobs.
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createJob = await request('POST', '/parser/jobs', 9, {
    reference: `SMOKE-${unique}`,
    clientId: 1,
    branchId: 1,
    direction: 'IMPORT',
    mode: 'AIR',
    description: 'Temporary end-to-end authorization smoke test',
    etaDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
  });
  expectStatus(createJob, 201, 'parser creates scoped job');
  const jobId = createJob.data.job.id;

  const metadata = await request('PATCH', `/parser/jobs/${jobId}/metadata`, 9, {
    description: 'Metadata updated by parser smoke test',
    externalReference: `EXT-${unique}`
  });
  expectStatus(metadata, 200, 'parser metadata update');

  const forbiddenParserUpdate = await request('PATCH', `/parser/jobs/${jobId}/metadata`, 9, { stage: 'FILED' });
  expectStatus(forbiddenParserUpdate, 400, 'parser protected field');

  const prepared = await request('POST', `/jobs/${jobId}/actions/prepare_job`, 5, {});
  expectStatus(prepared, 200, 'Maker prepares smoke job');
  assert.equal(prepared.data.job.stage, 'PREPARED');
  const historicalAt = new Date().toISOString();

  const checked = await request('POST', `/jobs/${jobId}/actions/check_job`, 4, {});
  expectStatus(checked, 200, 'scoped Checker checks smoke job');
  assert.equal(checked.data.job.stage, 'CHECKED');
  const filed = await request('POST', `/jobs/${jobId}/actions/file_job`, 6, {});
  expectStatus(filed, 200, 'Filer files smoke job');
  assert.equal(filed.data.job.stage, 'FILED');
  const cancelled = await request('POST', `/jobs/${jobId}/actions/cancel_filed_job`, 2, {
    reason: 'Smoke test verifies filed-job exception'
  });
  expectStatus(cancelled, 200, 'workflow admin cancels filed job');
  assert.equal(cancelled.data.job.stage, 'CANCELLED');
  const reopened = await request('POST', `/jobs/${jobId}/actions/reopen_filed_job`, 2, {
    reason: 'Smoke test verifies reopening exception'
  });
  expectStatus(reopened, 200, 'workflow admin reopens cancelled job');
  assert.equal(reopened.data.job.stage, 'REOPENED');

  const history = await request('GET', `/jobs/${jobId}/history`, 2);
  expectStatus(history, 200, 'audit history');
  const actions = history.data.history.map(event => event.action);
  for (const expected of ['parser.job_created', 'parser.metadata_updated', 'prepare_job', 'check_job', 'file_job', 'cancel_filed_job', 'reopen_filed_job']) {
    assert.ok(actions.includes(expected), `audit history should include ${expected}`);
  }

  const investigation = await request('GET', `/jobs/${jobId}/who-could-act?${new URLSearchParams({ action: 'check_job', at: historicalAt })}`, 1);
  expectStatus(investigation, 200, 'historical permission investigation');
  assert.ok(investigation.data.usersAllowedByRecordedAssignments.some(user => String(user.userId) === '4'), 'Rahul should have been eligible to check while the temporary job was Prepared');
  console.log('PASS parser restrictions, workflow transitions, filed-job exceptions, audit history and historical investigation');

  console.log(`\nALL SMOKE TESTS PASSED against ${baseUrl}.`);
  console.log('Note: the script adds one custom role and one SMOKE-* job. Run npm run db:setup to reset the curated demo database.');
}

main().catch(error => {
  console.error('SMOKE TEST FAILED:', error.stack || error.message);
  process.exitCode = 1;
});
