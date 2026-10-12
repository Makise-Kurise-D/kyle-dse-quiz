import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
// Synthetic fixtures contain no examination material; the live bank stays private.
const data = 'window.QUIZ_DATA = ' + JSON.stringify({ subjects: {
  chem: { name: '化學', topics: [{ code: 'T3', name: '示例課題' }], items: [
    { id: 'example-mc', kind: 'mc', topic: 'T3', year: '2022', paper: '卷一', qref: '示例 1', stem: '示例題', correctOpt: 'A', img: 'images/chem-2022-mc-01.jpg' }
  ] }, bio: { name: '生物', topics: [], items: [] }
} });
function boot(hash = '', fetch = async () => { throw new Error('offline'); }, initialStorage = {}, privateBank = false, passwordAuth = false) {
  const nodes = new Map(), events = {}, timers = [], intervals = [], saved = new Map(Object.entries(initialStorage));
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', hidden: false, listeners: {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelector: node, querySelectorAll: () => [],
    });
    return nodes.get(selector);
  }
  const location = { hash, pathname: '/kyle-dse-quiz/', search: '', href: 'original-page' };
  const context = {
    console, AbortController, fetch, location,
    document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) },
    history: { replaceState(_, __, url) { location.hash = url.slice(url.indexOf('#')); } },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {}, setInterval(fn, delay) { intervals.push({ fn, delay }); }, clearInterval() {},
    confirm: () => true,
    scrollTo() {}, addEventListener(type, fn) { events[type] = fn; },
    QUIZ_SYNC_API: 'https://sync.example.workers.dev', QUIZ_PRIVATE_BANK: privateBank, QUIZ_PASSWORD_AUTH: passwordAuth,
    URL, Blob,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(data, context);
  vm.runInContext(source, context);
  return { context, location, nodes, node, saved, timers, intervals, events };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('password login fetches the private bank, merges records, and automatically uploads without persisting the password', async () => {
  const local = { t: Date.now() - 2000, subj: 'chem', topic: 'T3', results: {} };
  const remote = { t: Date.now() - 1000, subj: 'bio', topic: 'I', results: {} };
  const calls = [], sessionId = 'p'.repeat(43);
  let uploaded;
  const app = boot('', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/password')) return { ok: true, json: async () => ({ sessionId }) };
    if (url.endsWith('/bank')) return { ok: true, json: async () => app.context.QUIZ_DATA };
    if (options.method === 'PUT') { uploaded = JSON.parse(options.body).data; return { ok: true, json: async () => ({ savedAt: new Date().toISOString() }) }; }
    return { ok: true, json: async () => ({ data: { app: 'kyle-dse-quiz', sessions: [remote], archive: [], drafts: {}, reviewPlan: {} } }) };
  }, { dse_quiz_sessions_v2: JSON.stringify([local]) }, true, true);
  assert.match(app.node('#app').innerHTML, /type="password".*登入並自動同步/s);
  assert.doesNotMatch(app.node('#app').innerHTML, /test-password/);
  app.node('#syncPassword').value = 'test-password';
  app.node('#passwordLoginForm').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(JSON.parse(calls[0].options.body).password, 'test-password');
  assert.equal(app.node('#syncPassword').value, '');
  assert.deepEqual(uploaded.sessions, [local, remote]);
  assert.equal(app.saved.get('dse_quiz_sync_session_v1'), sessionId);
  assert.ok([...app.saved.values()].every(value => !value.includes('test-password')));
  assert.equal(calls.find(call => call.url.endsWith('/bank')).options.headers.Authorization, 'Bearer ' + sessionId);
  assert.match(app.node('#syncStatus').textContent, /已自動同步/);
});

test('wrong passwords cannot load questions or overwrite progress', async () => {
  const calls = [];
  const app = boot('', async url => {
    calls.push(url);
    return { ok: false, status: 401, json: async () => ({ error: 'invalid_password' }) };
  }, {}, true, true);
  app.node('#syncPassword').value = 'wrong';
  app.node('#passwordLoginForm').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(app.saved.has('dse_quiz_sync_session_v1'), false);
  assert.match(app.node('#syncStatus').textContent, /密碼不正確/);
  assert.doesNotMatch(app.node('#app').innerHTML, /題在庫/);
});

test('an existing owner connection upgrades automatically before reading private data', async () => {
  const calls = [], sessionId = 'n'.repeat(43);
  const app = boot('', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/upgrade')) return { ok: true, json: async () => ({ sessionId }) };
    if (url.endsWith('/bank')) return { ok: true, json: async () => app.context.QUIZ_DATA };
    return { ok: true, json: async () => ({ data: null }) };
  }, { dse_quiz_sync_session_v1: 'old-owner-session' }, true, true);
  await settle();
  assert.ok(calls[0].url.endsWith('/auth/upgrade'));
  assert.equal(calls[0].options.headers.Authorization, 'Bearer old-owner-session');
  assert.equal(app.saved.get('dse_quiz_sync_session_v1'), sessionId);
  assert.equal(app.saved.get('dse_quiz_auth_mode_v1'), 'password');
  assert.equal(calls.find(call => call.url.endsWith('/bank')).options.headers.Authorization, 'Bearer ' + sessionId);
  assert.match(app.node('#app').innerHTML, /題在庫/);
});

test('automatic polling skips unchanged uploads, and logout retains local records', async () => {
  const calls = [];
  const app = boot('', async (url, options) => {
    calls.push({ url, method: options.method });
    const backup = { app: 'kyle-dse-quiz', sessions: [], archive: [], drafts: {}, reviewPlan: {}, cycle: app.saved.get('dse_quiz_cycle_v1') };
    return { ok: true, json: async () => ({ data: backup }) };
  }, { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password' }, false, true);
  app.location.hash = '#/records'; app.events.hashchange();
  app.intervals.find(timer => timer.delay === 60000).fn();
  await settle();
  assert.deepEqual(calls.map(call => call.method), ['GET']);
  assert.match(app.node('#app').innerHTML, /退出登入/);
  app.context.confirm = () => { throw new Error('Password logout must not depend on a browser dialog'); };
  app.node('#syncDisconnectBtn').listeners.click();
  await settle();
  assert.equal(app.saved.has('dse_quiz_sync_session_v1'), false);
  assert.equal(app.saved.get('dse_quiz_sessions_v2'), '[]');
  assert.ok(calls.some(call => call.url.endsWith('/auth/logout')));
  assert.match(app.node('#app').innerHTML, /passwordLoginForm/);
});

test('an expired session offers reconnection without deleting local records or uploading', async () => {
  const records = [{ t: Date.now(), subj: 'chem', topic: 'T3', results: {} }];
  const calls = [];
  const app = boot('', async (_, options) => {
    calls.push(options.method);
    return { ok: false, status: 401, json: async () => ({ error: 'not_connected' }) };
  }, { dse_quiz_sync_session_v1: 'expired-session', dse_quiz_sessions_v2: JSON.stringify(records) });
  app.location.hash = '#/records'; app.events.hashchange();
  app.node('#syncNowBtn').listeners.click();
  await settle();
  assert.deepEqual(calls, ['GET']);
  assert.equal(app.saved.has('dse_quiz_sync_session_v1'), false);
  assert.deepEqual(JSON.parse(app.saved.get('dse_quiz_sessions_v2')), records);
  assert.match(app.node('#app').innerHTML, /id="syncConnectBtn"/);
  assert.match(app.node('#syncStatus').textContent, /連接已失效.*HTTP 401/);
  app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /連接已失效.*HTTP 401/);
});

test('a non-JSON service failure keeps the session and exposes its HTTP status across navigation', async () => {
  const app = boot('', async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('HTML'); } }), {
    dse_quiz_sync_session_v1: 'valid-session'
  });
  app.location.hash = '#/records'; app.events.hashchange();
  app.node('#syncNowBtn').listeners.click();
  await settle();
  assert.match(app.node('#syncStatus').textContent, /HTTP 503/);
  assert.equal(app.saved.get('dse_quiz_sync_session_v1'), 'valid-session');
  app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /HTTP 503/);
  assert.match(app.node('#app').innerHTML, /重新连接 GitHub/);
});

test('an expired bank session locks the bank and preserves progress', async () => {
  const progress = JSON.stringify([{ t: Date.now(), subj: 'chem', topic: 'T3', results: {} }]);
  const app = boot('', async () => ({ ok: false, status: 401, json: async () => ({ error: 'not_connected' }) }), {
    dse_quiz_sync_session_v1: 'expired-session', dse_quiz_sessions_v2: progress
  }, true);
  await settle();
  assert.equal(app.saved.has('dse_quiz_sync_session_v1'), false);
  assert.equal(app.saved.get('dse_quiz_sessions_v2'), progress);
  assert.match(app.node('#app').innerHTML, /連接已失效/);
  assert.doesNotMatch(app.node('#app').innerHTML, /題在庫|bankRetryBtn/);
});

test('an image rejected for an expired session shows the reconnect gate', async () => {
  const app = boot('', async url => {
    if (url.endsWith('/bank')) return { ok: true, json: async () => app.context.QUIZ_DATA };
    return { ok: false, status: 401, json: async () => ({ error: 'not_connected' }) };
  }, { dse_quiz_sync_session_v1: 'expired-session' }, true);
  const img = { getAttribute: () => 'images/chem-2022-mc-01.jpg', src: '' };
  app.context.document.querySelectorAll = selector => selector === 'img[data-bank-image]' ? [img] : [];
  await settle();
  app.location.hash = '#/session/chem/T3'; app.events.hashchange();
  await settle();
  assert.equal(app.saved.has('dse_quiz_sync_session_v1'), false);
  assert.match(app.node('#app').innerHTML, /連接 GitHub 後.*連接已失效/s);
  assert.equal(img.src, '');
});

test('a delayed failure from an old session does not discard a new connection', async () => {
  let rejectOld;
  const app = boot('', () => new Promise(resolve => { rejectOld = resolve; }), {
    dse_quiz_sync_session_v1: 'old-session'
  });
  app.location.hash = '#/records'; app.events.hashchange();
  app.node('#syncNowBtn').listeners.click();
  app.saved.set('dse_quiz_sync_session_v1', 'new-session');
  rejectOld({ ok: false, status: 401, json: async () => ({ error: 'not_connected' }) });
  await settle();
  assert.equal(app.saved.get('dse_quiz_sync_session_v1'), 'new-session');
});

test('existing correct answers without a review plan do not break startup or OAuth sync', async () => {
  const sessions = [
    { t: 1791510000000, subj: 'chem', topic: 'T3', results: { 'old-mc': { ok: true, marks: 1, tot: 1 } } },
    { t: 1791510100000, subj: 'chem', topic: 'T3', results: { 'old-mc': { ok: true, marks: 1, tot: 1 }, 'old-sub': { ok: true, marks: 3, tot: 3 } } },
  ];
  let backup;
  const app = boot('#/records?sync=connected&handoff=test-handoff', async (url, options) => {
    if (url.endsWith('/auth/exchange')) return { ok: true, json: async () => ({ sessionId: 'test-session' }) };
    if (options.method === 'PUT') backup = JSON.parse(options.body).data;
    return { ok: true, json: async () => options.method === 'GET' ? { data: null } : { savedAt: '2026-10-09T08:00:00Z' } };
  }, { dse_quiz_sessions_v2: JSON.stringify(sessions) });
  assert.match(app.node('#app').innerHTML, /Kyle 嘅錯題本/);
  await settle();
  assert.deepEqual(backup.sessions, sessions);
  assert.equal(backup.reviewPlan['old-mc'].streak, 2);
  assert.equal(backup.reviewPlan['old-sub'].streak, 1);
  assert.equal(backup.reviewPlan['old-sub'].interval, 15);
  assert.match(app.node('#syncStatus').textContent, /已自動同步/);
});

test('fresh visits, restored records and session links all start on the home page', () => {
  for (const hash of ['', '#/records', '#/session/chem/T3']) {
    const app = boot(hash);
    assert.equal(app.location.hash, '#/');
    assert.match(app.node('#app').innerHTML, /Kyle 嘅錯題本/);
    app.location.hash = '#/records?test=1';
    app.events.hashchange();
    assert.match(app.node('#app').innerHTML, /做題記錄/);
    assert.match(app.node('#app').innerHTML, /target="_blank" rel="noopener"/);
    app.node('#syncConnectBtn').listeners.click();
    assert.equal(app.location.href, 'original-page');
  }
});

test('OAuth callback renders home immediately, then exchanges and syncs', async () => {
  const calls = [];
  const app = boot('#/records?sync=connected&handoff=test-handoff', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/exchange')) return { ok: true, json: async () => ({ sessionId: 'test-session' }) };
    return { ok: true, json: async () => options.method === 'GET' ? { data: null } : { savedAt: '2026-10-09T08:00:00Z' } };
  });
  assert.equal(app.location.hash, '#/');
  assert.match(app.node('#app').innerHTML, /Kyle 嘅錯題本/);
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[0].options.body).handoff, 'test-handoff');
  assert.equal(app.saved.get('dse_quiz_sync_session_v1'), 'test-session');
  assert.match(app.node('#syncStatus').textContent, /已自動同步/);
});

test('failed authorization and cancelled authorization leave a visible home page', async () => {
  const failed = boot('#/records?handoff=test');
  await settle();
  assert.match(failed.node('#app').innerHTML, /Kyle 嘅錯題本/);
  assert.match(failed.node('#syncStatus').textContent, /连接失败/);
  const cancelled = boot('#/records?sync=cancelled');
  assert.equal(cancelled.location.hash, '#/');
  assert.match(cancelled.node('#syncStatus').textContent, /已取消/);
});

test('stalled authorization times out visibly instead of leaving a blank page', async () => {
  const app = boot('#/records?handoff=test', (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  app.timers.find(timer => timer.delay === 15000).fn();
  await settle();
  assert.match(app.node('#syncStatus').textContent, /逾時/);
  assert.match(app.node('#app').innerHTML, /Kyle 嘅錯題本/);
});

test('private mode never renders the bundled question bank before authentication', () => {
  const app = boot('', undefined, {}, true);
  assert.match(app.node('#app').innerHTML, /連接 GitHub 後/);
  assert.doesNotMatch(app.node('#app').innerHTML, /題在庫/);
  assert.equal(app.saved.get('dse_quiz_sessions_v2'), undefined);
});

test('OAuth loads the private bank without copying questions into persistent storage', async () => {
  const calls = [];
  const app = boot('#/records?handoff=test', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/exchange')) return { ok: true, json: async () => ({ sessionId: 'test-session' }) };
    if (url.endsWith('/bank')) return { ok: true, json: async () => app.context.QUIZ_DATA };
    return { ok: true, json: async () => ({ data: null }) };
  }, {}, true);
  await settle();
  assert.match(app.node('#app').innerHTML, /題在庫/);
  assert.equal(calls.find(c => c.url.endsWith('/bank')).options.headers.Authorization, 'Bearer test-session');
  assert.ok([...app.saved.keys()].every(key => !key.includes('bank')));
  app.location.hash = '#/records'; app.events.hashchange();
  app.events.storage({ key: 'dse_quiz_sync_session_v1', newValue: null });
  app.saved.delete('dse_quiz_sync_session_v1');
  app.location.hash = '#/practice/chem'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /連接 GitHub 後/);
});

test('a denied private bank stays locked while existing records remain intact', async () => {
  const records = [{ t: Date.now(), subj: 'chem', topic: 'T3', results: {} }];
  const app = boot('', async () => ({ ok: false, status: 403 }), {
    dse_quiz_sync_session_v1: 'test-session', dse_quiz_sessions_v2: JSON.stringify(records)
  }, true);
  await settle();
  assert.match(app.node('#app').innerHTML, /未能讀取錯題庫/);
  assert.deepEqual(JSON.parse(app.saved.get('dse_quiz_sessions_v2')), records);
});

test('private images are fetched with authorization and displayed using revocable local URLs', async () => {
  const calls = [], revoked = [];
  const app = boot('', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/bank')) return { ok: true, json: async () => app.context.QUIZ_DATA };
    return { ok: true, blob: async () => new Blob(['example-image']) };
  }, { dse_quiz_sync_session_v1: 'test-session' }, true);
  app.context.URL = { createObjectURL: () => 'blob:private-test-image', revokeObjectURL: url => revoked.push(url) };
  const img = { getAttribute: () => 'images/chem-2022-mc-01.jpg', src: '' };
  app.context.document.querySelectorAll = selector => selector === 'img[data-bank-image]' ? [img] : [];
  await settle();
  app.location.hash = '#/session/chem/T3'; app.events.hashchange();
  await settle();
  const image = calls.find(call => call.url.includes('/bank/images/'));
  assert.equal(image.options.headers.Authorization, 'Bearer test-session');
  assert.equal(image.options.cache, 'no-store');
  assert.ok(!image.url.includes('test-session'));
  assert.equal(img.src, 'blob:private-test-image');
  app.saved.delete('dse_quiz_sync_session_v1');
  app.events.storage({ key: 'dse_quiz_sync_session_v1', newValue: null });
  assert.deepEqual(revoked, ['blob:private-test-image']);
});
