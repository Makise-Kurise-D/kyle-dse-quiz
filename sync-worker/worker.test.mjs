import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import worker from './worker.js';

const ORIGIN = 'https://makise-kurisu-d.github.io';
const BASE = 'https://sync.example.workers.dev';
const SECRET = 'test-only-session-secret-with-enough-entropy';

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

function b64json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromB64json(value) {
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

test('health and CORS preflight are available locally', async () => {
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, GITHUB_CLIENT_ID: 'test-client' };
  const health = await worker.fetch(new Request(`${BASE}/health`), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'kyle-dse-quiz-sync');

  const preflight = await worker.fetch(new Request(`${BASE}/sync`, {
    method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' },
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
});

test('the Worker responds through a local HTTP service', { skip: process.env.QUIZ_SKIP_HTTP_TEST === '1' }, async t => {
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, GITHUB_CLIENT_ID: 'test-client' };
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
      else if (value != null) headers.set(key, value);
    });
    const response = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers }), env);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(await response.text());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'kyle-dse-quiz-sync' });
});

test('OAuth handoff authenticates and sync merges through GitHub contents API', async t => {
  const env = {
    SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET,
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
  };
  const originalFetch = globalThis.fetch;
  const empty = { app: 'kyle-dse-quiz', version: 1, sessions: [], archive: [], drafts: {}, reviewPlan: {}, cycle: null };
  let file = { content: b64json(empty), sha: 'sha-1' };
  let putAttempts = 0;
  let login = 'Makise-Kurisu-D', githubCalls = 0;
  const bank = { subjects: { chem: { name: '化學', topics: [], items: [] }, bio: { name: '生物', topics: [], items: [] } } };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/')) {
      githubCalls++;
      assert.equal(new Headers(init.headers).get('user-agent'), 'kyle-dse-quiz-sync');
    }
    if (url.endsWith('/user')) return Response.json({ login });
    if (url.endsWith('/contents/question-bank/bank.json')) return Response.json({ encoding: 'base64', content: b64json(bank) });
    if (url.endsWith('/contents/question-bank/images/chem-2022-mc-01.jpg')) {
      return Response.json({ encoding: 'base64', content: btoa(String.fromCharCode(255, 216, 255, 217)) });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'mock-access-token-which-is-long-enough-for-validation',
        refresh_token: 'mock-refresh-token', expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.endsWith('/contents/records.json') && (!init.method || init.method === 'GET')) {
      return Response.json(file);
    }
    if (url.endsWith('/contents/records.json') && init.method === 'PUT') {
      putAttempts++;
      if (putAttempts === 1) return Response.json({ message: 'sha conflict' }, { status: 409 });
      const payload = JSON.parse(init.body);
      assert.equal(payload.sha, file.sha);
      file = { content: payload.content, sha: `sha-${putAttempts}` };
      return Response.json({ content: { sha: file.sha } });
    }
    throw new Error(`Unexpected mock request: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const start = await worker.fetch(new Request(`${BASE}/auth/start`), env);
  assert.equal(start.status, 302);
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const authorization = new URL(start.headers.get('location'));
  const state = authorization.searchParams.get('state');
  const callback = await worker.fetch(new Request(`${BASE}/auth/callback?code=mock-code&state=${state}`, {
    headers: { Cookie: cookie },
  }), env);
  assert.equal(callback.status, 302);
  const redirect = new URL(callback.headers.get('location'));
  assert.match(redirect.searchParams.get('v'), /^\d+$/);
  const handoff = new URLSearchParams(redirect.hash.split('?')[1]).get('handoff');
  assert.ok(handoff);

  const exchange = await worker.fetch(new Request(`${BASE}/auth/exchange`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoff }),
  }), env);
  assert.equal(exchange.status, 200);
  const sessionId = (await exchange.json()).sessionId;
  assert.ok(sessionId);

  const unauthorized = await worker.fetch(new Request(`${BASE}/sync`, { headers: { Origin: ORIGIN } }), env);
  assert.equal(unauthorized.status, 401);
  const deniedOrigin = await worker.fetch(new Request(`${BASE}/sync`, {
    headers: { Origin: 'https://attacker.example', Authorization: `Bearer ${sessionId}` },
  }), env);
  assert.equal(deniedOrigin.status, 403);

  const backup = { ...empty, sessions: [{ t: 1, subj: 'chem', topic: 'T1', results: { q1: { marks: 1, tot: 1 } } }] };
  const saved = await worker.fetch(new Request(`${BASE}/sync`, {
    method: 'PUT', headers: { Origin: ORIGIN, Authorization: `Bearer ${sessionId}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: backup }),
  }), env);
  assert.equal(saved.status, 200);
  assert.equal(putAttempts, 2, 'a concurrent GitHub SHA conflict is retried');
  assert.equal(fromB64json(file.content).sessions.length, 1);
  assert.equal(saved.headers.get('access-control-allow-origin'), ORIGIN);

  const privateHeaders = { Origin: ORIGIN, Authorization: `Bearer ${sessionId}` };
  const beforeDenied = githubCalls;
  for (const [path, headers, status] of [
    ['/bank', { Origin: ORIGIN }, 401],
    ['/bank/images/chem-2022-mc-01.jpg', { Origin: ORIGIN }, 401],
    ['/bank', { ...privateHeaders, Origin: 'https://attacker.example' }, 403],
    ['/bank/images/records.json', privateHeaders, 404],
    ['/bank/images/chem-2022-mc-01.jpg/extra', privateHeaders, 404],
    ['/bank/images/%2e%2e%2frecords.json', privateHeaders, 404],
  ]) {
    const denied = await worker.fetch(new Request(BASE + path, { headers }), env);
    assert.equal(denied.status, status, path);
  }
  assert.equal(githubCalls, beforeDenied, 'unauthorized requests never fetch private files');
  const loaded = await worker.fetch(new Request(`${BASE}/bank`, { headers: privateHeaders }), env);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await loaded.json(), bank);
  const image = await worker.fetch(new Request(`${BASE}/bank/images/chem-2022-mc-01.jpg`, { headers: privateHeaders }), env);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [255, 216, 255, 217]);
  login = 'someone-else';
  const stranger = await worker.fetch(new Request(`${BASE}/bank`, { headers: privateHeaders }), env);
  assert.equal(stranger.status, 403);
  assert.equal((await stranger.json()).error, 'owner_only');

  // Upgrade an already connected owner's session; no new token is supplied by the user.
  env.SITE_PASSWORD = 'test-password';
  login = 'Makise-Kurisu-D';
  const loginRequest = headers => new Request(`${BASE}/auth/password`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ password: 'test-password' }),
  });
  const needsOwner = await worker.fetch(loginRequest({}), env);
  assert.equal(needsOwner.status, 503);
  assert.equal((await needsOwner.json()).error, 'owner_connection_required');
  login = 'someone-else';
  assert.equal((await worker.fetch(loginRequest({ Authorization: `Bearer ${sessionId}` }), env)).status, 403);
  assert.equal(await env.SESSIONS.get('service:github-owner'), null);
  login = 'Makise-Kurisu-D';
  const upgraded = await worker.fetch(loginRequest({ Authorization: `Bearer ${sessionId}` }), env);
  assert.equal(upgraded.status, 200);
  const passwordId = (await upgraded.json()).sessionId;
  const newComputer = await worker.fetch(loginRequest({}), env);
  assert.equal(newComputer.status, 200);
  const secondId = (await newComputer.json()).sessionId;
  assert.notEqual(passwordId, secondId);
  const passwordHeaders = { Origin: ORIGIN, Authorization: `Bearer ${passwordId}` };
  const bankViaPassword = await worker.fetch(new Request(`${BASE}/bank`, { headers: passwordHeaders }), env);
  assert.equal(bankViaPassword.status, 200);
  assert.deepEqual(await bankViaPassword.json(), bank);
  const savedViaPassword = await worker.fetch(new Request(`${BASE}/sync`, {
    method: 'PUT', headers: { ...passwordHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: backup }),
  }), env);
  assert.equal(savedViaPassword.status, 200);
  const pictureViaPassword = await worker.fetch(new Request(`${BASE}/bank/images/chem-2022-mc-01.jpg`, { headers: passwordHeaders }), env);
  assert.equal(pictureViaPassword.status, 200);
  const logout = await worker.fetch(new Request(`${BASE}/auth/logout`, { method: 'POST', headers: passwordHeaders }), env);
  assert.equal(logout.status, 200);
  assert.equal((await worker.fetch(new Request(`${BASE}/bank`, { headers: passwordHeaders }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(`${BASE}/bank`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${secondId}` } }), env)).status, 200);

  // Shared credentials can refresh without logging in again on each computer.
  const originalNow = Date.now;
  Date.now = () => originalNow() + 9 * 3600000;
  try {
    const refreshed = await Promise.all([
      worker.fetch(new Request(`${BASE}/bank`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${secondId}` } }), env),
      worker.fetch(new Request(`${BASE}/sync`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${secondId}` } }), env),
    ]);
    assert.ok(refreshed.every(response => response.status === 200));
  } finally { Date.now = originalNow; }
  env.SITE_PASSWORD = 'new-test-password';
  assert.equal((await worker.fetch(new Request(`${BASE}/bank`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${secondId}` } }), env)).status, 401);
  const upgradedOwner = await worker.fetch(new Request(`${BASE}/auth/upgrade`, { method: 'POST', headers: privateHeaders }), env);
  assert.equal(upgradedOwner.status, 200);
  const upgradedId = (await upgradedOwner.json()).sessionId;
  assert.equal((await worker.fetch(new Request(`${BASE}/sync`, { headers: privateHeaders }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(`${BASE}/sync`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${upgradedId}` } }), env)).status, 200);

  // A new owner OAuth connection also provisions storage for password-only devices.
  const freshStart = await worker.fetch(new Request(`${BASE}/auth/start`), env);
  const freshCookie = freshStart.headers.get('set-cookie').split(';')[0];
  const freshState = new URL(freshStart.headers.get('location')).searchParams.get('state');
  const freshCallback = await worker.fetch(new Request(`${BASE}/auth/callback?code=new-code&state=${freshState}`, { headers: { Cookie: freshCookie } }), env);
  assert.equal(freshCallback.status, 302);
  assert.equal((await worker.fetch(loginRequest({}), env)).status, 401, 'old password is rejected after a password change');
  login = 'someone-else';
  const deniedCallback = await worker.fetch(new Request(`${BASE}/auth/callback?code=other-code&state=${freshState}`, { headers: { Cookie: freshCookie } }), env);
  assert.equal(deniedCallback.status, 403);
  login = 'Makise-Kurisu-D';
});

test('private bank fails closed when storage or secrets are not configured', async () => {
  const response = await worker.fetch(new Request(`${BASE}/bank`, { headers: { Origin: ORIGIN } }), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'service_not_configured');
});

test('password login checks configuration, origin, attempts, expiry and credential isolation', async () => {
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, SITE_PASSWORD: 'test-password', GITHUB_TOKEN: 'server-only-test-token' };
  function request(password, ip = '192.0.2.1', origin = ORIGIN) {
    return new Request(`${BASE}/auth/password`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ password }),
    });
  }
  assert.equal((await worker.fetch(request('test-password'), {})).status, 503);
  assert.equal((await worker.fetch(request('test-password', '192.0.2.1', 'https://attacker.example'), env)).status, 403);
  for (let i = 0; i < 5; i++) {
    const rejected = await worker.fetch(request('wrong'), env);
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error, 'invalid_password');
  }
  const limited = await worker.fetch(request('test-password'), env);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const accepted = await worker.fetch(request('test-password', '192.0.2.2'), env);
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.match(body.sessionId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.expiresIn, 30 * 24 * 3600);
  assert.ok(!JSON.stringify(body).includes(env.SITE_PASSWORD));
  assert.ok(!JSON.stringify(body).includes(env.GITHUB_TOKEN));
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${body.sessionId}` };
  const originalNow = Date.now;
  Date.now = () => originalNow() + 31 * 24 * 3600000;
  try {
    const expired = await worker.fetch(new Request(`${BASE}/sync`, { headers }), env);
    assert.equal(expired.status, 401);
  } finally { Date.now = originalNow; }
});
