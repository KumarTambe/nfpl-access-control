'use strict';
require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Copy .env.example to .env and set your connection string.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const schema = await fs.readFile(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Schema is ready. Loading the curated sample dataset...');
    const seed = require('./seed');
    await seed(pool);
    console.log('Setup complete. Sample data loaded.');
  } finally {
    await pool.end();
  }
}
main().catch(err => { console.error('Database setup failed:', err.message); process.exitCode = 1; });
