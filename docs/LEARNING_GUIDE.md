# Learning Guide: NFPL Access Control Service

## The architecture in plain English

Node.js runs the JavaScript program. Express receives HTTP requests and sends HTTP responses. PostgreSQL is the long-term source of truth for users, jobs, grants, statuses and audit events. The repository files contain SQL so the route files do not have SQL mixed into every request handler. The authorization policy is a pure JavaScript function: give it a user, action, job, grants and time, and it returns an allow/deny decision with a stable code and explanation.

For example, `POST /jobs/5/actions/prepare_job` enters `src/routes/api.js`. The route validates the request and finds the demo actor. It opens a database transaction, locks Job 5, reads the actor's latest grants and calls `canPerform`. If the decision allows the action, the route updates the job and inserts an audit row before committing. If either write fails, the transaction rolls back, so there is no workflow change without its audit event.

## How a permission decision works

A permission assignment belongs to one user and one role. Its client, branch, direction and mode fields are optional restrictions. Blank means “all” for that one dimension; populated fields must match the job. A grant is effective only after `effective_from`, before `expires_at`, and before `revoked_at`.

The role supplies an action, such as `check_job`. The policy then applies rules that cannot be bypassed by a role row: the user must be active, the job must be at the right workflow stage, and a workflow actor must also be able to view the job. For checking, the stage must be `PREPARED` and `prepared_by_user_id` must not equal the checker. That is the Maker–Checker rule: even Priya, who has both roles in different scopes, cannot check a job she prepared herself.

## Why transactions matter

Imagine filing a shipment. Without a transaction, the app could mark it Filed and then crash before writing the audit event. This service uses `withTransaction` so the update and `writeAudit` happen together. The job row is locked and authorization is checked again immediately before the update, reducing race conditions with grant changes.

## Historical eligibility and user status

`user_status_history` has one initial row for every seeded user. A status change through `PATCH /users/:userId/status` updates `users.status`, inserts a history row with the database timestamp, and writes an audit record in one transaction. Only a global access administrator can use it, and they cannot change their own status through this demo endpoint.

The investigation endpoint reconstructs the job state from later audit snapshots, checks which grants were effective at the requested timestamp, and reads the latest status-history row at or before that timestamp. If no historical status exists, it returns a safe denial (`USER_STATUS_HISTORY_MISSING`) rather than pretending to know. The smoke test proves both directions: Rahul was active in the past but absent now, and Sameer was absent in the past but active now.

## Avoiding shipment-existence disclosure

Before the hardening change, a person could compare a 403 response for a real inaccessible job against a 404 response for a missing job. Now authorization checks, job reads and history reads return the same minimal `404 {"error":"Job not found."}` response when the caller cannot view the job. A viewer who can see the job still receives useful action-denial explanations, and an access administrator keeps their explicit investigation access. This reduces a response-based information leak; it does not claim to eliminate timing side channels.

## Scale check and indexes

The regular demo database remains small: 20 users and 300 jobs. The separate `nfpl_access_scale` database was seeded and grown with PostgreSQL `generate_series` to 500 users and 200,000 jobs. The queue endpoint for generated filer user 32 returned 50 of 19,999 actionable jobs in a repeated local HTTP time of 64.013 ms. PostgreSQL reported 53.371 ms for the page query itself. See `PERFORMANCE.md` for the exact environment and limits.

The queue query keeps filtering, counting and pagination in PostgreSQL. Existing indexes cover job stage/scope, active user grants and audit history. The actual scale plan used a parallel sequential scan because nullable scopes and several workflow-action branches contain `OR` conditions. That local result did not justify an extra speculative index.

## Files changed in this hardening pass

- `sql/schema.sql`: adds `user_status_history`, its integrity rules and lookup index.
- `scripts/seed.js`: resets and seeds one initial status record per user.
- `src/repositories/accessRepository.js`: reads historical statuses and performs the transactional status update SQL.
- `src/domain/authorization.js`: denies historical decisions when status is missing and accepts the recorded status for a historical check.
- `src/routes/api.js`: hides inaccessible job existence, uses historical statuses, and adds the narrow status-change endpoint.
- `src/app.js`: keeps concealed job errors to the same minimal 404 response body.
- `test/authorization.test.js`: covers historical-active, historical-absent and missing-status decisions.
- `scripts/smoke.js`: covers HTTP concealment and both historical-status directions.
- `README.md` and `docs/DESIGN.md`: describe the final behavior accurately.
- `docs/PERFORMANCE.md`: records the actual local scale observation.

## Questions you may be asked

1. **Why not put one role column on the user?** A person can have different responsibilities in different scopes. Separate assignment rows let Priya be a Maker broadly but a Checker only for BluePeak.
2. **How do you stop someone approving their own work?** `check_job` compares the actor ID to `prepared_by_user_id`; a matching ID receives `SEPARATION_OF_DUTIES` even if they have a Checker grant.
3. **Why is the audit write in the transaction?** It prevents a recorded workflow change without its matching audit event, or an audit event for a change that did not commit.
4. **How can you answer who was eligible last week?** Rebuild the job snapshot from audit history, evaluate grants at last week's timestamp, and use the status-history row effective then.
5. **Does the demo header authenticate users?** No. `x-demo-user-id` exists only so a reviewer can reproduce examples. Production must use verified identity from SSO, a session or a token.

## Remaining limitations

The demo identity header is spoofable and is not production authentication. The audit table is useful history but not immutable against a privileged database writer. Filed-job exceptions still lack dual approval. The scale result is one local check, not a production load test or capacity guarantee.
