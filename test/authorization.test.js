'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canPerform,
  canManagePermissions,
  validatePermissionChange,
  assignmentIsEffective
} = require('../src/domain/authorization');

const now = new Date('2026-10-28T15:00:00.000Z');
const activeUser = (id, extra = {}) => ({ id, name: `User ${id}`, userType: 'internal', status: 'active', ...extra });
const job = (extra = {}) => ({
  id: 101, clientId: 1, branchId: 1, direction: 'IMPORT', mode: 'AIR', stage: 'PREPARED', preparedById: 50,
  ...extra
});
const grant = (userId, role, extra = {}) => ({
  id: 1, userId, role, clientId: null, branchId: null, direction: null, mode: null,
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), expiresAt: null, revokedAt: null,
  ...extra
});

function testDecision(user, action, resource, assignments, context = {}) {
  return canPerform(user, action, resource, assignments, context, now);
}

test('scoped Checker can check an in-scope Prepared import', () => {
  const user = activeUser(4);
  const checker = grant(4, 'checker', { clientId: 1, branchId: 1, direction: 'IMPORT' });
  const result = testDecision(user, 'check_job', job(), [checker]);
  assert.equal(result.allowed, true);
  assert.match(result.reason, /checker/i);
});

test('Checker cannot act outside their direction scope (export)', () => {
  const user = activeUser(4);
  const checker = grant(4, 'checker', { clientId: 1, branchId: 1, direction: 'IMPORT' });
  const result = testDecision(user, 'check_job', job({ direction: 'EXPORT' }), [checker]);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'NO_MATCHING_PERMISSION');
});

test('maker/checker conflict: a person cannot check their own work even if they also have Checker role', () => {
  const priya = activeUser(3);
  const assignments = [grant(3, 'maker'), grant(3, 'checker', { clientId: 2 })];
  const result = testDecision(priya, 'check_job', job({ clientId: 2, preparedById: 3 }), assignments);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'SEPARATION_OF_DUTIES');
});

test('absent owner cannot perform an otherwise permitted action', () => {
  const absent = activeUser(7, { status: 'absent' });
  const result = testDecision(absent, 'check_job', job(), [grant(7, 'checker')]);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'USER_NOT_ACTIVE');
});

test('revoked responsibility takes effect immediately', () => {
  const user = activeUser(4);
  const previouslyGranted = grant(4, 'checker', { revokedAt: new Date('2026-10-28T14:59:00.000Z') });
  const result = testDecision(user, 'check_job', job(), [previouslyGranted]);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'NO_MATCHING_PERMISSION');
  assert.equal(assignmentIsEffective(previouslyGranted, now), false);
});

test('routine cancellation cannot cancel a filed job', () => {
  const maker = activeUser(5);
  const result = testDecision(maker, 'cancel_job', job({ stage: 'FILED' }), [grant(5, 'maker')], { reason: 'Client requested cancellation' });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'USE_EXCEPTION_WORKFLOW');
});

test('workflow administrator can cancel a filed job only with a reason', () => {
  const admin = activeUser(2);
  const assignments = [grant(2, 'workflow_admin')];
  assert.equal(testDecision(admin, 'cancel_filed_job', job({ stage: 'FILED' }), assignments).code, 'REASON_REQUIRED');
  const result = testDecision(admin, 'cancel_filed_job', job({ stage: 'FILED' }), assignments, { reason: 'Customs filing must be corrected' });
  assert.equal(result.allowed, true);
});

test('workflow administrator can reopen a filed job with a reason, but not an unrelated stage', () => {
  const admin = activeUser(2);
  const assignments = [grant(2, 'workflow_admin')];
  assert.equal(testDecision(admin, 'reopen_filed_job', job({ stage: 'FILED' }), assignments, { reason: 'Correct filing reference' }).allowed, true);
  assert.equal(testDecision(admin, 'reopen_filed_job', job({ stage: 'PREPARED' }), assignments, { reason: 'Correct filing reference' }).code, 'INVALID_STAGE');
});

test('access administrator cannot grant themselves more power', () => {
  const admin = activeUser(1);
  const assignments = [grant(1, 'access_admin')];
  const result = validatePermissionChange(admin, 1, { role: 'workflow_admin', userType: 'internal' }, assignments, now);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'SELF_ESCALATION_BLOCKED');
});

test('only a global access administrator can manage permission grants', () => {
  assert.equal(canManagePermissions(activeUser(1), [grant(1, 'access_admin')], now).allowed, true);
  assert.equal(canManagePermissions(activeUser(4), [grant(4, 'checker')], now).code, 'ACCESS_ADMIN_REQUIRED');
  assert.equal(canManagePermissions(activeUser(1), [grant(1, 'access_admin', { clientId: 1 })], now).allowed, false);
});

test('parser may update safe metadata but cannot alter workflow stage fields', () => {
  const parser = activeUser(9, { userType: 'service' });
  const assignments = [grant(9, 'parser')];
  assert.equal(testDecision(parser, 'parser_update_job', job(), assignments, { fields: { description: 'Corrected description' } }).allowed, true);
  assert.equal(testDecision(parser, 'parser_update_job', job(), assignments, { fields: { stage: 'FILED' } }).code, 'PARSER_FIELD_RESTRICTED');
});

test('parser cannot update a filed job', () => {
  const parser = activeUser(9, { userType: 'service' });
  const result = testDecision(parser, 'parser_update_job', job({ stage: 'FILED' }), [grant(9, 'parser')], { fields: { description: 'late correction' } });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'PARSER_FINALIZED_JOB');
});

test('client viewer can view their own client job but not another client', () => {
  const clientUser = activeUser(8, { userType: 'client', clientId: 2 });
  const assignments = [grant(8, 'client_viewer', { clientId: 2 })];
  assert.equal(testDecision(clientUser, 'view_job', job({ clientId: 2 }), assignments).allowed, true);
  assert.equal(testDecision(clientUser, 'view_job', job({ clientId: 1 }), assignments).code, 'CLIENT_BOUNDARY');
});

test('unrecognized action fails closed', () => {
  const result = testDecision(activeUser(5), 'delete_everything', job(), [grant(5, 'maker')]);
  assert.equal(result.allowed, false);
});

test('custom role can reuse an existing action without a code change', () => {
  const reviewer = activeUser(21);
  const assignments = [grant(21, 'shipment_reviewer', { clientId: 1, branchId: 1, direction: 'IMPORT' })];
  const roleActions = { shipment_reviewer: ['view_job', 'check_job'] };
  const result = canPerform(reviewer, 'check_job', job(), assignments, { roleActions }, now);
  assert.equal(result.allowed, true);
  assert.match(result.reason, /shipment_reviewer/);
});

test('custom roles do not bypass workflow stage rules', () => {
  const reviewer = activeUser(21);
  const assignments = [grant(21, 'shipment_reviewer', { clientId: 1, branchId: 1, direction: 'IMPORT' })];
  const roleActions = { shipment_reviewer: ['view_job', 'check_job'] };
  const result = canPerform(reviewer, 'check_job', job({ stage: 'CONFIRMED' }), assignments, { roleActions }, now);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID_STAGE');
});

test('parser may create only inside the assigned scope', () => {
  const parser = activeUser(9, { userType: 'service' });
  const roleActions = { parser: ['parser_create_job', 'parser_update_job'] };
  const assignment = grant(9, 'parser', { clientId: 1, branchId: 1, direction: 'IMPORT' });
  const allowed = canPerform(parser, 'parser_create_job', null, [assignment], {
    resource: { clientId: 1, branchId: 1, direction: 'IMPORT', mode: 'AIR' }, roleActions
  }, now);
  const denied = canPerform(parser, 'parser_create_job', null, [assignment], {
    resource: { clientId: 1, branchId: 2, direction: 'IMPORT', mode: 'AIR' }, roleActions
  }, now);
  assert.equal(allowed.allowed, true);
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'SCOPE_MISMATCH');
});

test('a future-effective permission is not usable early', () => {
  const user = activeUser(4);
  const futureGrant = grant(4, 'checker', { effectiveFrom: new Date('2026-10-29T00:00:00.000Z') });
  const result = testDecision(user, 'check_job', job(), [futureGrant]);
  assert.equal(result.allowed, false);
});

test('client and service identities cannot use internal workflow grants', () => {
  const clientUser = activeUser(8, { userType: 'client', clientId: 1 });
  const serviceUser = activeUser(9, { userType: 'service' });
  assert.equal(testDecision(clientUser, 'check_job', job(), [grant(8, 'checker')]).code, 'USER_TYPE_RESTRICTED');
  assert.equal(testDecision(serviceUser, 'check_job', job(), [grant(9, 'checker')]).code, 'USER_TYPE_RESTRICTED');
});

test('a custom workflow action without a matching view grant cannot mutate or disclose a job', () => {
  const reviewer = activeUser(21);
  const assignments = [grant(21, 'action_only_reviewer', { clientId: 1, branchId: 1, direction: 'IMPORT' })];
  const roleActions = { action_only_reviewer: ['check_job'] };
  const result = canPerform(reviewer, 'check_job', job(), assignments, { roleActions }, now);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'VIEW_PERMISSION_REQUIRED');
});

test('access administrator does not gain shipment workflow permissions automatically', () => {
  const admin = activeUser(1);
  const assignments = [grant(1, 'access_admin')];
  const result = testDecision(admin, 'prepare_job', job({ stage: 'CONFIRMED' }), assignments);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'NO_MATCHING_PERMISSION');
});
