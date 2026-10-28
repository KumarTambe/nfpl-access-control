'use strict';

const BRANCHES = ['Mumbai', 'Delhi', 'Chennai', 'Kolkata', 'Ahmedabad'];
const CLIENTS = ['Aster Imports', 'BluePeak Retail', 'Cedar Foods', 'Delta Machinery', 'Everest Pharma', 'Fairwind Textiles', 'Granite Auto', 'Harbor Electronics', 'Indigo Chemicals', 'Juniper Home'];
const USERS = [
  { id: 1, name: 'Asha Admin', type: 'internal', status: 'active', branch: 1 },
  { id: 2, name: 'Arjun Workflow Lead', type: 'internal', status: 'active', branch: 1 },
  { id: 3, name: 'Priya Maker-Checker', type: 'internal', status: 'active', branch: 1 },
  { id: 4, name: 'Rahul Import Checker', type: 'internal', status: 'active', branch: 1 },
  { id: 5, name: 'Meera Maker', type: 'internal', status: 'active', branch: 1 },
  { id: 6, name: 'Dev Filer', type: 'internal', status: 'active', branch: 2 },
  { id: 7, name: 'Sameer Absent Checker', type: 'internal', status: 'absent', branch: 1 },
  { id: 8, name: 'Nina Client User', type: 'client', status: 'active', branch: 2, client: 2 },
  { id: 9, name: 'Night Parser Service', type: 'service', status: 'active', branch: 1 },
  { id: 10, name: 'Aditi Temporary Checker', type: 'internal', status: 'active', branch: 1 },
  { id: 11, name: 'Kabir Maker', type: 'internal', status: 'active', branch: 2 },
  { id: 12, name: 'Ira Checker', type: 'internal', status: 'active', branch: 2 },
  { id: 13, name: 'Rohan Maker', type: 'internal', status: 'active', branch: 3 },
  { id: 14, name: 'Tara Checker', type: 'internal', status: 'active', branch: 3 },
  { id: 15, name: 'Veer Filer', type: 'internal', status: 'active', branch: 4 },
  { id: 16, name: 'Mira Maker', type: 'internal', status: 'active', branch: 4 },
  { id: 17, name: 'Neil Checker', type: 'internal', status: 'active', branch: 5 },
  { id: 18, name: 'Sara Maker', type: 'internal', status: 'active', branch: 5 },
  { id: 19, name: 'Omni Ops', type: 'internal', status: 'active', branch: 2 },
  { id: 20, name: 'Pia Client Viewer', type: 'client', status: 'active', branch: 3, client: 3 }
];

async function seed(pool) {
  await pool.query('BEGIN');
  try {
    await pool.query('TRUNCATE audit_logs, user_status_history, permission_assignments, jobs, users, clients, branches RESTART IDENTITY CASCADE');
    for (const name of BRANCHES) await pool.query('INSERT INTO branches(name) VALUES ($1)', [name]);
    for (const name of CLIENTS) await pool.query('INSERT INTO clients(name) VALUES ($1)', [name]);
    for (const u of USERS) {
      await pool.query(
        `INSERT INTO users(id,name,email,user_type,status,home_branch_id,client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [u.id, u.name, `${u.id === 9 ? 'parser' : u.name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@nfpl.example`, u.type, u.status, u.branch, u.client || null]
      );
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('users','id'), 20, true)`);
    await pool.query(
      `INSERT INTO user_status_history(user_id,status,effective_at,changed_by_user_id,reason)
       SELECT id,status,created_at,NULL,'Initial seeded status' FROM users`
    );

    const roleDefinitions = [
      ['maker', 'Prepares shipment work and may cancel unfiled jobs.', 'internal'],
      ['checker', 'Independently checks prepared work; cannot check own work.', 'internal'],
      ['filer', 'Files checked shipments.', 'internal'],
      ['workflow_admin', 'Handles filed-job cancellation and reopening exceptions with a reason.', 'internal'],
      ['access_admin', 'Manages permission assignments; does not automatically gain shipment access.', 'internal'],
      ['client_viewer', 'Read-only access to the assigned client’s shipments.', 'client'],
      ['parser', 'Service role for restricted overnight job ingestion and metadata updates.', 'service']
    ];
    for (const [role, description, allowedUserType] of roleDefinitions) {
      await pool.query('INSERT INTO role_definitions(role,description,allowed_user_type,is_builtin) VALUES ($1,$2,$3,TRUE)', [role, description, allowedUserType]);
    }
    const defaultRoleActions = {
      maker: ['view_job', 'prepare_job', 'cancel_job'],
      checker: ['view_job', 'check_job', 'cancel_job'],
      filer: ['view_job', 'file_job', 'cancel_job'],
      workflow_admin: ['view_job', 'cancel_filed_job', 'reopen_filed_job'],
      access_admin: ['manage_permissions'],
      client_viewer: ['view_job'],
      parser: ['parser_create_job', 'parser_update_job']
    };
    for (const [role, actions] of Object.entries(defaultRoleActions)) {
      for (const action of actions) await pool.query('INSERT INTO role_action_permissions(role,action) VALUES ($1,$2)', [role, action]);
    }

    const grants = [
      [1, 'access_admin', null, null, null, null, 'Global access administrator; cannot alter own permissions'],
      [2, 'workflow_admin', null, null, null, null, 'Handles high-risk workflow exceptions with a recorded reason'],
      [3, 'maker', null, null, null, null, 'Maker for every client, branch, direction and mode'],
      [3, 'checker', 2, null, null, null, 'Checker only for BluePeak Retail; does not override maker/checker separation'],
      [4, 'checker', 1, 1, 'IMPORT', null, 'Checker for Aster Imports at Mumbai branch, imports only'],
      [5, 'maker', null, null, null, null, 'Maker for all operational work'],
      [6, 'filer', null, null, null, null, 'Filer for all operational work'],
      [7, 'checker', 1, 1, 'IMPORT', null, 'Absent checker; cannot act while status is absent'],
      [8, 'client_viewer', 2, null, null, null, 'Client-side user may view only own client shipments'],
      [9, 'parser', null, null, null, null, 'Dedicated service account for overnight parser'],
      [10, 'checker', 1, 1, 'IMPORT', null, 'Temporary cover for Aster import work; expires automatically'],
      [11, 'maker', null, 2, null, null, 'Maker for work handled at Delhi'],
      [12, 'checker', 2, 2, null, null, 'Checker for BluePeak at Delhi'],
      [13, 'maker', null, 3, null, null, 'Maker for Chennai branch'],
      [14, 'checker', null, 3, null, null, 'Checker for Chennai branch'],
      [15, 'filer', null, 4, null, null, 'Filer for Kolkata branch'],
      [16, 'maker', null, 4, null, null, 'Maker for Kolkata branch'],
      [17, 'checker', null, 5, null, null, 'Checker for Ahmedabad branch'],
      [18, 'maker', null, 5, null, null, 'Maker for Ahmedabad branch'],
      [19, 'maker', 3, 2, 'EXPORT', 'FCL', 'Maker for Cedar Foods exports at Delhi, FCL only'],
      [20, 'client_viewer', 3, null, null, null, 'Client-side user may view only Cedar Foods shipments']
    ];
    for (const [userId, role, clientId, branchId, direction, mode, reason] of grants) {
      const expires = userId === 10 ? "NOW() + INTERVAL '7 days'" : 'NULL';
      await pool.query(
        `INSERT INTO permission_assignments(user_id,role,client_id,branch_id,direction,mode,assigned_by_user_id,reason,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${expires})`,
        [userId, role, clientId, branchId, direction, mode, 1, reason]
      );
    }

    const focusedJobs = [
      { id: 1, ref: 'NFPL-0001', client: 1, branch: 1, direction: 'IMPORT', mode: 'AIR', stage: 'PREPARED', preparedBy: 5, description: 'Aster import at Mumbai; Rahul can check' },
      { id: 2, ref: 'NFPL-0002', client: 1, branch: 1, direction: 'EXPORT', mode: 'FCL', stage: 'PREPARED', preparedBy: 5, description: 'Aster export at Mumbai; Rahul cannot check because import-only' },
      { id: 3, ref: 'NFPL-0003', client: 2, branch: 2, direction: 'IMPORT', mode: 'LCL', stage: 'PREPARED', preparedBy: 5, description: 'BluePeak job; Priya is a Checker for this client' },
      { id: 4, ref: 'NFPL-0004', client: 2, branch: 2, direction: 'IMPORT', mode: 'AIR', stage: 'PREPARED', preparedBy: 3, description: 'Priya prepared this; self-check must be denied' },
      { id: 5, ref: 'NFPL-0005', client: 1, branch: 1, direction: 'IMPORT', mode: 'AIR', stage: 'CONFIRMED', preparedBy: null, description: 'Confirmed job waiting for a Maker' },
      { id: 6, ref: 'NFPL-0006', client: 1, branch: 1, direction: 'IMPORT', mode: 'FCL', stage: 'FILED', preparedBy: 5, checkedBy: 4, filedBy: 6, description: 'Filed job; requires exception process to reopen/cancel' },
      { id: 7, ref: 'NFPL-0007', client: 3, branch: 3, direction: 'EXPORT', mode: 'FCL', stage: 'CHECKED', preparedBy: 13, checkedBy: 14, description: 'Checked job waiting for a Filer' },
      { id: 8, ref: 'NFPL-0008', client: 2, branch: 2, direction: 'IMPORT', mode: 'AIR', stage: 'CANCELLED', preparedBy: 5, description: 'Cancelled job; can be reopened only via exception flow' },
      { id: 9, ref: 'NFPL-0009', client: 3, branch: 3, direction: 'IMPORT', mode: 'LCL', stage: 'REOPENED', preparedBy: null, description: 'Reopened job waiting to be prepared again' },
      { id: 10, ref: 'NFPL-0010', client: 1, branch: 2, direction: 'IMPORT', mode: 'AIR', stage: 'CONFIRMED', preparedBy: null, description: 'Different branch; Rahul has no access here' }
    ];
    for (const j of focusedJobs) {
      await pool.query(
        `INSERT INTO jobs(id,reference,client_id,branch_id,direction,mode,stage,description,created_by_user_id,prepared_by_user_id,checked_by_user_id,filed_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [j.id, j.ref, j.client, j.branch, j.direction, j.mode, j.stage, j.description, 5, j.preparedBy, j.checkedBy ?? null, j.filedBy ?? null]
      );
    }
    // Curated sample of 300 total jobs: the first 10 are deliberately selected edge cases.
    for (let i = 11; i <= 300; i++) {
      const client = ((i - 1) % 10) + 1;
      const branch = ((i - 1) % 5) + 1;
      const direction = i % 2 === 0 ? 'IMPORT' : 'EXPORT';
      const mode = ['AIR', 'FCL', 'LCL'][i % 3];
      const stage = ['CONFIRMED', 'PREPARED', 'CHECKED', 'FILED', 'REOPENED'][i % 5];
      const preparedBy = stage === 'PREPARED' || stage === 'CHECKED' || stage === 'FILED' || stage === 'REOPENED' ? ((i % 10) + 3) : null;
      const checkedBy = stage === 'CHECKED' || stage === 'FILED' ? (((i + 3) % 10) + 3) : null;
      const filedBy = stage === 'FILED' ? 6 : null;
      await pool.query(
        `INSERT INTO jobs(id,reference,client_id,branch_id,direction,mode,stage,description,created_by_user_id,prepared_by_user_id,checked_by_user_id,filed_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [i, `NFPL-${String(i).padStart(4, '0')}`, client, branch, direction, mode, stage, `Sample shipment ${i}`, ((i % 15) + 3), preparedBy, checkedBy, filedBy]
      );
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('jobs','id'), 300, true)`);

    // Seed audit events for the ten deliberate cases so the history endpoint has examples to show.
    await pool.query(
      `INSERT INTO audit_logs(actor_user_id,entity_type,entity_id,action,after_state,reason)
       SELECT NULL, 'job', id::text, 'job.imported_snapshot', to_jsonb(j),
              'Seed baseline snapshot; original action history is not assumed'
       FROM jobs j WHERE id <= 300`
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

module.exports = seed;
