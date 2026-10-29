const baseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

async function request(path, actorId, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('x-demo-user-id', String(actorId));
  if (options.body !== undefined) headers.set('content-type', 'application/json');

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  } catch {
    throw new Error('Network error. The API may be starting up, unavailable, or not configured to allow this frontend origin.');
  }

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text || `Request failed with HTTP ${response.status}.` }; }
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  return body;
}

export const api = {
  health: () => request('/health', 1),
  queue: actorId => request(`/users/${actorId}/jobs-needing-me?limit=25`, actorId),
  job: (actorId, jobId) => request(`/jobs/${jobId}`, actorId),
  history: (actorId, jobId) => request(`/jobs/${jobId}/history`, actorId),
  decision: (actorId, jobId, action, reason = '') => request(
    `/authorization/check?${new URLSearchParams({ userId: actorId, jobId, action, ...(reason ? { reason } : {}) })}`,
    actorId
  ),
  workflow: (actorId, jobId, action, reason) => request(`/jobs/${jobId}/actions/${action}`, actorId, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {})
  })
};

export { baseUrl };
