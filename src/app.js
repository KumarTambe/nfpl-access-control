'use strict';
require('express-async-errors'); // Express 4 needs this to forward rejected async handlers to error middleware.
const express = require('express');
const { randomUUID } = require('node:crypto');
const api = require('./routes/api');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});
app.get('/', (_req, res) => res.json({ name: 'NFPL Access Control Service', api: '/health', documentation: 'See README.md' }));
app.use(api);
app.use((req, res) => res.status(404).json({ error: 'Route not found.', requestId: req.requestId }));
app.use((err, req, res, _next) => {
  const isPostgresInputError = typeof err.code === 'string' && err.code.startsWith('22');
  const status = Number(err.status) || (err.code === '23505' ? 409 : (err.code === '23503' || err.code === '23514' || isPostgresInputError ? 400 : 500));
  if (status >= 500) console.error(`[${req.requestId}]`, err);
  res.status(status).json({
    error: status >= 500 ? 'Internal server error.' : err.message,
    ...(err.code && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? { code: err.code } : {}),
    requestId: req.requestId
  });
});
module.exports = app;
