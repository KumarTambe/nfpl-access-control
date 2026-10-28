CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  user_type TEXT NOT NULL CHECK (user_type IN ('internal', 'client', 'service')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'absent', 'disabled')),
  home_branch_id INTEGER REFERENCES branches(id),
  client_id INTEGER REFERENCES clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((user_type = 'client' AND client_id IS NOT NULL) OR user_type <> 'client')
);

CREATE TABLE IF NOT EXISTS user_status_history (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'absent', 'disabled')),
  effective_at TIMESTAMPTZ NOT NULL,
  changed_by_user_id INTEGER REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, effective_at)
);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  external_reference TEXT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  direction TEXT NOT NULL CHECK (direction IN ('IMPORT', 'EXPORT')),
  mode TEXT NOT NULL CHECK (mode IN ('AIR', 'FCL', 'LCL')),
  stage TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (stage IN ('CONFIRMED', 'PREPARED', 'CHECKED', 'FILED', 'CANCELLED', 'REOPENED')),
  description TEXT NOT NULL DEFAULT '',
  eta_date DATE,
  created_by_user_id INTEGER REFERENCES users(id),
  prepared_by_user_id INTEGER REFERENCES users(id),
  checked_by_user_id INTEGER REFERENCES users(id),
  filed_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_definitions (
  role TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  allowed_user_type TEXT CHECK (allowed_user_type IN ('internal', 'client', 'service')),
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_action_permissions (
  role TEXT NOT NULL REFERENCES role_definitions(role) ON DELETE CASCADE,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role, action),
  CHECK (action IN ('view_job', 'prepare_job', 'check_job', 'file_job', 'cancel_job', 'cancel_filed_job', 'reopen_filed_job', 'manage_permissions', 'parser_create_job', 'parser_update_job'))
);

CREATE TABLE IF NOT EXISTS permission_assignments (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL REFERENCES role_definitions(role),
  client_id INTEGER REFERENCES clients(id),
  branch_id INTEGER REFERENCES branches(id),
  direction TEXT CHECK (direction IN ('IMPORT', 'EXPORT')),
  mode TEXT CHECK (mode IN ('AIR', 'FCL', 'LCL')),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  assigned_by_user_id INTEGER REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at IS NULL OR expires_at > effective_from)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('job', 'permission_assignment', 'user', 'role')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  reason TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_stage_scope ON jobs(stage, client_id, branch_id, direction, mode);
CREATE INDEX IF NOT EXISTS idx_jobs_prepared_by_stage ON jobs(prepared_by_user_id, stage);
CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_permissions_user_role_active ON permission_assignments(user_id, role, effective_from, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_permissions_scope ON permission_assignments(client_id, branch_id, direction, mode) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_status_history_lookup ON user_status_history(user_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_job_time ON audit_logs(entity_type, entity_id, created_at DESC) WHERE entity_type = 'job';
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_logs(actor_user_id, created_at DESC);


-- Built-in role definitions and default action mappings. Custom roles may be added through POST /roles.
INSERT INTO role_definitions(role, description, allowed_user_type, is_builtin) VALUES
  ('maker', 'Prepares shipment work and may cancel unfiled jobs.', 'internal', TRUE),
  ('checker', 'Independently checks prepared work; cannot check own work.', 'internal', TRUE),
  ('filer', 'Files checked shipments.', 'internal', TRUE),
  ('workflow_admin', 'Handles filed-job cancellation and reopening exceptions with a reason.', 'internal', TRUE),
  ('access_admin', 'Manages permission assignments; does not automatically gain shipment access.', 'internal', TRUE),
  ('client_viewer', 'Read-only access to the assigned client’s shipments.', 'client', TRUE),
  ('parser', 'Service role for restricted overnight job ingestion and metadata updates.', 'service', TRUE)
ON CONFLICT (role) DO NOTHING;

INSERT INTO role_action_permissions(role, action) VALUES
  ('maker', 'view_job'), ('maker', 'prepare_job'), ('maker', 'cancel_job'),
  ('checker', 'view_job'), ('checker', 'check_job'), ('checker', 'cancel_job'),
  ('filer', 'view_job'), ('filer', 'file_job'), ('filer', 'cancel_job'),
  ('workflow_admin', 'view_job'), ('workflow_admin', 'cancel_filed_job'), ('workflow_admin', 'reopen_filed_job'),
  ('access_admin', 'manage_permissions'),
  ('client_viewer', 'view_job'),
  ('parser', 'parser_create_job'), ('parser', 'parser_update_job')
ON CONFLICT (role, action) DO NOTHING;
