# Local Scale Check

This is an observed local check, not a formal benchmark.

## Environment and dataset

- Node.js 22.22.1, Express 4 and `pg` 8.
- PostgreSQL 18.1 running locally on macOS.
- Separate disposable database: `nfpl_access_scale`.
- `npm run db:setup` followed by `npm run seed:scale` produced exactly 500 users and 200,000 jobs.
- The normal `nfpl_access` demo database was kept separate.

## What was measured

The API on port 3001 queried `GET /users/32/jobs-needing-me?limit=50&offset=0` with `x-demo-user-id: 32`. Generated user 32 is a filer whose narrow scope matches the generated Checked-job pattern.

- The response was HTTP 200.
- It reported 19,999 actionable jobs and returned the first 50.
- A repeated local `curl` request took 0.064013 seconds end-to-end.
- `EXPLAIN (ANALYZE, BUFFERS)` for the page query took 53.371 ms, with 3,917 shared-buffer hits.

## What the plan showed

PostgreSQL used a parallel sequential scan of the relevant jobs, then sorted and de-duplicated the matching rows. The existing indexes still help simple lookups, but the queue query deliberately supports nullable scope dimensions and three different workflow actions. Those `OR` conditions make one narrow composite index less directly usable.

No extra index was added: on this local 200,000-job check the measured time did not justify a speculative schema change. This result is useful evidence that filtering and pagination remain in PostgreSQL, not proof of production capacity. Repeat the check on target hardware and workload before making capacity claims.
