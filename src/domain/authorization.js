'use strict';

const ALL_ROLES = new Set([
  'maker', 'checker', 'filer', 'workflow_admin',
  'access_admin', 'client_viewer', 'parser'
]);

const ROLE_ACTIONS = {
  maker: ['view_job', 'prepare_job', 'cancel_job'],
  checker: ['view_job', 'check_job', 'cancel_job'],
  filer: ['view_job', 'file_job', 'cancel_job'],
  workflow_admin: ['view_job', 'cancel_filed_job', 'reopen_filed_job'],
  access_admin: ['manage_permissions'],
  client_viewer: ['view_job'],
  parser: ['parser_create_job', 'parser_update_job']
};

const SCOPE_FIELDS = ['clientId', 'branchId', 'direction', 'mode'];
const PRE_FILED_STAGES = new Set(['CONFIRMED', 'PREPARED', 'CHECKED', 'REOPENED']);
const PARSER_EDITABLE_FIELDS = new Set(['externalReference', 'description', 'etaDate']);

function normalizeId(value) {
  return value === null || value === undefined ? null : String(value);
}

function sameId(left, right) {
  return normalizeId(left) === normalizeId(right);
}

function valueOf(obj, camel, snake) {
  return obj?.[camel] !== undefined ? obj[camel] : obj?.[snake];
}

function scopeMatches(assignment, resource) {
  if (!resource) return false;
  const pairs = [
    ['clientId', 'client_id'],
    ['branchId', 'branch_id'],
    ['direction', 'direction'],
    ['mode', 'mode']
  ];
  return pairs.every(([camel, snake]) => {
    const allowed = valueOf(assignment, camel, snake);
    const actual = valueOf(resource, camel, snake);
    return allowed === null || allowed === undefined || String(allowed).toUpperCase() === String(actual).toUpperCase();
  });
}

function assignmentIsEffective(assignment, now = new Date()) {
  const time = new Date(now).getTime();
  const effectiveFrom = valueOf(assignment, 'effectiveFrom', 'effective_from');
  const expiresAt = valueOf(assignment, 'expiresAt', 'expires_at');
  const revokedAt = valueOf(assignment, 'revokedAt', 'revoked_at');
  if (revokedAt && new Date(revokedAt).getTime() <= time) return false;
  if (effectiveFrom && new Date(effectiveFrom).getTime() > time) return false;
  if (expiresAt && new Date(expiresAt).getTime() <= time) return false;
  return true;
}

function activeAssignmentsFor(user, assignments, now = new Date()) {
  return assignments.filter(a =>
    sameId(valueOf(a, 'userId', 'user_id'), user.id) &&
    assignmentIsEffective(a, now)
  );
}

function hasScopedRole(user, role, resource, assignments, now = new Date()) {
  return activeAssignmentsFor(user, assignments, now).some(a =>
    a.role === role && scopeMatches(a, resource)
  );
}

function hasScopedAction(user, action, resource, assignments, now = new Date(), roleActions = ROLE_ACTIONS) {
  return activeAssignmentsFor(user, assignments, now).some(a =>
    (roleActions[a.role] || []).includes(action) && scopeMatches(a, resource)
  );
}

function deny(code, reason) {
  return { allowed: false, code, reason };
}

function allow(code, reason) {
  return { allowed: true, code, reason };
}

/**
 * Explainable policy function. It intentionally fails closed: missing data,
 * unsupported actions, inactive users, and unmatched scopes are denied.
 */
function canPerform(user, action, job, assignments, context = {}, now = new Date()) {
  if (!user) return deny('USER_NOT_FOUND', 'The user does not exist.');
  if (context.statusKnown === false) {
    return deny('USER_STATUS_HISTORY_MISSING', 'The user status is not recorded for the requested historical time, so access is denied.');
  }
  const status = context.statusAt ?? user.status;
  if (status !== 'active') {
    return deny('USER_NOT_ACTIVE', `The user is ${status}; inactive users cannot perform actions.`);
  }
  if (!action) return deny('INVALID_ACTION', 'An action is required.');
  const roleActions = context.roleActions || ROLE_ACTIONS;
  const userType = user.userType ?? user.user_type;

  if (action === 'parser_create_job') {
    if (user.userType !== 'service' && user.user_type !== 'service') {
      return deny('SERVICE_ACCOUNT_REQUIRED', 'Only a dedicated service account may create jobs through the parser endpoint.');
    }
    const resource = context.resource;
    if (!resource) return deny('JOB_DATA_REQUIRED', 'The proposed job data is required to check the parser scope.');
    if (!hasScopedAction(user, action, resource, assignments, now, roleActions)) {
      return deny('SCOPE_MISMATCH', 'The parser has no effective permission covering this client, branch, direction and mode.');
    }
    return allow('PARSER_CREATE_ALLOWED', 'The service account has an effective parser grant for the proposed job scope.');
  }

  if (action === 'manage_permissions') {
    return canManagePermissions(user, assignments, now);
  }

  if (!job) return deny('JOB_NOT_FOUND', 'The job does not exist.');
  const supportedJobActions = new Set(['view_job', 'prepare_job', 'check_job', 'file_job', 'cancel_job', 'cancel_filed_job', 'reopen_filed_job', 'parser_update_job']);
  if (!supportedJobActions.has(action)) return deny('ACTION_NOT_SUPPORTED', `Action '${action}' is not supported.`);

  if (action === 'view_job' && userType === 'client') {
    if (!sameId(user.clientId ?? user.client_id, job.clientId ?? job.client_id)) {
      return deny('CLIENT_BOUNDARY', 'Client users can only view shipments belonging to their own client.');
    }
    return hasScopedAction(user, action, job, assignments, now, roleActions)
      ? allow('CLIENT_READ_ALLOWED', 'The user has an effective read-only role for their own client and the job is within scope.')
      : deny('NO_MATCHING_PERMISSION', 'The user has no effective client-viewer permission for this job.');
  }

  if (action === 'view_job') {
    if (userType !== 'internal') return deny('USER_TYPE_RESTRICTED', 'Only internal staff or a client user within their own client boundary may view shipments.');
    const matched = activeAssignmentsFor(user, assignments, now).find(a => (roleActions[a.role] || []).includes('view_job') && scopeMatches(a, job));
    return matched
      ? allow('VIEW_ALLOWED', `The user has the ${matched.role} role within this job's scope.`)
      : deny('NO_MATCHING_PERMISSION', 'No effective permission grants visibility to this job. Access-admin status alone does not grant shipment access.');
  }

  if (userType !== 'internal' && !['parser_create_job', 'parser_update_job'].includes(action)) {
    return deny('USER_TYPE_RESTRICTED', 'This action is reserved for internal staff.');
  }

  if (action === 'parser_update_job') {
    if ((user.userType ?? user.user_type) !== 'service') {
      return deny('SERVICE_ACCOUNT_REQUIRED', 'Only the dedicated parser service account may update jobs through the parser endpoint.');
    }
    if (!hasScopedAction(user, action, job, assignments, now, roleActions)) {
      return deny('SCOPE_MISMATCH', 'The parser has no effective permission covering this job.');
    }
    if (['FILED', 'CANCELLED'].includes((job.stage || '').toUpperCase())) {
      return deny('PARSER_FINALIZED_JOB', 'The parser cannot update a filed or cancelled job.');
    }
    const fields = Object.keys(context.fields || {});
    const forbidden = fields.filter(field => !PARSER_EDITABLE_FIELDS.has(field));
    if (forbidden.length) {
      return deny('PARSER_FIELD_RESTRICTED', `The parser may update metadata only; restricted fields: ${forbidden.join(', ')}.`);
    }
    return allow('PARSER_UPDATE_ALLOWED', 'The parser is in scope, the job is not finalized, and only permitted metadata fields were supplied.');
  }

  const knownWorkflowActions = new Set(['prepare_job', 'check_job', 'file_job', 'cancel_job', 'cancel_filed_job', 'reopen_filed_job']);
  if (!knownWorkflowActions.has(action)) return deny('ACTION_NOT_SUPPORTED', `Action '${action}' is not supported.`);

  // Check role + scope before returning workflow-stage details, to avoid leaking a job's state to an out-of-scope user.
  const matched = activeAssignmentsFor(user, assignments, now).find(a =>
    (roleActions[a.role] || []).includes(action) && scopeMatches(a, job)
  );
  if (!matched) return deny('NO_MATCHING_PERMISSION', `No effective role grants '${action}' for this client, branch, direction and mode.`);

  // Workflow APIs return the resulting job record. Require a matching view grant as well,
  // so a custom role cannot mutate a job and learn its details without visibility permission.
  const canViewInScope = activeAssignmentsFor(user, assignments, now).some(a =>
    (roleActions[a.role] || []).includes('view_job') && scopeMatches(a, job)
  );
  if (!canViewInScope) {
    return deny('VIEW_PERMISSION_REQUIRED', 'A workflow action also requires effective view_job permission for this job.');
  }

  const stage = String(job.stage || '').toUpperCase();
  const reason = String(context.reason || '').trim();
  if (['cancel_job', 'cancel_filed_job', 'reopen_filed_job'].includes(action) && reason.length < 8) {
    return deny('REASON_REQUIRED', 'A meaningful reason of at least 8 characters is required for this exceptional action.');
  }

  if (action === 'prepare_job' && !['CONFIRMED', 'REOPENED'].includes(stage)) {
    return deny('INVALID_STAGE', `A user with prepare_job permission can prepare only a Confirmed or Reopened job; this job is ${stage}.`);
  }
  if (action === 'check_job') {
    if (stage !== 'PREPARED') return deny('INVALID_STAGE', `A user with check_job permission can check only a Prepared job; this job is ${stage}.`);
    if (sameId(user.id, job.preparedById ?? job.prepared_by_user_id)) {
      return deny('SEPARATION_OF_DUTIES', 'The person who prepared the job cannot check their own work.');
    }
  }
  if (action === 'file_job' && stage !== 'CHECKED') {
    return deny('INVALID_STAGE', `A user with file_job permission can file only a Checked job; this job is ${stage}.`);
  }
  if (action === 'cancel_job' && !PRE_FILED_STAGES.has(stage)) {
    return deny('USE_EXCEPTION_WORKFLOW', 'Routine cancellation is only allowed before filing; filed jobs require the controlled exception action.');
  }
  if (action === 'cancel_filed_job' && stage !== 'FILED') {
    return deny('INVALID_STAGE', `Only a Filed job can be cancelled through the filed-job exception; this job is ${stage}.`);
  }
  if (action === 'reopen_filed_job' && !['FILED', 'CANCELLED'].includes(stage)) {
    return deny('INVALID_STAGE', `Only a Filed or Cancelled job can be reopened; this job is ${stage}.`);
  }

  if (action === 'cancel_job') {
    return allow('CANCEL_ALLOWED', `The user has the ${matched.role} role in scope, the job is not filed, and a reason was supplied.`);
  }
  return allow('ACTION_ALLOWED', `The user's ${matched.role} role is in scope and the workflow stage permits ${action}.`);
}

function canManagePermissions(actor, assignments, now = new Date()) {
  if (!actor) return deny('USER_NOT_FOUND', 'The acting user does not exist.');
  if (actor.status !== 'active') return deny('USER_NOT_ACTIVE', 'Only an active user may manage permissions.');
  if ((actor.userType ?? actor.user_type) !== 'internal') return deny('USER_TYPE_RESTRICTED', 'Permission management is reserved for internal staff.');
  const isGlobalAccessAdmin = activeAssignmentsFor(actor, assignments, now).some(a =>
    a.role === 'access_admin' && SCOPE_FIELDS.every(field => {
      const value = valueOf(a, field, field.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`));
      return value === null || value === undefined;
    })
  );
  return isGlobalAccessAdmin
    ? allow('PERMISSION_MANAGEMENT_ALLOWED', 'The actor has a global, effective access_admin grant.')
    : deny('ACCESS_ADMIN_REQUIRED', 'Permission management requires a global access_admin grant.');
}

function validatePermissionChange(actor, targetUserId, assignmentInput, assignments, now = new Date(), knownRoles = ALL_ROLES) {
  const manageDecision = canManagePermissions(actor, assignments, now);
  if (!manageDecision.allowed) return manageDecision;
  if (sameId(actor.id, targetUserId)) {
    return deny('SELF_ESCALATION_BLOCKED', 'Administrators cannot change their own grants; a second administrator must make the change.');
  }
  if (!knownRoles.has(assignmentInput.role)) {
    return deny('UNKNOWN_ROLE', `Role '${assignmentInput.role}' is not recognized.`);
  }
  if (assignmentInput.allowedUserType && assignmentInput.allowedUserType !== assignmentInput.userType) {
    return deny('ROLE_USER_TYPE_MISMATCH', `Role '${assignmentInput.role}' may only be assigned to ${assignmentInput.allowedUserType} users.`);
  }
  if (assignmentInput.role === 'parser' && assignmentInput.userType !== 'service') {
    return deny('PARSER_ROLE_RESTRICTED', 'The parser role can only be assigned to a service account.');
  }
  return allow('PERMISSION_CHANGE_ALLOWED', 'The active global access administrator may change another user’s permissions.');
}

module.exports = {
  ALL_ROLES,
  ROLE_ACTIONS,
  SCOPE_FIELDS,
  assignmentIsEffective,
  scopeMatches,
  activeAssignmentsFor,
  hasScopedRole,
  hasScopedAction,
  canPerform,
  canManagePermissions,
  validatePermissionChange
};
