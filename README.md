# NFPL Access Control Service

A small, explainable authorization API for a customs brokerage. It decides who may view or act on a shipment, applies workflow and separation-of-duties rules, keeps an audit trail, and retains permission history for investigation.

> **Assessment honesty note:** This project was developed with AI assistance for implementation planning, code drafting, tests, and documentation. Review every file, run the project, adapt the design to your own decisions, and disclose the assistance in the format requested by the assessment. Do not claim code or tests were run on an environment where they were not.

## Stack

- **Node.js** runs the JavaScript backend.
- **Express** defines HTTP routes, request validation, and error handling.
- **PostgreSQL** stores users, jobs, scoped permission assignments, role definitions, role-to-action mappings, and audit events.
- **`pg`** connects Node.js to PostgreSQL with parameterized SQL.
- **Node's built-in test runner** runs the pure authorization policy tests without needing PostgreSQL.

## Requirements

- Node.js 20 or newer.
- PostgreSQL 14 or newer (PostgreSQL 16 is used in the optional Compose file).
- npm.

## Run locally

### 1. Start PostgreSQL

Use an existing local PostgreSQL installation, or Docker Compose if Docker is installed:

```bash
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U postgres -d nfpl_access; do sleep 1; done
```

The Compose service creates database `nfpl_access`, user `postgres`, and password `postgres` on `localhost:5432`.

If you use a local PostgreSQL installation instead, create a database called `nfpl_access` and set the connection string to match your local database user and password.

### 2. Configure the connection

```bash
cp .env.example .env
```

Edit `DATABASE_URL` in `.env`. For the Compose configuration, use:

```text
DATABASE_URL=postgres://postgres:postgres@localhost:5432/nfpl_access
```

### 3. Install, seed, test, and start

```bash
npm install
npm run db:setup
npm test
npm start
```

`npm run db:setup` creates the schema and loads the deliberate sample dataset, including 5 branches, 10 clients, 20 sample users, 300 jobs and the edge cases described below. The seeded audit record is labelled as a baseline snapshot (with no invented actor); actions taken through the API are recorded with their actual demo actor and before/after states. **It resets the sample tables; do not run it against a database with data you need to keep.**

The API starts at `http://localhost:3000`. Check `GET /health` first. With the server running, open a second terminal and run `npm run test:smoke` to exercise authorization decisions, scoped grants/revocation, parser restrictions, workflow transitions, audit history and historical investigation against the actual API. The smoke test adds one custom role and one `SMOKE-*` job; run `npm run db:setup` again to reset the curated demo data before recording the final walkthrough.

### 4. Generate the scale dataset

After loading the sample dataset, run:

```bash
npm run seed:scale
```

This grows the dataset to 500 users and 200,000 jobs (without intentionally reducing existing data). The generator uses PostgreSQL `generate_series`, rather than inserting 200,000 rows one request at a time. The generated workload is for performance and query-plan checks; use the curated seed before the five-minute demo.

## Sample users and access

All permission scopes are additive. A blank scope dimension means “all values for this dimension”; non-blank dimensions in a single assignment must all match the job. Multiple assignments for a user can grant different roles over different scopes.

| ID | Person | Access in plain terms |
|---:|---|---|
| 1 | Asha Admin | Global `access_admin`: can manage scoped permission assignments and create safe custom roles. This role does **not** automatically grant shipment access. Asha cannot change her own grants. |
| 2 | Arjun Workflow Lead | Global `workflow_admin`: can inspect jobs and use filed-job cancel/reopen exception actions when a reason is supplied. Exceptions are audited. |
| 3 | Priya Maker-Checker | `maker` for all clients, branches, directions and modes; `checker` only for BluePeak Retail. She still cannot check a job she prepared herself. |
| 4 | Rahul Import Checker | `checker` for Aster Imports, Mumbai branch, imports only, all modes. He cannot check exports or jobs at another branch/client. |
| 5 | Meera Maker | `maker` for all clients, branches, directions and modes. |
| 6 | Dev Filer | `filer` for all clients, branches, directions and modes. |
| 7 | Sameer Absent Checker | Has the same scope as Rahul, but status is `absent`; the service denies actions and the actionable queue is empty while absent. |
| 8 | Nina Client User | Read-only `client_viewer` for BluePeak Retail (Client 2); cannot view other clients or change workflow state. |
| 9 | Night Parser Service | `parser` service account. Can create a Confirmed job within its assignment scope and update only approved metadata fields on non-finalized jobs. |
| 10 | Aditi Temporary Checker | Checker for Aster Imports at Mumbai, imports only. Grant expires seven days after the sample data is loaded. Intended to show temporary cover for an absent colleague. |
| 11 | Kabir Maker | Maker for Delhi branch, all clients/directions/modes. |
| 12 | Ira Checker | Checker for BluePeak Retail at Delhi, all directions/modes. |
| 13 | Rohan Maker | Maker for Chennai branch, all clients/directions/modes. |
| 14 | Tara Checker | Checker for Chennai branch, all clients/directions/modes. |
| 15 | Veer Filer | Filer for Kolkata branch, all clients/directions/modes. |
| 16 | Mira Maker | Maker for Kolkata branch, all clients/directions/modes. |
| 17 | Neil Checker | Checker for Ahmedabad branch, all clients/directions/modes. |
| 18 | Sara Maker | Maker for Ahmedabad branch, all clients/directions/modes. |
| 19 | Omni Ops | Maker only for Cedar Foods at Delhi, export direction and FCL mode. |
| 20 | Pia Client Viewer | Read-only client viewer for Cedar Foods (Client 3). |

The first ten jobs are deliberately chosen edge cases:

- `NFPL-0001` — Aster import at Mumbai, Prepared by Meera; Rahul can check it.
- `NFPL-0002` — Aster export at Mumbai, Prepared; Rahul is denied because he is import-only.
- `NFPL-0003` — BluePeak Prepared job; Priya has Checker scope for BluePeak.
- `NFPL-0004` — Priya prepared it; Priya cannot check her own work.
- `NFPL-0005` — Confirmed job waiting for a Maker.
- `NFPL-0006` — Filed job; ordinary cancellation is denied; workflow exception is required.
- `NFPL-0007` — Checked job waiting for a Filer.
- `NFPL-0008` — Cancelled job; reopening is an exception action.
- `NFPL-0009` — Reopened job that can be prepared again.
- `NFPL-0010` — Aster import at a different branch; Rahul is denied because his scope is Mumbai only.

## Demo identity header — important limitation

This take-home prototype uses `x-demo-user-id` to select a sample actor, so a reviewer can reproduce actions without a full login system. Example: `-H 'x-demo-user-id: 4'` acts as sample user 4.

**This header is not authentication and is not safe for production.** A production version must derive the actor from verified SSO/session/JWT identity, not trust a client-supplied user ID. The authorization decisions themselves are enforced server-side in this prototype.

## API quick start

Run each command in a separate terminal after the server starts.

### Is Rahul allowed to check Job 1?

```bash
curl 'http://localhost:3000/authorization/check?userId=4&jobId=1&action=check_job' \
  -H 'x-demo-user-id: 1'
```

The response contains `allowed`, a stable decision `code`, and a human-readable `reason`. Only the user being checked or a global access administrator may use the explanation endpoint. For reason-gated cancel/reopen actions, pass a URL-encoded `reason` query parameter to check the decision with that proposed justification; avoid putting sensitive information in URLs in a production system.

### Show why Rahul cannot check Job 2

```bash
curl 'http://localhost:3000/authorization/check?userId=4&jobId=2&action=check_job' \
  -H 'x-demo-user-id: 1'
```

The reason identifies the scope mismatch: the job is an export, while Rahul's scope is imports only.

### See Rahul's actionable queue

```bash
curl 'http://localhost:3000/users/4/jobs-needing-me' \
  -H 'x-demo-user-id: 4'
```

The queue filters by current role/action mapping, scope, workflow stage, active user status and maker/checker separation, and uses pagination (maximum 100 per page).

### Advance Job 5 from Confirmed to Prepared

```bash
curl -X POST 'http://localhost:3000/jobs/5/actions/prepare_job' \
  -H 'content-type: application/json' -H 'x-demo-user-id: 3' -d '{}'
```

### View Job 1's audit history

```bash
curl 'http://localhost:3000/jobs/1/history' -H 'x-demo-user-id: 4'
```

A global access administrator can also inspect the history for an investigation.

### Find who could check Job 1 at a historical time

```bash
AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
curl "http://localhost:3000/jobs/1/who-could-act?action=check_job&at=${AT}" \
  -H 'x-demo-user-id: 1'
```

Use an ISO-8601 timestamp. The response reconstructs the job from audit snapshots and evaluates permission assignments effective at that time. **User availability is not historically versioned in this MVP**, so it uses current active/absent status and says so in the response.

### Reopen a filed shipment (workflow admin only; reason required)

```bash
curl -X POST 'http://localhost:3000/jobs/6/actions/reopen_filed_job' \
  -H 'content-type: application/json' -H 'x-demo-user-id: 2' \
  -d '{"reason":"Correct the customs filing reference"}'
```

### Add a safe custom role without changing application code

```bash
curl -X POST 'http://localhost:3000/roles' \
  -H 'content-type: application/json' -H 'x-demo-user-id: 1' \
  -d '{"role":"shipment_reviewer","description":"May review prepared shipment work","appliesTo":"internal","actions":["view_job","check_job"],"reason":"Pilot new review responsibility"}'
```

Then create a scoped grant with `POST /permissions`. Custom roles can use existing low-risk actions, but cannot grant permission administration, filed-job overrides, or cross-type capabilities. Role creation and permission grants are audited.

## Design and test files

- [`docs/DESIGN.md`](docs/DESIGN.md): design decisions and answers to all 14 prompts.
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md): suggested five-minute walkthrough.
- [`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md): transparent AI-assistance record to adapt truthfully.
- `src/domain/authorization.js`: pure, explainable authorization policy.
- `src/repositories/accessRepository.js`: database queries and model mapping.
- `src/routes/api.js`: HTTP API and state-changing operations.
- `sql/schema.sql`: tables, constraints and indexes.
- `scripts/seed.js`: curated example dataset.
- `scripts/seed-scale.js`: 500-user / 200,000-job dataset generator.
- `test/authorization.test.js`: policy edge-case tests.

## Tests and scope limits

`npm test` uses Node's built-in test runner and tests the pure policy rules without needing a running database. It covers scope restrictions, separation of duties, absent users, revoked grants, filed-job exceptions, admin self-escalation, parser limits, client boundaries and configurable custom roles.

The current working environment used to draft this repository did not have PostgreSQL or Docker installed, and package installation could not be verified here. Therefore **the database/API integration and end-to-end demo must be run locally before submission**. Do not state that those checks passed until you run them. Once the server is running after `npm run db:setup`, use a second terminal to run `npm run test:smoke`; it exercises the actual API, creates a temporary custom role and one `SMOKE-*` job, and reports pass/fail. Run `npm run db:setup` again afterward if you want the untouched curated demo data back. The code fails closed on unknown actions and failed authorization checks, and the database uses transactions for workflow changes and audit writes.

Out of scope for this assessment prototype: production authentication/SSO, frontend, user-status history reconstruction, dual approval for filed-job exceptions, and full integration/performance testing in a PostgreSQL runtime. These limitations are disclosed in the design document.
