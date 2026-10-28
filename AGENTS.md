# Codex instructions — NFPL Access Control Service

## Start here
1. Read `README.md` for setup, demo commands, sample users, known limitations, and API examples.
2. Read `docs/DESIGN.md` for the intended design and answers to the 14 assessment questions.
3. Read `package.json` to see available scripts and dependencies.
4. For a code change, inspect the specific source and related tests before editing. Do not assume the README proves the implementation works.

## Project goal
A small Node.js + Express + PostgreSQL API that makes scoped, explainable authorization decisions for shipment jobs and records auditable workflow changes. Keep the implementation understandable for a beginner who must explain it in an interview.

## Important files
- `src/domain/authorization.js`: core policy decisions and permission-scope rules. Start here when investigating why an action is allowed or denied.
- `src/routes/api.js`: HTTP endpoints, input validation, and orchestration of API actions.
- `src/repositories/accessRepository.js`: SQL-backed reads/writes and mapping database rows into application objects.
- `src/db.js`: PostgreSQL connection pool and transaction helper.
- `src/app.js`: Express app configuration and error handling.
- `src/index.js`: starts the HTTP server.
- `sql/schema.sql`: database tables, constraints, indexes, and role/action configuration.
- `scripts/seed.js`: small curated demo dataset and edge cases.
- `scripts/db-setup.js`: creates/reset sample schema and loads curated data. This is destructive to existing data in the configured sample tables; never run against a database with data to preserve.
- `scripts/seed-scale.js`: grows data to 500 users and 200,000 jobs for scale checks.
- `test/authorization.test.js`: fast unit tests of the core authorization policy; these do not require PostgreSQL.
- `scripts/smoke.js`: end-to-end HTTP smoke test; requires a running API and configured PostgreSQL database.
- `README.md`: current operating instructions and API examples.
- `docs/DESIGN.md`: canonical editable design-document source.
- `docs/DESIGN.pdf` and `docs/DESIGN.docx`: submission-ready exports of the design document. If `docs/DESIGN.md` changes, do not assume these exports update automatically; regenerate and review them when asked.
- `docs/DEMO_SCRIPT.md`: proposed five-minute demo walkthrough.
- `docs/AI_DISCLOSURE.md`: draft disclosure; it must be edited to reflect what was actually done and verified.
- `.env.example`: safe template for local configuration. Do not put secrets in tracked files.
- `.env`: local secrets/config if created. Never print, copy into prompts, or include in archives.
- `docker-compose.yml`: optional PostgreSQL container setup.
- `_qa/`: temporary design-render QA files; not application source and not needed for Codex tasks or submission.

## Commands
- `npm test`: unit tests for policy logic; runs without PostgreSQL.
- `npm run db:setup`: sets up schema and loads the curated sample. Destructive to sample tables.
- `npm start`: starts the API on port 3000 after configuration and database setup.
- `npm run test:smoke`: exercises the running API against PostgreSQL; it modifies sample data by creating a custom role and a `SMOKE-*` job.
- `npm run seed:scale`: creates/grows the large 500-user/200,000-job dataset. Use only after the curated flow is working; reset curated data with `npm run db:setup` before the demo.

## Working rules
- First report what you inspected, commands actually run, pass/fail results, bugs, and a prioritized plan. Do not edit files until the user approves the plan when the user asks for an audit first.
- Do not claim PostgreSQL/API integration or performance tests passed unless they were actually run and the results were checked.
- Preserve Node.js, Express, PostgreSQL, and `pg`. Do not introduce a frontend, framework, ORM, or extra dependencies without explaining the benefit and getting approval.
- Keep authorization checks on the server. The browser/client must never be treated as the authority for access decisions.
- Fail closed for unknown actions and uncertain authorization. Keep explanations stable and actionable, and keep workflow changes and their audit events in the same database transaction.
- Treat demo identity header `x-demo-user-id` as prototype-only, not real authentication. Do not describe this as production-ready authentication.
- Protect separation of duties, scoped grants, absence/expiry handling, permission revocation, admin self-escalation safeguards, client boundaries, parser restrictions, workflow exceptions, and audit history.
- Use parameterized SQL; never concatenate user-controlled values into SQL strings.
- Avoid unrelated rewrites. Prefer the smallest clear fix and explain every changed file in plain language.
- Keep the README, design source, exported PDF/DOCX, and AI disclosure accurate and consistent. Never state a check passed unless it was run.
