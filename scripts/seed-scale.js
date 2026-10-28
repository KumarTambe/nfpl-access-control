'use strict';
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing; run npm run db:setup first.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const currentUsers = Number((await pool.query('SELECT COUNT(*) AS count FROM users')).rows[0].count);
    const currentJobs = Number((await pool.query('SELECT COUNT(*) AS count FROM jobs')).rows[0].count);
    if (currentUsers < 20 || currentJobs < 1) throw new Error('Run npm run db:setup before generating scale data.');
    if (currentUsers < 500) {
      await pool.query(`
        INSERT INTO users(name,email,user_type,status,home_branch_id)
        SELECT 'Scale User ' || n, 'scale.user.' || n || '@nfpl.example', 'internal', 'active', ((n - 1) % 5) + 1
        FROM generate_series($1::integer, 500) AS g(n)
        ON CONFLICT (email) DO NOTHING`, [currentUsers + 1]);
    }
    // Give generated staff narrow, explicit assignments rather than universal access.
    await pool.query(`
      INSERT INTO permission_assignments(user_id,role,client_id,branch_id,direction,mode,assigned_by_user_id,reason)
      SELECT u.id,
             CASE WHEN u.id % 3 = 0 THEN 'maker' WHEN u.id % 3 = 1 THEN 'checker' ELSE 'filer' END,
             ((u.id - 1) % 10) + 1,
             ((u.id - 1) % 5) + 1,
             CASE WHEN u.id % 2 = 0 THEN 'IMPORT' ELSE 'EXPORT' END,
             NULL,
             1,
             'Generated narrow-scope grant for performance dataset'
      FROM users u
      WHERE u.id > 20
        AND NOT EXISTS (SELECT 1 FROM permission_assignments p WHERE p.user_id = u.id)
    `);

    const missingJobs = Math.max(0, 200000 - currentJobs);
    if (missingJobs > 0) {
      await pool.query(`
        INSERT INTO jobs(reference,client_id,branch_id,direction,mode,stage,description,created_by_user_id,prepared_by_user_id,checked_by_user_id,filed_by_user_id)
        SELECT 'SCALE-' || LPAD(n::text, 6, '0'),
               ((n - 1) % 10) + 1,
               ((n - 1) % 5) + 1,
               CASE WHEN n % 2 = 0 THEN 'IMPORT' ELSE 'EXPORT' END,
               CASE WHEN n % 3 = 0 THEN 'AIR' WHEN n % 3 = 1 THEN 'FCL' ELSE 'LCL' END,
               CASE WHEN n % 5 = 0 THEN 'CONFIRMED'
                    WHEN n % 5 = 1 THEN 'PREPARED'
                    WHEN n % 5 = 2 THEN 'CHECKED'
                    WHEN n % 5 = 3 THEN 'FILED'
                    ELSE 'REOPENED' END,
               'Generated scale-test shipment ' || n,
               ((n - 1) % 500) + 1,
               CASE WHEN n % 5 IN (1,2,3,4) THEN ((n + 5) % 500) + 1 ELSE NULL END,
               CASE WHEN n % 5 IN (2,3) THEN ((n + 15) % 500) + 1 ELSE NULL END,
               CASE WHEN n % 5 = 3 THEN ((n + 25) % 500) + 1 ELSE NULL END
        FROM generate_series(1, $1::integer) AS g(n)`, [missingJobs]);
    }
    const counts = await pool.query(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM jobs) AS jobs`);
    console.log(`Scale data ready: ${counts.rows[0].users} users and ${counts.rows[0].jobs} jobs.`);
  } finally {
    await pool.end();
  }
}
main().catch(error => { console.error('Scale generation failed:', error.message); process.exitCode = 1; });
