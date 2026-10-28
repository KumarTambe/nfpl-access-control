# Five-minute demo plan

Prepare the curated seed data with `npm run db:setup`; start the server with `npm start`. Use separate terminal windows for the server and `curl` examples. The `x-demo-user-id` header is a prototype-only identity switch.

## 0:00–0:30 — Context and service

Show the repository structure and `GET /health`. Explain: the service decides who may do what on a specific job; it is not a frontend demo.

```bash
curl http://localhost:3000/health
```

## 0:30–1:30 — An allowed and denied decision

As the access admin, ask whether Rahul (user 4) can check Job 1 (in-scope import), then Job 2 (export, outside Rahul's import-only scope).

```bash
curl 'http://localhost:3000/authorization/check?userId=4&jobId=1&action=check_job' -H 'x-demo-user-id: 1'
curl 'http://localhost:3000/authorization/check?userId=4&jobId=2&action=check_job' -H 'x-demo-user-id: 1'
```

Point to the `allowed` boolean, decision code, and readable `reason`.

## 1:30–2:15 — Separation of duties and absence

Show that Priya (user 3) cannot check Job 4 because she prepared it, despite having a Checker role for that client. Show that Sameer (user 7) cannot act because he is absent.

```bash
curl 'http://localhost:3000/authorization/check?userId=3&jobId=4&action=check_job' -H 'x-demo-user-id: 1'
curl 'http://localhost:3000/authorization/check?userId=7&jobId=1&action=check_job' -H 'x-demo-user-id: 1'
```

## 2:15–3:15 — Workflow and audit history

As a Maker, move Job 5 from Confirmed to Prepared. Then show the audit event. If time allows, check or file a job that is at the correct stage. Never use an inappropriate action merely to make the demo move faster.

```bash
curl -X POST 'http://localhost:3000/jobs/5/actions/prepare_job' -H 'content-type: application/json' -H 'x-demo-user-id: 3' -d '{}'
curl 'http://localhost:3000/jobs/5/history' -H 'x-demo-user-id: 3'
```

## 3:15–4:15 — Access investigations and custom roles

As Asha (global access admin), call the `who-could-act` endpoint with a concrete timestamp. Explain the difference between “who actually changed the job” (history) and “who had permission under the recorded policy” (historical eligibility). If convenient, create a low-risk custom Reviewer role with `POST /roles`.

## 4:15–5:00 — Scale, limitations and close

Show indexes and the `npm run seed:scale` command. Mention that the actionable queue filters/paginates in PostgreSQL. Close by disclosing the prototype's known limits: demo identity header, no second approver, and current user status used in historical permission investigations. Avoid claiming the 200,000-row benchmark passed unless you ran it and recorded the result.
