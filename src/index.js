'use strict';
require('dotenv').config();
const app = require('./app');
const { pool } = require('./db');
const port = Number(process.env.PORT || 3000);

async function start() {
  await pool.query('SELECT 1');
  const server = app.listen(port, () => console.log(`NFPL Access Control API listening at http://localhost:${port}`));
  const shutdown = async signal => {
    console.log(`${signal} received; shutting down gracefully.`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
start().catch(async error => {
  console.error('Could not start API:', error.message);
  await pool.end();
  process.exit(1);
});
