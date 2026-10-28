'use strict';
const express = require('express');
const { pool, withTransaction } = require('../db');
const repo = require('../repositories/accessRepository');
const { canPerform, canManagePermissions, validatePermissionChange } = require('../domain/authorization');

const router = express.Router();
const WORKFLOW_ACTIONS = new Set(['prepare_job', 'check_job', 'file_job', 'cancel_job', 'cancel_filed_job', 'reopen_filed_job']);
const PARSER_FIELD_TO_COLUMN = { externalReference: 'external_reference', description: 'description', etaDate: 'eta_date' };

function integerParam(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    const error = new Error(`${name} must be a positive integer.`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function requiredReason(value) {
  if (typeof value !== 'string' || value.trim().length < 8) {
    const error = new Error('Provide a meaningful reason of at least 8 characters.');
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function optionalTimestamp(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    const error = new Error(`${name} must be a valid timestamp string.`);
    error.status = 400;
    throw error;
  }
  return new Date(value).toISOString();
}

function optionalString(value, name, { nullable = false, maxLength = 2000 } = {}) {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'string') {
    const error = new Error(`${name} must be ${nullable ? 'a string or null' : 'a string'}.`);
    error.status = 400;
    throw error;
  }
  if (value.length > maxLength) {
    const error = new Error(`${name} must not exceed ${maxLength} characters.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function optionalDate(value, name = 'etaDate') {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error(`${name} must be YYYY-MM-DD or null.`);
    error.status = 400;
    throw error;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    const error = new Error(`${name} must be a real calendar date in YYYY-MM-DD format.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function validateParserMetadata(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    const error = new Error('Metadata must be a JSON object.'); error.status = 400; throw error;
  }
  const validated = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(PARSER_FIELD_TO_COLUMN, key)) {
      const error = new Error(`Unsupported metadata field: ${key}`); error.status = 400; throw error;
    }
    if (key === 'externalReference') validated[key] = optionalString(value, key, { nullable: true, maxLength: 200 });
    if (key === 'description') validated[key] = optionalString(value, key, { maxLength: 2000 });
    if (key === 'etaDate') validated[key] = optionalDate(value, key);
  }
  return validated;
}

function snapshot(job) {
  return job ? JSON.parse(JSON.stringify(job)) : null;
}

async function getDemoActor(db, req) {
  const raw = req.get('x-demo-user-id');
  if (!raw) {
    const error = new Error('Set x-demo-user-id to a sample user ID. This is a demo identity switch, not production authentication.');
    error.status = 401;
    throw error;
  }
  const actor = await repo.getUser(db, integerParam(raw, 'x-demo-user-id'));
  if (!actor) {
    const error = new Error('Demo user was not found.');
    error.status = 401;
    throw error;
  }
  return actor;
}

async function assignmentsFor(db, userId, options = {}) {
  return repo.getAssignmentsForUser(db, userId, { includeHistorical: true, ...options });
}

function permitOrThrow(decision) {
  if (!decision.allowed) {
    const error = new Error(decision.reason);
    error.status = 403;
    error.code = decision.code;
    throw error;
  }
}

function jobNotFound(res) {
  return res.status(404).json({ error: 'Job not found.' });
}

function concealedJobNotFoundError() {
  const error = new Error('Job not found.');
  error.status = 404;
  error.concealJob = true;
  return error;
}

router.get('/health', async (_req, res) => {
  const { rows } = await pool.query('SELECT NOW() AS database_time');
  res.json({ status: 'ok', database: 'connected', databaseTime: rows[0].database_time });
});

router.get('/authorization/check', async (req, res) => {
  const userId = integerParam(req.query.userId, 'userId');
  const jobId = integerParam(req.query.jobId, 'jobId');
  const action = String(req.query.action || 'view_job');
  const actor = await getDemoActor(pool, req);
  const actorGrants = await assignmentsFor(pool, actor.id);
  const actorIsAccessAdmin = canManagePermissions(actor, actorGrants).allowed;
  if (String(actor.id) !== String(userId) && !actorIsAccessAdmin) {
    const error = new Error('Only the user themselves or a global access administrator may inspect this decision.');
    error.status = 403;
    throw error;
  }
  const [user, job] = await Promise.all([repo.getUser(pool, userId), repo.getJob(pool, jobId)]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const assignments = await assignmentsFor(pool, userId);
  const roleActions = await repo.getRoleActions(pool);
  const maySeeJob = job && (actorIsAccessAdmin || canPerform(user, 'view_job', job, assignments, { roleActions }).allowed);
  if (!maySeeJob) return jobNotFound(res);
  // A supplied reason lets the caller check reason-gated exception actions before attempting them.
  const reason = typeof req.query.reason === 'string' ? req.query.reason : '';
  const decision = canPerform(user, action, job, assignments, { roleActions, reason }, new Date());
  res.json({ user: { id: user.id, name: user.name }, job: { id: job.id, reference: job.reference, stage: job.stage }, action, ...decision, policy: 'scoped-role + workflow-stage + separation-of-duties; deny by default' });
});

router.get('/jobs/:jobId', async (req, res) => {
  const jobId = integerParam(req.params.jobId, 'jobId');
  const actor = await getDemoActor(pool, req);
  const job = await repo.getJob(pool, jobId);
  if (!job) return jobNotFound(res);
  const assignments = await assignmentsFor(pool, actor.id);
  const roleActions = await repo.getRoleActions(pool);
  const decision = canPerform(actor, 'view_job', job, assignments, { roleActions });
  if (!decision.allowed) return jobNotFound(res);
  res.json({ job });
});

router.get('/users/:userId/jobs-needing-me', async (req, res) => {
  const userId = integerParam(req.params.userId, 'userId');
  const actor = await getDemoActor(pool, req);
  if (String(actor.id) !== String(userId)) {
    const error = new Error('A user may view their own actionable queue only in this demo.');
    error.status = 403;
    throw error;
  }
  const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    const error = new Error('limit must be a positive integer.'); error.status = 400; throw error;
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    const error = new Error('offset must be a non-negative integer.'); error.status = 400; throw error;
  }
  const limit = Math.min(requestedLimit, 100);
  const queue = await repo.listJobsNeedingUser(pool, userId, { limit, offset });
  res.json({ userId, count: queue.total, returned: queue.jobs.length, limit, offset, jobs: queue.jobs, note: 'count is the total number of actionable jobs across all pages; the current response contains returned jobs. Queue uses current assignments and workflow stages; inactive users receive an empty queue.' });
});

function normalizeHistoricalJob(state) {
  if (!state) return null;
  const pick = (camel, snake) => state[camel] !== undefined ? state[camel] : state[snake];
  return {
    id: state.id,
    reference: state.reference,
    externalReference: pick('externalReference', 'external_reference'),
    clientId: pick('clientId', 'client_id'),
    branchId: pick('branchId', 'branch_id'),
    direction: state.direction,
    mode: state.mode,
    stage: state.stage,
    description: state.description || '',
    etaDate: pick('etaDate', 'eta_date'),
    createdById: pick('createdById', 'created_by_user_id'),
    preparedById: pick('preparedById', 'prepared_by_user_id'),
    checkedById: pick('checkedById', 'checked_by_user_id'),
    filedById: pick('filedById', 'filed_by_user_id'),
    createdAt: pick('createdAt', 'created_at'),
    updatedAt: pick('updatedAt', 'updated_at')
  };
}

router.get('/jobs/:jobId/who-could-act', async (req, res) => {
  const jobId = integerParam(req.params.jobId, 'jobId');
  const actor = await getDemoActor(pool, req);
  const investigationGrants = await assignmentsFor(pool, actor.id);
  permitOrThrow(canManagePermissions(actor, investigationGrants));

  const atText = req.query.at;
  const at = atText ? new Date(String(atText)) : new Date();
  if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'at must be a valid ISO-8601 timestamp.' });
  const action = String(req.query.action || 'check_job');
  const supported = new Set(['view_job', 'prepare_job', 'check_job', 'file_job', 'cancel_job', 'cancel_filed_job', 'reopen_filed_job', 'parser_update_job']);
  if (!supported.has(action)) return res.status(400).json({ error: 'Unsupported historical action.' });

  const current = await repo.getJob(pool, jobId);
  if (!current) return res.status(404).json({ error: 'Job not found.' });
  if (current.createdAt && new Date(current.createdAt) > at) {
    return res.json({ jobId, at: at.toISOString(), action, jobExistedAtThatTime: false, users: [], note: 'The job had not yet been created at the requested time.' });
  }

  let historicalJob = current;
  const events = await pool.query(
    `SELECT action, before_state, created_at FROM audit_logs
     WHERE entity_type='job' AND entity_id=$1 AND created_at > $2
     ORDER BY created_at DESC, id DESC`, [String(jobId), at.toISOString()]
  );
  for (const event of events.rows) {
    if (['job.created', 'job.imported_snapshot', 'parser.job_created'].includes(event.action)) continue;
    if (event.before_state) historicalJob = normalizeHistoricalJob(event.before_state);
  }

  const { rows: userRows } = await pool.query('SELECT * FROM users ORDER BY id');
  const users = userRows.map(row => repo.mapUser(row));
  const assignments = await repo.getAllAssignments(pool);
  const statusesAt = await repo.getStatusesAt(pool, at.toISOString());
  const roleActions = await repo.getRoleActions(pool);
  const results = users.map(user => {
    const statusRecord = statusesAt.get(String(user.id));
    const decision = canPerform(user, action, historicalJob, assignments, {
      reason: 'Historical review: an appropriately documented reason would be required',
      roleActions,
      statusKnown: Boolean(statusRecord),
      statusAt: statusRecord?.status
    }, at);
    return { userId: user.id, name: user.name, statusAtThatTime: statusRecord?.status ?? null, ...decision };
  });
  const allowed = results.filter(item => item.allowed);
  res.json({
    jobId,
    reference: historicalJob.reference,
    at: at.toISOString(),
    action,
    stageAtThatTime: historicalJob.stage,
    usersAllowedByRecordedAssignments: allowed,
    allowedCount: allowed.length,
    excludedCount: results.length - allowed.length,
    note: 'Uses grants and recorded user status effective at the requested timestamp, and reconstructs the job from audit snapshots. A missing status record is denied rather than guessed. For cancel/reopen, an allowed result is conditional on supplying the required reason.'
  });
});

router.get('/jobs/:jobId/history', async (req, res) => {
  const jobId = integerParam(req.params.jobId, 'jobId');
  const actor = await getDemoActor(pool, req);
  const job = await repo.getJob(pool, jobId);
  if (!job) return jobNotFound(res);
  const assignments = await assignmentsFor(pool, actor.id);
  const roleActions = await repo.getRoleActions(pool);
  const viewDecision = canPerform(actor, 'view_job', job, assignments, { roleActions });
  const investigationDecision = canManagePermissions(actor, assignments);
  if (!viewDecision.allowed && !investigationDecision.allowed) return jobNotFound(res);
  const history = await repo.getJobHistory(pool, jobId);
  res.json({ jobId, history });
});

router.post('/jobs/:jobId/actions/:action', async (req, res) => {
  const jobId = integerParam(req.params.jobId, 'jobId');
  const action = String(req.params.action);
  if (!WORKFLOW_ACTIONS.has(action)) return res.status(400).json({ error: 'Unsupported workflow action.' });
  const reason = ['cancel_job', 'cancel_filed_job', 'reopen_filed_job'].includes(action) ? requiredReason(req.body?.reason) : (req.body?.reason || null);
  const actor = await getDemoActor(pool, req);

  const result = await withTransaction(async client => {
    const job = await repo.getJob(client, jobId, { forUpdate: true });
    if (!job) throw concealedJobNotFoundError();
    // Permission is re-evaluated while the job row is locked, immediately before mutation.
    const currentActor = await repo.getUser(client, actor.id);
    const assignments = await assignmentsFor(client, actor.id, { lock: true });
    const roleActions = await repo.getRoleActions(client);
    const viewDecision = canPerform(currentActor, 'view_job', job, assignments, { roleActions }, new Date());
    if (!viewDecision.allowed) throw concealedJobNotFoundError();
    const decision = canPerform(currentActor, action, job, assignments, { reason, roleActions }, new Date());
    permitOrThrow(decision);
    const before = snapshot(job);
    const updates = {
      prepare_job: { stage: 'PREPARED', preparedBy: actor.id, clearLater: true },
      check_job: { stage: 'CHECKED', checkedBy: actor.id },
      file_job: { stage: 'FILED', filedBy: actor.id },
      cancel_job: { stage: 'CANCELLED' },
      cancel_filed_job: { stage: 'CANCELLED' },
      reopen_filed_job: { stage: 'REOPENED', clearLater: true }
    }[action];
    let sql;
    let params;
    if (updates.preparedBy) {
      sql = `UPDATE jobs SET stage=$1, prepared_by_user_id=$2, checked_by_user_id=NULL, filed_by_user_id=NULL, updated_at=NOW() WHERE id=$3 RETURNING *`;
      params = [updates.stage, updates.preparedBy, jobId];
    } else if (updates.checkedBy) {
      sql = `UPDATE jobs SET stage=$1, checked_by_user_id=$2, filed_by_user_id=NULL, updated_at=NOW() WHERE id=$3 RETURNING *`;
      params = [updates.stage, updates.checkedBy, jobId];
    } else if (updates.filedBy) {
      sql = `UPDATE jobs SET stage=$1, filed_by_user_id=$2, updated_at=NOW() WHERE id=$3 RETURNING *`;
      params = [updates.stage, updates.filedBy, jobId];
    } else if (updates.clearLater) {
      sql = `UPDATE jobs SET stage=$1, checked_by_user_id=NULL, filed_by_user_id=NULL, updated_at=NOW() WHERE id=$2 RETURNING *`;
      params = [updates.stage, jobId];
    } else {
      sql = `UPDATE jobs SET stage=$1, updated_at=NOW() WHERE id=$2 RETURNING *`;
      params = [updates.stage, jobId];
    }
    const updatedRow = (await client.query(sql, params)).rows[0];
    const updated = repo.mapJob(updatedRow);
    await repo.writeAudit(client, {
      actorUserId: actor.id,
      entityType: 'job', entityId: jobId, action,
      beforeState: before, afterState: snapshot(updated), reason,
      requestId: req.requestId
    });
    return { job: updated, decision };
  });
  res.json({ success: true, ...result });
});

router.patch('/users/:userId/status', async (req, res) => {
  const userId = integerParam(req.params.userId, 'userId');
  const actor = await getDemoActor(pool, req);
  const status = String(req.body?.status || '').toLowerCase();
  if (!['active', 'absent', 'disabled'].includes(status)) {
    return res.status(400).json({ error: 'status must be active, absent or disabled.' });
  }
  const reason = requiredReason(req.body?.reason);
  if (String(actor.id) === String(userId)) {
    return res.status(403).json({ error: 'Administrators cannot change their own status through this endpoint.', code: 'SELF_STATUS_CHANGE_BLOCKED' });
  }
  const result = await withTransaction(async client => {
    const latestActor = await repo.getUser(client, actor.id);
    const grants = await assignmentsFor(client, actor.id, { lock: true });
    permitOrThrow(canManagePermissions(latestActor, grants));
    const target = await repo.getUser(client, userId);
    if (!target) { const error = new Error('User not found.'); error.status = 404; throw error; }
    if (target.status === status) {
      const error = new Error(`User is already ${status}.`); error.status = 409; throw error;
    }
    const changed = await repo.changeUserStatus(client, { userId, status, changedByUserId: actor.id, reason });
    await repo.writeAudit(client, {
      actorUserId: actor.id,
      entityType: 'user', entityId: userId, action: 'user.status_changed',
      beforeState: { id: target.id, status: target.status },
      afterState: { id: changed.user.id, status: changed.user.status, effectiveAt: changed.effectiveAt },
      reason, requestId: req.requestId
    });
    return changed;
  });
  res.json({ success: true, user: result.user, effectiveAt: result.effectiveAt });
});

router.get('/roles', async (req, res) => {
  const actor = await getDemoActor(pool, req);
  const grants = await assignmentsFor(pool, actor.id);
  permitOrThrow(canManagePermissions(actor, grants));
  res.json({ roles: await repo.getRoleDefinitions(pool) });
});

router.post('/roles', async (req, res) => {
  const actor = await getDemoActor(pool, req);
  const grants = await assignmentsFor(pool, actor.id);
  permitOrThrow(canManagePermissions(actor, grants));
  const name = String(req.body?.role || '').trim().toLowerCase();
  const description = String(req.body?.description || '').trim();
  const appliesTo = String(req.body?.appliesTo || 'internal').toLowerCase();
  const requestedActions = Array.isArray(req.body?.actions) ? [...new Set(req.body.actions.map(x => String(x).toLowerCase()))] : [];
  const roleReason = requiredReason(req.body?.reason);
  const roleNamePattern = /^[a-z][a-z0-9_]{2,39}$/;
  if (!roleNamePattern.test(name)) return res.status(400).json({ error: 'Role names must be 3–40 characters, start with a letter, and contain only lowercase letters, numbers or underscores.' });
  if (!description || description.length > 240) return res.status(400).json({ error: 'Provide a description of at most 240 characters.' });
  if (!['internal', 'client', 'service'].includes(appliesTo)) return res.status(400).json({ error: 'appliesTo must be internal, client or service.' });
  if (!requestedActions.length) return res.status(400).json({ error: 'Choose at least one action.' });
  const customActionCatalog = {
    internal: new Set(['view_job', 'prepare_job', 'check_job', 'file_job', 'cancel_job']),
    client: new Set(['view_job']),
    service: new Set(['parser_create_job', 'parser_update_job'])
  };
  const forbidden = requestedActions.filter(action => !customActionCatalog[appliesTo].has(action));
  if (forbidden.length) return res.status(400).json({ error: `These actions cannot be delegated to a custom ${appliesTo} role: ${forbidden.join(', ')}. High-risk workflow overrides and permission administration remain reserved roles.` });
  const created = await withTransaction(async client => {
    const latestActor = await repo.getUser(client, actor.id);
    permitOrThrow(canManagePermissions(latestActor, await assignmentsFor(client, actor.id, { lock: true })));
    const { rows } = await client.query(
      `INSERT INTO role_definitions(role,description,allowed_user_type,is_builtin,created_by_user_id)
       VALUES ($1,$2,$3,FALSE,$4) RETURNING *`, [name, description, appliesTo, actor.id]
    );
    for (const action of requestedActions) {
      await client.query('INSERT INTO role_action_permissions(role,action) VALUES ($1,$2)', [name, action]);
    }
    await repo.writeAudit(client, { actorUserId: actor.id, entityType: 'role', entityId: name, action: 'role.created', afterState: { ...rows[0], actions: requestedActions }, reason: roleReason, requestId: req.requestId });
    return { ...rows[0], actions: requestedActions };
  });
  res.status(201).json({ success: true, role: created, note: 'Custom roles use existing actions and workflow rules; no application code deployment is required.' });
});

router.get('/permissions', async (req, res) => {
  const actor = await getDemoActor(pool, req);
  const assignments = await assignmentsFor(pool, actor.id);
  permitOrThrow(canManagePermissions(actor, assignments));
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS user_name, au.name AS assigned_by_name, c.name AS client_name, b.name AS branch_name
     FROM permission_assignments p JOIN users u ON u.id=p.user_id
     LEFT JOIN users au ON au.id=p.assigned_by_user_id
     LEFT JOIN clients c ON c.id=p.client_id LEFT JOIN branches b ON b.id=p.branch_id
     ORDER BY p.user_id, p.id`
  );
  res.json({ assignments: rows });
});

router.post('/permissions', async (req, res) => {
  const actor = await getDemoActor(pool, req);
  const body = req.body || {};
  const userId = integerParam(body.userId, 'userId');
  const role = String(body.role || '').toLowerCase();
  const target = await repo.getUser(pool, userId);
  if (!target) return res.status(404).json({ error: 'Target user not found.' });
  const grants = await assignmentsFor(pool, actor.id);
  const definitions = await repo.getRoleDefinitions(pool);
  const roleDefinition = definitions.find(item => item.role === role);
  if (!roleDefinition) return res.status(400).json({ error: `Unknown role '${role}'. Create it with POST /roles first.` });
  const knownRoles = new Set(definitions.map(item => item.role));
  const change = validatePermissionChange(actor, userId, { role, userType: target.userType, allowedUserType: roleDefinition.allowed_user_type }, grants, new Date(), knownRoles);
  permitOrThrow(change);
  const scope = body.scope || {};
  if (typeof scope !== 'object' || Array.isArray(scope)) return res.status(400).json({ error: 'scope must be a JSON object.' });
  const clientId = scope.clientId === undefined || scope.clientId === null ? null : integerParam(scope.clientId, 'scope.clientId');
  const branchId = scope.branchId === undefined || scope.branchId === null ? null : integerParam(scope.branchId, 'scope.branchId');
  const direction = scope.direction ? String(scope.direction).toUpperCase() : null;
  const mode = scope.mode ? String(scope.mode).toUpperCase() : null;
  if (direction && !['IMPORT', 'EXPORT'].includes(direction)) return res.status(400).json({ error: 'scope.direction must be IMPORT or EXPORT.' });
  if (mode && !['AIR', 'FCL', 'LCL'].includes(mode)) return res.status(400).json({ error: 'scope.mode must be AIR, FCL or LCL.' });
  const reason = requiredReason(body.reason);
  const effectiveFrom = optionalTimestamp(body.effectiveFrom, 'effectiveFrom');
  const expiresAt = optionalTimestamp(body.expiresAt, 'expiresAt');
  if (expiresAt && new Date(expiresAt) <= new Date(effectiveFrom || Date.now())) {
    return res.status(400).json({ error: 'expiresAt must be later than effectiveFrom (or the current time when effectiveFrom is omitted).' });
  }
  const created = await withTransaction(async client => {
    const latestActor = await repo.getUser(client, actor.id);
    const latestGrants = await assignmentsFor(client, actor.id, { lock: true });
    permitOrThrow(canManagePermissions(latestActor, latestGrants));
    const latestTarget = await repo.getUser(client, userId);
    const latestDefinitions = await repo.getRoleDefinitions(client);
    const latestRoleDefinition = latestDefinitions.find(item => item.role === role);
    if (!latestTarget || !latestRoleDefinition) { const error = new Error('Target user or role changed before the permission could be saved.'); error.status = 409; throw error; }
    permitOrThrow(validatePermissionChange(latestActor, userId, { role, userType: latestTarget.userType, allowedUserType: latestRoleDefinition.allowed_user_type }, latestGrants, new Date(), new Set(latestDefinitions.map(item => item.role))));
    const { rows } = await client.query(
      `INSERT INTO permission_assignments(user_id,role,client_id,branch_id,direction,mode,effective_from,expires_at,assigned_by_user_id,reason)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,NOW()),$8,$9,$10) RETURNING *`,
      [userId, role, clientId, branchId, direction, mode, effectiveFrom, expiresAt, actor.id, reason]
    );
    const assignment = repo.mapAssignment(rows[0]);
    await repo.writeAudit(client, { actorUserId: actor.id, entityType: 'permission_assignment', entityId: assignment.id, action: 'permission.granted', afterState: assignment, reason, requestId: req.requestId });
    return assignment;
  });
  res.status(201).json({ success: true, assignment: created });
});

router.delete('/permissions/:assignmentId', async (req, res) => {
  const assignmentId = integerParam(req.params.assignmentId, 'assignmentId');
  const actor = await getDemoActor(pool, req);
  const revokeReason = requiredReason(req.body?.reason);
  const grants = await assignmentsFor(pool, actor.id);
  permitOrThrow(canManagePermissions(actor, grants));
  const result = await withTransaction(async client => {
    const latestActor = await repo.getUser(client, actor.id);
    permitOrThrow(canManagePermissions(latestActor, await assignmentsFor(client, actor.id, { lock: true })));
    const { rows } = await client.query('SELECT * FROM permission_assignments WHERE id=$1 FOR UPDATE', [assignmentId]);
    const row = rows[0];
    if (!row) { const error = new Error('Permission assignment not found.'); error.status = 404; throw error; }
    if (String(row.user_id) === String(actor.id)) {
      const error = new Error('Administrators cannot revoke their own grants; a second administrator must do it.'); error.status = 403; error.code = 'SELF_ESCALATION_BLOCKED'; throw error;
    }
    if (row.revoked_at) return { assignment: repo.mapAssignment(row), alreadyRevoked: true };
    const before = repo.mapAssignment(row);
    const { rows: updatedRows } = await client.query('UPDATE permission_assignments SET revoked_at=NOW() WHERE id=$1 RETURNING *', [assignmentId]);
    const after = repo.mapAssignment(updatedRows[0]);
    await repo.writeAudit(client, { actorUserId: actor.id, entityType: 'permission_assignment', entityId: assignmentId, action: 'permission.revoked', beforeState: before, afterState: after, reason: revokeReason, requestId: req.requestId });
    return { assignment: after, alreadyRevoked: false };
  });
  res.json({ success: true, ...result });
});

router.post('/parser/jobs', async (req, res) => {
  const actor = await getDemoActor(pool, req);
  const data = req.body || {};
  const reference = optionalString(data.reference, 'reference', { maxLength: 80 });
  const externalReference = optionalString(data.externalReference, 'externalReference', { nullable: true, maxLength: 200 });
  const description = data.description === undefined ? '' : optionalString(data.description, 'description', { maxLength: 2000 });
  const etaDate = optionalDate(data.etaDate, 'etaDate');
  const resource = {
    clientId: data.clientId === undefined || data.clientId === null ? null : integerParam(data.clientId, 'clientId'),
    branchId: data.branchId === undefined || data.branchId === null ? null : integerParam(data.branchId, 'branchId'),
    direction: data.direction && String(data.direction).toUpperCase(),
    mode: data.mode && String(data.mode).toUpperCase()
  };
  if (!reference || !reference.trim() || !resource.clientId || !resource.branchId || !resource.direction || !resource.mode) {
    return res.status(400).json({ error: 'reference, clientId, branchId, direction and mode are required.' });
  }
  if (!['IMPORT', 'EXPORT'].includes(resource.direction)) return res.status(400).json({ error: 'direction must be IMPORT or EXPORT.' });
  if (!['AIR', 'FCL', 'LCL'].includes(resource.mode)) return res.status(400).json({ error: 'mode must be AIR, FCL or LCL.' });
  const grants = await assignmentsFor(pool, actor.id);
  const roleActions = await repo.getRoleActions(pool);
  permitOrThrow(canPerform(actor, 'parser_create_job', null, grants, { resource, roleActions }));
  const result = await withTransaction(async client => {
    const latestActor = await repo.getUser(client, actor.id);
    const latestGrants = await assignmentsFor(client, actor.id, { lock: true });
    const latestRoleActions = await repo.getRoleActions(client);
    permitOrThrow(canPerform(latestActor, 'parser_create_job', null, latestGrants, { resource, roleActions: latestRoleActions }));
    const { rows } = await client.query(
      `INSERT INTO jobs(reference,external_reference,client_id,branch_id,direction,mode,stage,description,eta_date,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,'CONFIRMED',$7,$8,$9) RETURNING *`,
      [reference.trim(), externalReference ?? null, resource.clientId, resource.branchId, resource.direction, resource.mode, description, etaDate ?? null, actor.id]
    );
    const job = repo.mapJob(rows[0]);
    await repo.writeAudit(client, { actorUserId: actor.id, entityType: 'job', entityId: job.id, action: 'parser.job_created', afterState: snapshot(job), reason: 'Created by the overnight parser', requestId: req.requestId });
    return job;
  });
  res.status(201).json({ success: true, job: result });
});

router.patch('/parser/jobs/:jobId/metadata', async (req, res) => {
  const jobId = integerParam(req.params.jobId, 'jobId');
  const actor = await getDemoActor(pool, req);
  const fields = validateParserMetadata(req.body || {});
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Supply at least one metadata field.' });
  const job = await repo.getJob(pool, jobId);
  if (!job) return jobNotFound(res);
  const grants = await assignmentsFor(pool, actor.id);
  const roleActions = await repo.getRoleActions(pool);
  if (!canPerform(actor, 'parser_update_job', job, grants, { fields, roleActions }).allowed) return jobNotFound(res);
  const keys = Object.keys(fields);
  const setParts = [];
  const params = [];
  for (const key of keys) {
    params.push(fields[key]);
    setParts.push(`${PARSER_FIELD_TO_COLUMN[key]}=$${params.length}`);
  }
  params.push(jobId);
  const updated = await withTransaction(async client => {
    const lockedJob = await repo.getJob(client, jobId, { forUpdate: true });
    if (!lockedJob) throw concealedJobNotFoundError();
    const latestActor = await repo.getUser(client, actor.id);
    const latestGrants = await assignmentsFor(client, actor.id, { lock: true });
    const latestRoleActions = await repo.getRoleActions(client);
    if (!canPerform(latestActor, 'parser_update_job', lockedJob, latestGrants, { fields, roleActions: latestRoleActions }).allowed) throw concealedJobNotFoundError();
    const before = snapshot(lockedJob);
    const { rows } = await client.query(`UPDATE jobs SET ${setParts.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    const next = repo.mapJob(rows[0]);
    await repo.writeAudit(client, { actorUserId: actor.id, entityType: 'job', entityId: jobId, action: 'parser.metadata_updated', beforeState: before, afterState: snapshot(next), reason: 'Metadata update from overnight parser', requestId: req.requestId });
    return next;
  });
  res.json({ success: true, job: updated });
});

module.exports = router;
