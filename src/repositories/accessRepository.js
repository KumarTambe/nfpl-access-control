'use strict';

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    userType: row.user_type,
    status: row.status,
    homeBranchId: row.home_branch_id,
    clientId: row.client_id,
    createdAt: row.created_at
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    externalReference: row.external_reference,
    clientId: row.client_id,
    branchId: row.branch_id,
    direction: row.direction,
    mode: row.mode,
    stage: row.stage,
    description: row.description,
    etaDate: row.eta_date,
    createdById: row.created_by_user_id,
    preparedById: row.prepared_by_user_id,
    checkedById: row.checked_by_user_id,
    filedById: row.filed_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAssignment(row) {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    clientId: row.client_id,
    branchId: row.branch_id,
    direction: row.direction,
    mode: row.mode,
    effectiveFrom: row.effective_from,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    assignedByUserId: row.assigned_by_user_id,
    reason: row.reason,
    createdAt: row.created_at
  };
}


async function getRoleActions(db) {
  const { rows } = await db.query('SELECT role, action FROM role_action_permissions ORDER BY role, action');
  const result = {};
  for (const row of rows) (result[row.role] ||= []).push(row.action);
  return result;
}

async function getRoleDefinitions(db) {
  const { rows } = await db.query(
    `SELECT d.role, d.description, d.allowed_user_type, d.is_builtin, d.created_at,
            COALESCE(array_agg(p.action) FILTER (WHERE p.action IS NOT NULL), ARRAY[]::text[]) AS actions
     FROM role_definitions d LEFT JOIN role_action_permissions p ON p.role=d.role
     GROUP BY d.role ORDER BY d.is_builtin DESC, d.role`
  );
  return rows;
}

async function getRoleDefinition(db, role) {
  const { rows } = await db.query('SELECT * FROM role_definitions WHERE role=$1', [role]);
  return rows[0] || null;
}

async function getUser(db, id) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return mapUser(rows[0]);
}

async function getJob(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM jobs WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
  return mapJob(rows[0]);
}

async function getAssignmentsForUser(db, userId, { includeHistorical = false, lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM permission_assignments WHERE user_id = $1 ${includeHistorical ? '' : 'AND revoked_at IS NULL'} ORDER BY id ${lock ? 'FOR SHARE' : ''}`, 
    [userId]
  );
  return rows.map(mapAssignment);
}

async function getAllAssignments(db) {
  const { rows } = await db.query('SELECT * FROM permission_assignments ORDER BY id');
  return rows.map(mapAssignment);
}

async function getStatusesAt(db, at) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (user_id) user_id, status, effective_at
     FROM user_status_history
     WHERE effective_at <= $1
     ORDER BY user_id, effective_at DESC, id DESC`,
    [at]
  );
  return new Map(rows.map(row => [String(row.user_id), {
    status: row.status,
    effectiveAt: row.effective_at
  }]));
}

async function changeUserStatus(db, { userId, status, changedByUserId, reason }) {
  const { rows } = await db.query(
    `WITH updated AS (
       UPDATE users SET status=$1 WHERE id=$2 RETURNING *
     ), history AS (
       INSERT INTO user_status_history(user_id,status,effective_at,changed_by_user_id,reason)
       SELECT id,$1,NOW(),$3,$4 FROM updated
       RETURNING status, effective_at
     )
     SELECT updated.*, history.effective_at FROM updated CROSS JOIN history`,
    [status, userId, changedByUserId, reason]
  );
  return rows[0] ? { user: mapUser(rows[0]), effectiveAt: rows[0].effective_at } : null;
}

async function getJobHistory(db, jobId) {
  const { rows } = await db.query(
    `SELECT l.id, l.actor_user_id, u.name AS actor_name, l.action, l.before_state, l.after_state, l.reason, l.request_id, l.created_at
     FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_user_id
     WHERE l.entity_type = 'job' AND l.entity_id = $1 ORDER BY l.created_at ASC, l.id ASC`,
    [String(jobId)]
  );
  return rows;
}

async function writeAudit(db, event) {
  const { rows } = await db.query(
    `INSERT INTO audit_logs(actor_user_id,entity_type,entity_id,action,before_state,after_state,reason,request_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,
    [event.actorUserId ?? null, event.entityType, String(event.entityId), event.action,
      event.beforeState == null ? null : JSON.stringify(event.beforeState),
      event.afterState == null ? null : JSON.stringify(event.afterState),
      event.reason ?? null, event.requestId ?? null]
  );
  return rows[0];
}

async function listJobsNeedingUser(db, userId, { limit = 50, offset = 0 } = {}) {
  // Keep the same predicate for both total count and page selection; filter in PostgreSQL,
  // not by loading 200,000 jobs into Node. The stage rules mirror canPerform().
  const fromWhere = `
     FROM users u
     JOIN permission_assignments a ON a.user_id = u.id
     JOIN role_action_permissions rap ON rap.role = a.role AND rap.action IN ('prepare_job','check_job','file_job')
     JOIN jobs j ON (a.client_id IS NULL OR a.client_id = j.client_id)
                AND (a.branch_id IS NULL OR a.branch_id = j.branch_id)
                AND (a.direction IS NULL OR a.direction = j.direction)
                AND (a.mode IS NULL OR a.mode = j.mode)
     WHERE u.id = $1 AND u.status = 'active' AND u.user_type = 'internal'
       AND a.effective_from <= NOW() AND (a.expires_at IS NULL OR a.expires_at > NOW())
       AND (a.revoked_at IS NULL OR a.revoked_at > NOW())
       AND ((rap.action = 'prepare_job' AND j.stage IN ('CONFIRMED','REOPENED'))
         OR (rap.action = 'check_job' AND j.stage = 'PREPARED' AND j.prepared_by_user_id IS DISTINCT FROM u.id)
         OR (rap.action = 'file_job' AND j.stage = 'CHECKED'))
       AND EXISTS (
         SELECT 1 FROM permission_assignments va
         JOIN role_action_permissions vra ON vra.role = va.role AND vra.action = 'view_job'
         WHERE va.user_id = u.id
           AND (va.client_id IS NULL OR va.client_id = j.client_id)
           AND (va.branch_id IS NULL OR va.branch_id = j.branch_id)
           AND (va.direction IS NULL OR va.direction = j.direction)
           AND (va.mode IS NULL OR va.mode = j.mode)
           AND va.effective_from <= NOW()
           AND (va.expires_at IS NULL OR va.expires_at > NOW())
           AND (va.revoked_at IS NULL OR va.revoked_at > NOW())
       )`;
  const [countResult, pageResult] = await Promise.all([
    db.query(`SELECT COUNT(DISTINCT j.id)::int AS total ${fromWhere}`, [userId]),
    db.query(
      `SELECT DISTINCT j.*, rap.action AS next_action ${fromWhere}
       ORDER BY j.updated_at ASC, j.id ASC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    )
  ]);
  return {
    jobs: pageResult.rows.map(row => ({ ...mapJob(row), nextAction: row.next_action })),
    total: countResult.rows[0].total
  };
}

module.exports = {
  mapUser, mapJob, mapAssignment,
  getUser, getJob, getAssignmentsForUser, getAllAssignments, getRoleActions, getRoleDefinitions, getRoleDefinition,
  getStatusesAt, changeUserStatus, getJobHistory, writeAudit, listJobsNeedingUser
};
