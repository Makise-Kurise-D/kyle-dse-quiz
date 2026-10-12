const SITE_ORIGIN = 'https://makise-kurisu-d.github.io';
const SITE_HOME = `${SITE_ORIGIN}/kyle-dse-quiz/`;
const REPO = 'Makise-Kurisu-D/kyle-dse-quiz-data';
const DATA_PATH = 'records.json';
const BANK_PATH = 'question-bank/bank.json';
const OWNER = REPO.split('/')[0];
const OWNER_KEY = 'service:github-owner';
const PASSWORD_TTL = 30 * 24 * 3600;
const refreshes = new Map();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function configurationError(env, required) {
  const missing = required.filter(name => name === 'SESSIONS'
    ? !env.SESSIONS || typeof env.SESSIONS.get !== 'function' || typeof env.SESSIONS.put !== 'function'
    : typeof env[name] !== 'string' || !env[name].trim());
  return missing.length ? new Response(`Service setup is incomplete: ${missing.join(', ')}`, { status: 503 }) : null;
}

function encodeUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function decodeUtf8(value) {
  const binary = atob(value.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function mergeBackup(current, incoming) {
  if (!current || current.app !== 'kyle-dse-quiz') return incoming;
  function mergeSessions(a, b) {
    const seen = new Set(), out = [];
    [...(a || []), ...(b || [])].forEach(session => {
      if (!session || typeof session.t !== 'number') return;
      const key = [session.t, session.subj, session.topic, JSON.stringify(session.results || {})].join('|');
      if (!seen.has(key)) { seen.add(key); out.push(session); }
    });
    return out.sort((a, b) => a.t - b.t);
  }
  const plans = { ...(current.reviewPlan || {}) };
  Object.entries(incoming.reviewPlan || {}).forEach(([id, p]) => {
    if (!plans[id] || (p.lastAt || 0) >= (plans[id].lastAt || 0)) plans[id] = p;
  });
  return {
    app: 'kyle-dse-quiz', version: 1, exportedAt: new Date().toISOString(),
    sessions: mergeSessions(current.sessions, incoming.sessions),
    archive: mergeSessions(current.archive, incoming.archive),
    drafts: { ...(current.drafts || {}), ...(incoming.drafts || {}) },
    reviewPlan: plans,
    cycle: String(Math.max(Number(current.cycle || 0), Number(incoming.cycle || 0))) || null,
  };
}

function cors(request, headers = {}) {
  const origin = request.headers.get('Origin');
  return {
    ...headers,
    'access-control-allow-origin': origin === SITE_ORIGIN ? SITE_ORIGIN : 'null',
    'access-control-allow-credentials': 'false',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'vary': 'Origin',
    'cache-control': 'no-store',
  };
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function randomId() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digest(value) {
  const data = new TextEncoder().encode(value);
  return base64url(await crypto.subtle.digest('SHA-256', data));
}

async function signedState(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return `${value}.${base64url(mac)}`;
}

async function verifyState(signed, secret) {
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return false;
  return (await signedState(signed.slice(0, dot), secret)) === signed;
}

async function seal(value, secret) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(value)));
  return `${base64url(iv)}.${base64url(cipher)}`;
}

async function unseal(value, secret) {
  const [ivText, cipherText] = value.split('.');
  const decode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(ivText) }, key, decode(cipherText));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function github(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'kyle-dse-quiz-sync',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `GitHub returned ${response.status}`), { status: response.status });
  return body;
}

async function passwordVersion(env) {
  return signedState(String(env.SITE_PASSWORD), env.SESSION_SECRET);
}

async function passwordSession(env) {
  const sessionId = await randomId();
  await env.SESSIONS.put(await digest(sessionId), await seal({ kind: 'password',
    passwordVersion: await passwordVersion(env), expiresAt: Date.now() + PASSWORD_TTL * 1000,
  }, env.SESSION_SECRET), { expirationTtl: PASSWORD_TTL });
  return sessionId;
}

async function credentialFor(sessionKey, env) {
  const saved = await env.SESSIONS.get(sessionKey);
  if (!saved) return null;
  let session;
  try { session = await unseal(saved, env.SESSION_SECRET); }
  catch { await env.SESSIONS.delete(sessionKey); return null; }
  if (session.expiresAt && Date.now() > session.expiresAt - 60000) {
    if (!session.refreshToken) {
      await env.SESSIONS.delete(sessionKey);
      return null;
    }
    if (configurationError(env, ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])) {
      throw Object.assign(new Error('service_not_configured'), { status: 503 });
    }
    const refresh = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: session.refreshToken }),
    });
    const next = await refresh.json().catch(() => ({}));
    if (!refresh.ok || !next.access_token) {
      await env.SESSIONS.delete(sessionKey);
      return null;
    }
    session = {
      accessToken: next.access_token,
      refreshToken: next.refresh_token,
      expiresAt: Date.now() + Number(next.expires_in || 28800) * 1000,
    };
    await env.SESSIONS.put(sessionKey, await seal(session, env.SESSION_SECRET), { expirationTtl: Math.max(3600, Number(next.refresh_token_expires_in || 15897600)) });
  }
  return session.accessToken ? session : null;
}

async function ownerCredential(env) {
  if (env.GITHUB_TOKEN) return { accessToken: env.GITHUB_TOKEN };
  // Coalesce refreshes for requests handled by this Worker instance.
  if (!refreshes.has(env.SESSIONS)) {
    const promise = credentialFor(OWNER_KEY, env).finally(() => refreshes.delete(env.SESSIONS));
    refreshes.set(env.SESSIONS, promise);
  }
  return refreshes.get(env.SESSIONS);
}

async function tokenFor(request, env) {
  const match = (request.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{40,80})$/);
  if (!match) return null;
  const sessionKey = await digest(match[1]);
  const saved = await env.SESSIONS.get(sessionKey);
  if (!saved) return null;
  let session;
  try { session = await unseal(saved, env.SESSION_SECRET); }
  catch { await env.SESSIONS.delete(sessionKey); return null; }
  if (session.kind === 'password') {
    if (!env.SITE_PASSWORD || session.expiresAt <= Date.now() || session.passwordVersion !== await passwordVersion(env)) {
      await env.SESSIONS.delete(sessionKey); return null;
    }
    const credential = await ownerCredential(env);
    if (!credential) throw Object.assign(new Error('owner_connection_required'), { status: 503 });
    return { token: credential.accessToken, sessionKey, credentialKey: OWNER_KEY };
  }
  const credential = await credentialFor(sessionKey, env);
  return credential ? { token: credential.accessToken, sessionKey, credentialKey: sessionKey } : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    if (url.pathname === '/auth/upgrade' && request.method === 'POST') {
      if (request.headers.get('Origin') !== SITE_ORIGIN) return json({ error: 'origin_denied' }, 403, cors(request));
      if (configurationError(env, ['SITE_PASSWORD', 'SESSION_SECRET', 'SESSIONS'])) return json({ error: 'service_not_configured' }, 503, cors(request));
      try {
        const auth = await tokenFor(request, env);
        if (!auth) return json({ error: 'not_connected' }, 401, cors(request));
        const user = await github('/user', auth.token);
        if (String(user.login).toLowerCase() !== OWNER.toLowerCase()) return json({ error: 'owner_only' }, 403, cors(request));
        if (auth.credentialKey !== OWNER_KEY) {
          const saved = await env.SESSIONS.get(auth.credentialKey);
          if (!saved) return json({ error: 'not_connected' }, 401, cors(request));
          await env.SESSIONS.put(OWNER_KEY, saved);
        }
        const sessionId = await passwordSession(env);
        if (auth.credentialKey !== OWNER_KEY) await env.SESSIONS.delete(auth.sessionKey);
        return json({ sessionId, expiresIn: PASSWORD_TTL }, 200, cors(request));
      } catch (error) {
        return json({ error: error.status === 503 ? error.message : 'login_unavailable' }, error.status === 503 ? 503 : 502, cors(request));
      }
    }
    if (url.pathname === '/auth/password' && request.method === 'POST') {
      if (request.headers.get('Origin') !== SITE_ORIGIN) return json({ error: 'origin_denied' }, 403, cors(request));
      if (configurationError(env, ['SITE_PASSWORD', 'SESSION_SECRET', 'SESSIONS'])) {
        return json({ error: 'service_not_configured' }, 503, cors(request));
      }
      const body = await request.json().catch(() => ({}));
      if (typeof body.password !== 'string' || body.password.length > 256) return json({ error: 'invalid_password' }, 401, cors(request));
      const limitKey = 'login-limit:' + await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
      const attempts = JSON.parse(await env.SESSIONS.get(limitKey) || 'null');
      const recent = attempts && attempts.until > Date.now() ? attempts : { count: 0, until: Date.now() + 900000 };
      if (recent.count >= 5) return json({ error: 'too_many_attempts' }, 429, cors(request, { 'retry-after': String(Math.ceil((recent.until - Date.now()) / 1000)) }));
      const supplied = new TextEncoder().encode(await digest(body.password));
      const expected = new TextEncoder().encode(await digest(env.SITE_PASSWORD));
      let mismatch = 0;
      supplied.forEach((byte, i) => { mismatch |= byte ^ expected[i]; });
      if (mismatch) {
        await env.SESSIONS.put(limitKey, JSON.stringify({ ...recent, count: recent.count + 1 }), { expirationTtl: 900 });
        return json({ error: 'invalid_password' }, 401, cors(request));
      }
      try {
        let owner = await ownerCredential(env);
        // An existing owner login can initialize the service without another authorization or token copy by the user.
        if (!owner && request.headers.has('Authorization')) {
          const auth = await tokenFor(request, env);
          if (auth && auth.credentialKey !== OWNER_KEY) {
            const user = await github('/user', auth.token);
            if (String(user.login).toLowerCase() !== OWNER.toLowerCase()) return json({ error: 'owner_only' }, 403, cors(request));
            const saved = await env.SESSIONS.get(auth.credentialKey);
            if (!saved) return json({ error: 'not_connected' }, 401, cors(request));
            await env.SESSIONS.put(OWNER_KEY, saved);
            owner = { accessToken: auth.token };
          }
        }
        if (!owner) return json({ error: 'owner_connection_required' }, 503, cors(request));
        const sessionId = await passwordSession(env);
        await env.SESSIONS.delete(limitKey);
        return json({ sessionId, expiresIn: PASSWORD_TTL }, 200, cors(request));
      } catch (error) {
        return json({ error: error.status === 503 ? error.message : 'login_unavailable' }, error.status === 503 ? 503 : 502, cors(request));
      }
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      if (request.headers.get('Origin') !== SITE_ORIGIN) return json({ error: 'origin_denied' }, 403, cors(request));
      if (configurationError(env, ['SESSIONS'])) return json({ error: 'service_not_configured' }, 503, cors(request));
      const match = (request.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{40,80})$/);
      if (match) await env.SESSIONS.delete(await digest(match[1]));
      return json({ ok: true }, 200, cors(request));
    }
    if (url.pathname === '/auth/start' && request.method === 'GET') {
      const state = await randomId();
      const signed = await signedState(state, env.SESSION_SECRET);
      const cookie = `dse_oauth_state=${signed}; HttpOnly; Secure; SameSite=Lax; Path=/auth/callback; Max-Age=600`;
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
      authorize.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('allow_signup', 'false');
      const response = new Response(null, { status: 302, headers: { location: authorize.toString() } });
      response.headers.append('set-cookie', cookie);
      return response;
    }
    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const cookie = request.headers.get('Cookie') || '';
      const saved = (cookie.match(/(?:^|; )dse_oauth_state=([^;]+)/) || [])[1] || '';
      if (!state || state !== saved.split('.')[0] || !(await verifyState(saved, env.SESSION_SECRET))) {
        return new Response('OAuth state check failed. Return to the quiz site and reconnect.', { status: 400 });
      }
      if (url.searchParams.has('error')) return Response.redirect(`${SITE_HOME}?v=${Date.now()}#/records?sync=cancelled`, 302);
      const exchange = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
          code: url.searchParams.get('code'), redirect_uri: `${url.origin}/auth/callback`, state }),
      });
      const token = await exchange.json();
      if (!exchange.ok || !token.access_token) return new Response('GitHub authorization failed.', { status: 502 });
      const sessionId = await randomId();
      const sessionKey = await digest(sessionId);
      const session = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        expiresAt: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : 0,
      };
      let connectedId = sessionId;
      if (env.SITE_PASSWORD) {
        const user = await github('/user', token.access_token);
        if (String(user.login).toLowerCase() !== OWNER.toLowerCase()) return new Response('Only the repository owner can connect storage.', { status: 403 });
        await env.SESSIONS.put(OWNER_KEY, await seal(session, env.SESSION_SECRET));
        connectedId = await passwordSession(env);
      } else {
        await env.SESSIONS.put(sessionKey, await seal(session, env.SESSION_SECRET), {
          expirationTtl: Math.max(3600, Number(token.refresh_token_expires_in || 15897600)),
        });
      }
      const handoff = await randomId();
      await env.SESSIONS.put(`handoff:${await digest(handoff)}`, connectedId, { expirationTtl: 120, metadata: { oneTime: true } });
      const headers = new Headers({ location: `${SITE_HOME}?v=${Date.now()}#/records?sync=connected&handoff=${encodeURIComponent(handoff)}` });
      headers.append('set-cookie', 'dse_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/auth/callback; Max-Age=0');
      return new Response(null, { status: 302, headers });
    }
    if (url.pathname === '/auth/exchange' && request.method === 'POST') {
      if (request.headers.get('Origin') !== SITE_ORIGIN) return json({ error: 'origin_denied' }, 403, cors(request));
      const body = await request.json().catch(() => ({}));
      const handoffKey = `handoff:${await digest(String(body.handoff || ''))}`;
      const sessionId = await env.SESSIONS.get(handoffKey);
      if (!sessionId) return json({ error: 'handoff_expired' }, 410, cors(request));
      await env.SESSIONS.delete(handoffKey);
      return json({ sessionId }, 200, cors(request));
    }
    if (url.pathname === '/bank' || url.pathname.startsWith('/bank/')) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, cors(request));
      const image = url.pathname.match(/^\/bank\/images\/((?:chem|bio)-\d{4}-mc-\d+\.jpg)$/);
      if (url.pathname !== '/bank' && !image) return json({ error: 'not_found' }, 404, cors(request));
      const unavailable = configurationError(env, ['SESSION_SECRET', 'SESSIONS']);
      if (unavailable) return json({ error: 'service_not_configured' }, 503, cors(request));
      if (request.headers.get('Origin') !== SITE_ORIGIN) return json({ error: 'origin_denied' }, 403, cors(request));
      try {
        const auth = await tokenFor(request, env);
        if (!auth) return json({ error: 'not_connected' }, 401, cors(request));
        const user = await github('/user', auth.token);
        if (String(user.login).toLowerCase() !== OWNER.toLowerCase()) return json({ error: 'owner_only' }, 403, cors(request));
        const path = image ? `question-bank/images/${image[1]}` : BANK_PATH;
        const file = await github(`/repos/${REPO}/contents/${path}`, auth.token);
        if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('invalid_bank_file');
        if (!image) return json(JSON.parse(decodeUtf8(file.content)), 200, cors(request));
        const binary = atob(file.content.replace(/\n/g, ''));
        return new Response(Uint8Array.from(binary, char => char.charCodeAt(0)), {
          headers: cors(request, { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff' }),
        });
      } catch (error) {
        return json({ error: error.status === 503 ? error.message : 'bank_unavailable' }, [401, 403, 404, 503].includes(error.status) ? error.status : 502, cors(request));
      }
    }
    if (url.pathname === '/sync' && ['GET', 'PUT', 'DELETE'].includes(request.method)) {
      if (request.headers.get('Origin') !== SITE_ORIGIN) return json({ error: 'origin_denied' }, 403, cors(request));
      if (configurationError(env, ['SESSION_SECRET', 'SESSIONS'])) return json({ error: 'service_not_configured' }, 503, cors(request));
      let auth;
      const path = `/repos/${REPO}/contents/${DATA_PATH}`;
      try {
        auth = await tokenFor(request, env);
        if (!auth) return json({ error: 'not_connected' }, 401, cors(request));
        if (request.method === 'GET') {
          try {
            const file = await github(path, auth.token);
            const data = JSON.parse(decodeUtf8(file.content));
            return json({ data, sha: file.sha }, 200, cors(request));
          } catch (error) {
            if (error.status === 404) return json({ data: null, sha: null }, 200, cors(request));
            throw error;
          }
        }
        if (request.method === 'DELETE') {
          const current = await github(path, auth.token).catch(error => error.status === 404 ? null : Promise.reject(error));
          if (!current) return json({ ok: true, deleted: false }, 200, cors(request));
          await github(path, auth.token, { method: 'DELETE', body: JSON.stringify({ message: 'Clear synced practice records', sha: current.sha }) });
          return json({ ok: true, deleted: true }, 200, cors(request));
        }
        const body = await request.json();
        if (!body.data || body.data.app !== 'kyle-dse-quiz') return json({ error: 'invalid_backup' }, 400, cors(request));
        let saved = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await github(path, auth.token).catch(error => error.status === 404 ? null : Promise.reject(error));
          const merged = current
            ? mergeBackup(JSON.parse(decodeUtf8(current.content)), body.data)
            : body.data;
          const payload = { message: 'Sync practice records', content: encodeUtf8(JSON.stringify(merged, null, 2)) };
          if (current) payload.sha = current.sha;
          try {
            saved = await github(path, auth.token, { method: 'PUT', body: JSON.stringify(payload) });
            break;
          } catch (error) {
            if (error.status !== 409 || attempt === 2) throw error;
          }
        }
        return json({ ok: true, sha: saved && saved.content && saved.content.sha, savedAt: new Date().toISOString() }, 200, cors(request));
      } catch (error) {
        if (error.status === 401 && auth) await env.SESSIONS.delete(auth.sessionKey);
        return json({ error: error.message || 'github_error', status: error.status || 500 }, error.status || 500, cors(request));
      }
    }
    if (url.pathname === '/health') return json({ ok: true, service: 'kyle-dse-quiz-sync' });
    return json({ error: 'not_found' }, 404);
  },
};
