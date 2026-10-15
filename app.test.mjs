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
function boot(hash = '', fetch = async () => { throw new Error('offline'); }, initialStorage = {}, privateBank = false, passwordAuth = false, now = null) {
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
  const Clock = now == null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const context = {
    console, AbortController, fetch, location, Date: Clock,
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
  vm.runInContext(readFileSync(new URL('./library.js', import.meta.url), 'utf8'), context);
  vm.runInContext(source, context);
  return { context, location, nodes, node, saved, timers, intervals, events };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('structured library uses the loaded private bank without book requests and preserves history across cycle rollover', async () => {
  const calls = [], now = Date.UTC(2026, 9, 15);
  const archive = [{ t: now - 30 * 864e5, subj: 'chem', topic: 'T3', results: { 'example-mc': { ok: true, marks: 1, tot: 1 } } },
    { t: now - 20 * 864e5, subj: 'chem', topic: 'T3', results: { 'example-mc': { ok: true, marks: 1, tot: 1 } } }];
  const app = boot('', async url => { calls.push(url); throw new Error('unexpected network'); },
    { dse_quiz_archive_v1: JSON.stringify(archive) }, false, false, now);
  app.location.hash = '#/library/books'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /生物/);
  assert.match(app.node('#app').innerHTML, /化學/);
  assert.match(app.node('#app').innerHTML, /數學/);
  app.location.hash = '#/library/books/chem'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /100/);
  assert.match(app.node('#mlTopics').innerHTML, /示例課題/);
  app.location.hash = '#/library/books/chem/T3'; app.events.hashchange();
  assert.match(app.node('#mlQuestions').innerHTML, /我的原答案/);
  assert.match(app.node('#mlQuestions').innerHTML, /扣分點與錯因/);
  assert.match(app.node('#mlQuestions').innerHTML, /ml-mastered/);
  assert.equal(calls.length, 0, 'browsing text requests neither reader pages nor images');
  assert.equal(app.saved.get('dse_quiz_archive_v1'), JSON.stringify(archive), 'reading does not write exercise records');
  const locked = boot('', async () => { throw new Error('unexpected'); }, {}, true, true);
  locked.location.hash = '#/library/books/chem'; locked.events.hashchange();
  assert.match(locked.node('#app').innerHTML, /登入並自動同步/);
});

test('library offers two entrances, then graded papers select subject and published year', async () => {
  const calls = [], revoked = [];
  const app = boot('', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ subjects: {
      chem: ['2024', '2022'], bio: ['2023'],
    } }) };
    if (url.includes('/manifest')) return { ok: true, json: async () => ({
      version: 'c'.repeat(16), pages: 2, format: 'jpeg', source_sha256: 'c'.repeat(64),
    }) };
    return { ok: true, blob: async () => new Blob(['paper-page'], { type: 'image/jpeg' }) };
  }, { dse_quiz_sync_session_v1: 'valid-session' });
  let serial = 0;
  app.context.URL = { createObjectURL: () => 'blob:paper-' + (++serial),
    revokeObjectURL: url => revoked.push(url) };

  app.location.hash = '#/library'; app.events.hashchange();
  await settle();
  const choices = app.node('#app').innerHTML;
  assert.match(choices, /href="#\/library\/books".*錯題庫/s);
  assert.match(choices, /href="#\/library\/papers".*紅筆批改卷/s);
  assert.equal((choices.match(/class="library-hub-card /g) || []).length, 2);
  assert.equal(app.node('#libraryPaperCount').textContent, '3');
  assert.equal(app.node('#libraryNewestYear').textContent, '2024');
  assert.equal(calls.length, 1);

  app.location.hash = '#/library/papers'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /href="#\/library\/papers\/chem"/);
  assert.match(app.node('#app').innerHTML, /href="#\/library\/papers\/bio"/);
  assert.equal(calls.length, 1);

  app.location.hash = '#/library/papers/chem'; app.events.hashchange();
  await settle();
  assert.equal(calls[0].url, 'https://sync.example.workers.dev/papers/catalog');
  assert.match(app.node('#paperYears').innerHTML, /href="#\/library\/papers\/chem\/2024"/);
  assert.match(app.node('#paperYears').innerHTML, /href="#\/library\/papers\/chem\/2022"/);
  assert.doesNotMatch(app.node('#paperYears').innerHTML, /2023/);
  assert.equal(calls.length, 1, 'year selection reuses the recently loaded catalog');

  app.location.hash = '#/library/papers/chem/2024'; app.events.hashchange();
  await settle();
  assert.deepEqual(calls.slice(1).map(call => call.url), [
    'https://sync.example.workers.dev/papers/chem/2024/manifest',
    'https://sync.example.workers.dev/papers/chem/2024/pages/cccccccccccccccc/1',
  ]);
  assert.equal(app.node('#paperImage').src, 'blob:paper-1');
  assert.equal(app.node('#paperReader').hidden, false);
  assert.equal(app.node('#paperOpen').href, 'blob:paper-1');
  app.node('#paperNext').listeners.click();
  await settle();
  assert.equal(app.node('#paperImage').src, 'blob:paper-2');
  assert.equal(calls.at(-1).url, 'https://sync.example.workers.dev/papers/chem/2024/pages/cccccccccccccccc/2');
  assert.deepEqual(revoked, ['blob:paper-1']);
  app.location.hash = '#/library/papers/bio'; app.events.hashchange();
  assert.deepEqual(revoked, ['blob:paper-1', 'blob:paper-2']);
  assert.ok(calls.every(call => call.options.cache === 'no-store' &&
    call.options.headers.Authorization === 'Bearer valid-session'));
  assert.ok([...app.saved.values()].every(value => !value.includes('paper-page')));
});

test('paper year rows use integer marks at inclusive grade boundaries and distinguish missing scores', async () => {
  const catalog = { subjects: { chem: ['2025', '2024', '2023', '2022'], bio: [] }, papers: { chem: {
    '2025': { pages: 10, assessment: { earned: 31, total: 40, scope: '兩卷練習', components: [], boundaries: [
      { level: '5', minimumPercent: 67 }, { level: '5*', minimumPercent: 77 }, { level: '5**', minimumPercent: 83 },
    ] } },
    '2024': { assessment: { earned: 65, total: 100, scope: '僅卷一', components: [], boundaries: [
      { level: '3', minimumPercent: 50 }, { level: '4', minimumPercent: 65 }, { level: '5', minimumPercent: 75 },
    ] } },
    '2023': { assessment: { earned: 90, total: 100, scope: '<img onerror="alert(1)">', components: [], boundaries: [
      { level: '5*', minimumPercent: 80 }, { level: '5**', minimumPercent: 85 },
    ] } },
    '2022': { pages: 12 },
  }, bio: {} } };
  const app = boot('', async () => ({ ok: true, json: async () => catalog }),
    { dse_quiz_sync_session_v1: 'valid-session' });
  app.location.hash = '#/library/papers/chem'; app.events.hashchange();
  await settle();
  const html = app.node('#paperYears').innerHTML;
  assert.match(html, /5\* · 估算/);
  assert.match(html, /升至 5\*\* 尚欠 3 分/);
  assert.match(html, /再失 1 分跌至 5/);
  assert.match(html, /保級餘量 0 分 · 77% 分界/);
  assert.match(html, /升至 5 尚欠 10 分/);
  assert.match(html, /再失 1 分跌至 3/);
  assert.match(html, /僅卷一/);
  assert.match(html, /已達最高參考等級/);
  assert.match(html, /成績待補/);
  assert.doesNotMatch(html, /<img onerror/);
});

test('graded-paper reader shares an in-flight next-page request with navigation', async () => {
  const calls = [];
  let finishNextPage;
  const app = boot('', async url => {
    calls.push(url);
    if (url.endsWith('/catalog')) return { ok: true, json: async () => ({
      subjects: { chem: ['2022'], bio: [] },
    }) };
    if (url.includes('/manifest')) return { ok: true, json: async () => ({
      version: 'b'.repeat(16), pages: 2, format: 'jpeg', source_sha256: 'b'.repeat(64),
    }) };
    if (url.endsWith('/2')) return new Promise(resolve => { finishNextPage = resolve; });
    return { ok: true, blob: async () => new Blob(['first-page'], { type: 'image/jpeg' }) };
  }, { dse_quiz_sync_session_v1: 'valid-session' });
  let serial = 0;
  app.context.URL = { createObjectURL: () => 'blob:paper-cache-' + (++serial), revokeObjectURL() {} };
  app.location.hash = '#/library/papers/chem/2022'; app.events.hashchange();
  await settle();
  app.timers.find(timer => timer.delay === 200).fn();
  assert.equal(typeof finishNextPage, 'function');
  app.node('#paperNext').listeners.click();
  assert.equal(calls.filter(url => url.endsWith('/2')).length, 1, 'navigation reuses the prefetch');
  finishNextPage({ ok: true, blob: async () => new Blob(['second-page'], { type: 'image/jpeg' }) });
  await settle();
  assert.equal(app.node('#paperImage').src, 'blob:paper-cache-2');
  assert.equal(app.node('#paperImage').hidden, false);
});

test('graded-paper reload switches image version and empty subjects give a clear result', async () => {
  const urls = [], revoked = [];
  let version = 'd'.repeat(16), serial = 0;
  const app = boot('', async url => {
    urls.push(url);
    if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ subjects: { chem: ['2022'], bio: [] } }) };
    if (url.includes('/manifest')) return { ok: true, json: async () => ({
      version, pages: 1, format: 'jpeg', source_sha256: version.repeat(4),
    }) };
    return { ok: true, blob: async () => new Blob(['page'], { type: 'image/jpeg' }) };
  }, { dse_quiz_sync_session_v1: 'valid-session' });
  app.context.URL = { createObjectURL: () => 'blob:graded-' + (++serial),
    revokeObjectURL: url => revoked.push(url) };
  app.location.hash = '#/library/papers/bio'; app.events.hashchange();
  await settle();
  assert.match(app.node('#paperYearsStatus').textContent, /尚無已發布/);
  assert.equal(app.node('#paperYears').innerHTML, '');
  app.location.hash = '#/library/papers/chem/2022'; app.events.hashchange();
  await settle();
  assert.equal(app.node('#paperImage').src, 'blob:graded-1');
  version = 'e'.repeat(16);
  app.node('#paperReload').listeners.click();
  await settle();
  assert.deepEqual(revoked, ['blob:graded-1']);
  assert.equal(app.node('#paperImage').src, 'blob:graded-2');
  assert.equal(urls.at(-1), 'https://sync.example.workers.dev/papers/chem/2022/pages/eeeeeeeeeeeeeeee/1');
});

test('unpublished graded papers show an explanation and no image', async () => {
  const app = boot('', async () => ({ ok: false, status: 404,
    json: async () => ({ error: 'paper_not_accessible' }) }),
  { dse_quiz_sync_session_v1: 'valid-session' });
  app.location.hash = '#/library/papers/bio/2022'; app.events.hashchange();
  await settle();
  assert.match(app.node('#paperStatus').textContent, /暫未發布/);
  assert.equal(app.node('#paperImage').hidden, true);
});

test('fortnight report counts latest full answers, first-time solves and regressions by unique question', () => {
  const start = Date.UTC(2026, 9, 4, 16); // 2026/10/05 00:00 Beijing time
  const day = 864e5;
  const result = ok => ({ kind: 'mc', ok, marks: ok ? 1 : 0, tot: 1 });
  const previous = { t: start - day, subj: 'chem', topic: 'T3', results: {
    'example-mc': result(true), e: result(true)
  } };
  const first = { t: start + day, subj: 'chem', topic: 'T3', results: {
    'example-mc': result(false), b: result(true), c: result(true), d: result(false), e: result(false)
  } };
  const last = { t: start + 2 * day, subj: 'chem', topic: 'T3', results: {
    b: result(true), c: result(false), d: result(true), e: result(true)
  } };
  const app = boot('', undefined, {
    dse_quiz_archive_v1: JSON.stringify([previous, first]),
    dse_quiz_sessions_v2: JSON.stringify([first, last]) // one session also appears in archive
  }, false, false, start + 8 * day);
  for (const id of ['b', 'c', 'd', 'e']) app.context.QUIZ_DATA.subjects.chem.items.push({
    id, kind: 'mc', topic: 'T3', year: '2022', qref: `示例 ${id}`
  });
  app.location.hash = '#/records'; app.events.hashchange();
  const current = app.node('#app').innerHTML;
  assert.match(current, /<b>5<\/b><span>本期做過的不同題目/);
  assert.match(current, /<b>3 \/ 5<\/b><span>本期最後一次答對/);
  assert.match(current, /<b>60%<\/b><span>佔目前題庫/);
  assert.match(current, /首次解決（2）/);
  assert.match(current, /答對後再錯（2）/);
  assert.match(current, /2026\/10\/05—2026\/10\/18（北京時間）/);
  app.node('#cycleReportPeriod').listeners.change({ target: { value: String(start - 14 * day) } });
  const earlier = app.node('#app').innerHTML;
  assert.match(earlier, /<b>2 \/ 5<\/b><span>該期最後一次答對/);
  assert.match(earlier, /首次解決（2）/);
  assert.match(earlier, /答對後再錯（0）/);
});

test('fortnight report survives rollover and waits for the private bank before calculating coverage', () => {
  const start = Date.UTC(2026, 9, 4, 16), day = 864e5;
  const records = [{ t: start + day, subj: 'chem', topic: 'T3', results: {
    'example-mc': { kind: 'mc', ok: true, marks: 1, tot: 1 }
  } }];
  const now = start + 15 * day;
  const app = boot('', undefined, { dse_quiz_sessions_v2: JSON.stringify(records),
    dse_quiz_cycle_v1: String(start) }, false, false, now);
  app.location.hash = '#/records'; app.events.hashchange();
  assert.equal(JSON.parse(app.saved.get('dse_quiz_archive_v1')).length, 1);
  assert.match(app.node('#app').innerHTML, /<b>0 \/ 1<\/b><span>本期最後一次答對/);
  app.node('#cycleReportPeriod').listeners.change({ target: { value: String(start) } });
  assert.match(app.node('#app').innerHTML, /<b>1 \/ 1<\/b><span>該期最後一次答對/);

  const locked = boot('', undefined, { dse_quiz_sessions_v2: JSON.stringify(records) }, true, true, now);
  locked.location.hash = '#/records'; locked.events.hashchange();
  assert.match(locked.node('#app').innerHTML, /登入並載入私人題庫後/);
  assert.doesNotMatch(locked.node('#app').innerHTML, /佔目前題庫/);
});

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
  assert.match(app.node('#syncStatus').textContent, /已上傳至雲端/);
});

test('password login starts cloud sync while the private bank is still loading', async () => {
  const calls = [], sessionId = 'p'.repeat(43);
  let finishBank;
  const app = boot('', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/password')) return { ok: true, json: async () => ({ sessionId }) };
    if (url.endsWith('/bank')) return new Promise(resolve => { finishBank = resolve; });
    return { ok: true, json: async () => ({ data: null }) };
  }, {}, true, true);
  app.node('#syncPassword').value = 'test-password';
  app.node('#passwordLoginForm').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(typeof finishBank, 'function');
  assert.ok(calls.some(call => call.url.endsWith('/sync') && call.options.method === 'GET'),
    'records begin downloading before the bank finishes');
  assert.match(app.node('#app').innerHTML, /開始練習/);
  assert.doesNotMatch(app.node('#app').innerHTML, /passwordLoginForm/);
  finishBank({ ok: true, json: async () => app.context.QUIZ_DATA });
  await settle();
  assert.match(app.node('#app').innerHTML, /題在庫/);
});

test('a returning browser opens home before either private request completes and updates after each one', async () => {
  const calls = [], cycle = boot().saved.get('dse_quiz_cycle_v1');
  let finishBank, finishSync;
  const remote = { app: 'kyle-dse-quiz', sessions: [{ t: Date.now(), subj: 'chem', topic: 'T3',
    results: { 'example-mc': { ok: true, marks: 1, tot: 1 } } }], archive: [], drafts: {}, reviewPlan: {}, cycle };
  const app = boot('#/records', (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith('/bank')) return new Promise(resolve => { finishBank = resolve; });
    if (options.method === 'GET') return new Promise(resolve => { finishSync = resolve; });
    throw new Error('unchanged remote records must not be uploaded');
  }, { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password', dse_quiz_cycle_v1: cycle }, true, true);
  assert.equal(app.location.hash, '#/');
  assert.match(app.node('#app').innerHTML, /開始練習/);
  assert.match(app.node('#app').innerHTML, /<b>—<\/b> 題在庫/);
  assert.doesNotMatch(app.node('#app').innerHTML, /passwordLoginForm/);
  assert.equal(typeof finishBank, 'function');
  assert.equal(app.timers.some(timer => timer.delay === 600), false);
  app.timers.find(timer => timer.delay === 0).fn();
  assert.equal(typeof finishSync, 'function', 'cloud read starts while bank is pending');
  finishBank({ ok: true, json: async () => app.context.QUIZ_DATA });
  await settle();
  assert.match(app.node('#app').innerHTML, /<b>1<\/b> 題在庫/);
  assert.match(app.node('#app').innerHTML, /class="c-green">0<\/b> 已征服/);
  finishSync({ ok: true, json: async () => ({ data: remote }) });
  await settle();
  assert.match(app.node('#app').innerHTML, /class="c-green">1<\/b> 已征服/);
  assert.match(app.node('#app').innerHTML, /class="c-red">0<\/b> 待清/);
  assert.match(app.node('#syncStatus').textContent, /已更新本機記錄/);
  assert.equal(calls.length, 2);
  assert.ok([...app.saved.values()].every(value => !value.includes('示例題')));
});

test('a failed bank keeps home usable, retries on reconnect and keeps practice behind a loading view', async () => {
  let bankCalls = 0, finishBank;
  const app = boot('', async url => {
    if (!url.endsWith('/bank')) return { ok: true, json: async () => ({ data: null }) };
    if (++bankCalls <= 3) return { ok: false, status: 503, json: async () => ({ error: 'storage_timeout' }) };
    return new Promise(resolve => { finishBank = resolve; });
  }, { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password' }, true, true);
  await settle();
  app.timers.find(timer => timer.delay === 1000).fn(); await settle();
  app.timers.find(timer => timer.delay === 3000).fn(); await settle();
  assert.match(app.node('#app').innerHTML, /開始練習/);
  assert.match(app.node('#app').innerHTML, /重試載入錯題庫/);
  assert.doesNotMatch(app.node('#app').innerHTML, /passwordLoginForm/);
  app.location.hash = '#/practice/chem'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /題庫載入後會自動顯示/);
  assert.doesNotMatch(app.node('#app').innerHTML, /passwordLoginForm|示例題/);
  app.location.hash = '#/records'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /累計作答/);
  app.events.online(); app.events.focus();
  assert.equal(bankCalls, 4, 'reconnect and focus share one retry after the bounded attempts');
  finishBank({ ok: true, json: async () => app.context.QUIZ_DATA });
  await settle();
  app.location.hash = '#/'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /<b>1<\/b> 題在庫/);
});

test('bank timeouts cover headers and body, retry automatically and never block home or clear login', async () => {
  for (const phase of ['headers', 'body', 'body-network']) {
    let calls = 0;
    const progress = JSON.stringify([{ t: Date.now(), subj: 'chem', topic: 'T3', results: {} }]);
    const app = boot('', async (url, options) => {
      if (!url.endsWith('/bank')) return { ok: true, json: async () => ({ data: null }) };
      if (++calls > 1) return { ok: true, json: async () => app.context.QUIZ_DATA };
      if (phase === 'body-network') return { ok: true, json: async () => { throw new TypeError('Body stream disconnected'); } };
      const stall = () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return phase === 'headers' ? stall() : { ok: true, json: stall };
    }, { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password', dse_quiz_sessions_v2: progress }, true, true);
    await settle();
    assert.match(app.node('#app').innerHTML, /開始練習/);
    if (phase !== 'body-network') app.timers.find(timer => timer.delay === 30000).fn();
    await settle();
    assert.match(app.node('#bankStatus').textContent, /正在自動重試/);
    assert.doesNotMatch(app.node('#bankStatus').textContent, /同步連線逾時/);
    app.events.focus();
    assert.equal(calls, 1, 'focus shares the retry in progress');
    app.timers.find(timer => timer.delay === 1000).fn();
    await settle();
    assert.equal(calls, 2);
    assert.match(app.node('#app').innerHTML, /<b>1<\/b> 題在庫/);
    assert.equal(app.saved.get('dse_quiz_sync_session_v1'), 'p'.repeat(43));
    assert.equal(app.saved.get('dse_quiz_sessions_v2'), progress);
    assert.ok([...app.saved.values()].every(value => !value.includes('示例題')));
  }
});

test('bounded bank retries recover on the minute poll without a page refresh', async () => {
  let calls = 0;
  const app = boot('', async url => {
    if (!url.endsWith('/bank')) return { ok: true, json: async () => ({ data: null }) };
    if (++calls <= 3) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => app.context.QUIZ_DATA };
  }, { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password' }, true, true);
  await settle();
  app.timers.find(timer => timer.delay === 1000).fn(); await settle();
  app.timers.find(timer => timer.delay === 3000).fn(); await settle();
  assert.equal(calls, 3);
  assert.match(app.node('#app').innerHTML, /重試載入錯題庫/);
  app.intervals.find(timer => timer.delay === 60000).fn();
  await settle();
  assert.equal(calls, 4);
  assert.match(app.node('#app').innerHTML, /<b>1<\/b> 題在庫/);
});

test('authentication, configuration and invalid bank errors do not trigger automatic retries', async () => {
  for (const [status, error] of [[401,'not_connected'],[403,'origin_denied'],[404,'not_found'],[503,'owner_connection_required'],[503,'service_not_configured'],[200,null]]) {
    let calls = 0;
    const app = boot('', async () => {
      calls++;
      return { ok: status === 200, status, json: async () => ({ error }) };
    }, { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password' }, true, true);
    await settle();
    assert.equal(calls, 1);
    assert.equal(app.timers.some(timer => timer.delay === 1000 || timer.delay === 3000), false);
    assert.equal(app.saved.has('dse_quiz_sync_session_v1'), status !== 401);
  }
  for (const data of [null, { subjects: { chem: { topics: [], items: [null] }, bio: { topics: [], items: [] } } }]) {
    let bankCalls = 0;
    const app = boot('', async url => {
      if (!url.endsWith('/bank')) return { ok: true, json: async () => ({ data: null }) };
      bankCalls++;
      return { ok: true, json: async () => data };
    }, { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password' }, true, true);
    await settle();
    app.intervals.find(timer => timer.delay === 60000).fn();
    await settle();
    assert.equal(bankCalls, 1, 'invalid bank objects do not become recurring network retries');
  }
});

test('a queued retry is cancelled when its session is replaced or logged out', async () => {
  for (const next of ['new-session', null]) {
    let calls = 0;
    const app = boot('', async url => {
      if (!url.endsWith('/bank')) return { ok: true, json: async () => ({ data: null }) };
      if (++calls === 1) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => app.context.QUIZ_DATA };
    }, { dse_quiz_sync_session_v1: 'old-session', dse_quiz_auth_mode_v1: 'password' }, true, true);
    await settle();
    if (next) app.saved.set('dse_quiz_sync_session_v1', next);
    else app.saved.delete('dse_quiz_sync_session_v1');
    app.events.storage({ key: 'dse_quiz_sync_session_v1', newValue: next });
    await settle();
    app.timers.find(timer => timer.delay === 1000).fn();
    await settle();
    assert.equal(calls, next ? 2 : 1);
    assert.equal(app.saved.get('dse_quiz_sync_session_v1'), next || undefined);
    assert.doesNotMatch(app.node('#app').innerHTML, /未能讀取錯題庫/);
  }
});

test('bank arrival does not interrupt paper browsing', async () => {
  let finishBank;
  const calls = [];
  const app = boot('', async url => {
    calls.push(url);
    if (url.endsWith('/bank')) return new Promise(resolve => { finishBank = resolve; });
    return { ok: true, json: async () => ({ subjects: { chem: [], bio: [] } }) };
  }, { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password' }, true, true);
  app.location.hash = '#/library/papers/chem'; app.events.hashchange();
  await settle();
  assert.match(app.node('#app').innerHTML, /paperYears/);
  const html = app.node('#app').innerHTML;
  app.node('#app').innerHTML += '<span>scroll-and-focus-sentinel</span>';
  finishBank({ ok: true, json: async () => app.context.QUIZ_DATA });
  await settle();
  assert.equal(app.node('#app').innerHTML, html + '<span>scroll-and-focus-sentinel</span>');
  assert.equal(calls.filter(url => url.endsWith('/catalog')).length, 1);
});

test('a slow bank from a replaced session cannot delay or overwrite the new bank', async () => {
  let finishOldBank, finishNewBank;
  const app = boot('', async (url, options) => {
    if (!url.endsWith('/bank')) return { ok: true, json: async () => ({ data: null }) };
    return new Promise(resolve => {
      if (options.headers.Authorization.includes('old-session')) finishOldBank = resolve;
      else finishNewBank = resolve;
    });
  }, { dse_quiz_sync_session_v1: 'old-session', dse_quiz_auth_mode_v1: 'password' }, true, true);
  app.saved.set('dse_quiz_sync_session_v1', 'new-session');
  app.events.storage({ key: 'dse_quiz_sync_session_v1', newValue: 'new-session' });
  assert.equal(typeof finishNewBank, 'function', 'new session starts without waiting for the old bank');
  finishNewBank({ ok: true, json: async () => app.context.QUIZ_DATA });
  await settle();
  finishOldBank({ ok: false, status: 401, json: async () => ({ error: 'not_connected' }) });
  await settle();
  assert.equal(app.saved.get('dse_quiz_sync_session_v1'), 'new-session');
  assert.match(app.node('#app').innerHTML, /<b>1<\/b> 題在庫/);
  assert.doesNotMatch(app.node('#app').innerHTML, /未能讀取錯題庫|passwordLoginForm/);
});

test('login network timeouts are distinguished from storage failures and preserve local records', async () => {
  const local = [{ t: Date.now(), subj: 'chem', topic: 'T3', results: {} }];
  const app = boot('', async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }), { dse_quiz_sessions_v2: JSON.stringify(local) }, true, true);
  app.node('#syncPassword').value = 'test-password';
  app.node('#passwordLoginForm').listeners.submit({ preventDefault() {} });
  app.timers.find(timer => timer.delay === 15000).fn();
  await settle();
  assert.match(app.node('#syncStatus').textContent, /登入失敗：登入服務連線逾時/);
  assert.equal(app.saved.has('dse_quiz_sync_session_v1'), false);
  assert.equal(JSON.parse(app.saved.get('dse_quiz_sessions_v2')).length, 1);
  assert.equal(app.node('#passwordLoginBtn').disabled, false);

  const id = 'p'.repeat(43);
  const connected = boot('', async url => url.endsWith('/auth/password')
    ? { ok: true, json: async () => ({ sessionId: id }) }
    : { ok: false, status: 503, json: async () => ({ error: 'storage_timeout' }) },
    { dse_quiz_sessions_v2: JSON.stringify(local) }, true, true);
  connected.node('#syncPassword').value = 'test-password';
  connected.node('#passwordLoginForm').listeners.submit({ preventDefault() {} });
  await settle();
  connected.timers.find(timer => timer.delay === 1000).fn(); await settle();
  connected.timers.find(timer => timer.delay === 3000).fn(); await settle();
  assert.equal(connected.saved.get('dse_quiz_sync_session_v1'), id);
  assert.match(connected.node('#app').innerHTML, /資料儲存回應逾時/);
  assert.doesNotMatch(connected.node('#syncStatus').textContent, /登入失敗/);
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
  assert.match(app.node('#syncStatus').textContent, /雲端已核對，無新記錄/);
  assert.doesNotMatch(app.node('#syncStatus').textContent, /練習\s*\d+\s*次|已答題/);
  assert.match(app.node('#app').innerHTML, /退出登入/);
  app.context.confirm = () => { throw new Error('Password logout must not depend on a browser dialog'); };
  app.node('#syncDisconnectBtn').listeners.click();
  await settle();
  assert.equal(app.saved.has('dse_quiz_sync_session_v1'), false);
  assert.equal(app.saved.get('dse_quiz_sessions_v2'), '[]');
  assert.ok(calls.some(call => call.url.endsWith('/auth/logout')));
  assert.match(app.node('#app').innerHTML, /passwordLoginForm/);
});

test('sync combines answers from two computers and reports an upload only when one occurs', async () => {
  const cycle = boot().saved.get('dse_quiz_cycle_v1');
  const key = 'chem:T3';
  const localDraft = { pick: { a: 'A' }, text: {}, paper: {}, changedAt: { 'pick:a': 110 }, deletedAt: 0 };
  const remoteDraft = { pick: { b: 'B' }, text: {}, paper: {}, changedAt: { 'pick:b': 120 }, deletedAt: 0 };
  const remote = { app: 'kyle-dse-quiz', sessions: [], archive: [], drafts: { [key]: remoteDraft }, reviewPlan: {}, cycle };
  let uploaded, sentSha, puts = 0;
  const app = boot('', async (_, options) => {
    if (options.method === 'PUT') {
      puts++;
      const body = JSON.parse(options.body);
      uploaded = body.data;
      sentSha = body.sha;
      return { ok: true, json: async () => ({ savedAt: '2026-10-12T16:00:00Z' }) };
    }
    return { ok: true, json: async () => ({ data: remote, sha: 'a'.repeat(40) }) };
  }, { dse_quiz_sync_session_v1: 'valid-session', dse_quiz_cycle_v1: cycle,
    dse_quiz_draft_v2: JSON.stringify({ [key]: localDraft }) }, false, true);
  app.location.hash = '#/records'; app.events.hashchange();
  app.node('#syncNowBtn').listeners.click();
  await settle();
  assert.equal(puts, 1);
  assert.equal(sentSha, 'a'.repeat(40), 'the upload reuses the version just read');
  assert.deepEqual(uploaded.drafts[key].pick, { a: 'A', b: 'B' });
  assert.match(app.node('#syncStatus').textContent, /已上傳至雲端/);
});

test('an answer changed during an upload stays visibly pending until a later sync', async () => {
  let finishPut;
  const app = boot('', async (_, options) => {
    if (options.method === 'PUT') return new Promise(resolve => { finishPut = resolve; });
    return { ok: true, json: async () => ({ data: null }) };
  }, { dse_quiz_sync_session_v1: 'valid-session' }, false, true);
  app.location.hash = '#/records'; app.events.hashchange();
  app.node('#syncNowBtn').listeners.click();
  await settle();
  assert.equal(typeof finishPut, 'function');
  const choice = { dataset: { l: 'A' }, classList: { toggle() {} } };
  const box = { dataset: { id: 'example-mc' }, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelectorAll(selector) { return selector === '.opt' ? [choice] : []; } };
  app.node('#app').querySelectorAll = selector => selector === '.opts' ? [box] : [];
  app.location.hash = '#/session/chem/T3'; app.events.hashchange();
  box.listeners.click({ target: { closest: () => choice } });
  finishPut({ ok: true, json: async () => ({ savedAt: '2026-10-12T16:00:00Z' }) });
  await settle();
  assert.match(app.node('#syncStatus').textContent, /本機有新變更，等待自動同步/);
});

test('visible sync times and the review calendar use Beijing time across midnight', async () => {
  const savedAt = '2026-10-12T16:30:45.000Z'; // 2026-10-13 00:30:45 in Beijing
  const app = boot('', async (_, options) => ({
    ok: true,
    json: async () => options.method === 'GET' ? { data: null } : { savedAt }
  }), { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password',
    dse_quiz_sync_at_v1: savedAt }, false, true);
  app.location.hash = '#/records'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /2026\/10\/13 00:30:45（北京時間）/);
  app.node('#syncNowBtn').listeners.click();
  await settle();
  assert.match(app.node('#syncStatus').textContent, /2026\/10\/13 00:30:45（北京時間）/);

  const day = 864e5, offset = 8 * 3600e3;
  const today = Math.floor((Date.now() + offset) / day);
  const midnight = today * day - offset;
  const sessions = [midnight - 60000, midnight + 60000].map(t => ({
    t, subj: 'chem', topic: 'T3', results: { 'example-mc': { ok: true, marks: 1, tot: 1 } }
  }));
  const calendar = boot('', async () => { throw new Error('offline'); },
    { dse_quiz_sessions_v2: JSON.stringify(sessions) });
  calendar.location.hash = '#/records'; calendar.events.hashchange();
  assert.equal((calendar.node('#heat').innerHTML.match(/1 次練習/g) || []).length, 2);
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

test('a delayed successful read from an old session cannot merge or upload records', async () => {
  let finishOld, puts = 0;
  const app = boot('', (_, options) => {
    if (options.method === 'PUT') { puts++; return { ok: true, json: async () => ({}) }; }
    return new Promise(resolve => { finishOld = resolve; });
  }, { dse_quiz_sync_session_v1: 'old-session', dse_quiz_sessions_v2: '[]' });
  app.location.hash = '#/records'; app.events.hashchange();
  app.node('#syncNowBtn').listeners.click();
  app.saved.set('dse_quiz_sync_session_v1', 'new-session');
  finishOld({ ok: true, json: async () => ({ data: { app: 'kyle-dse-quiz',
    sessions: [{ t: 1, subj: 'bio', topic: 'I', results: {} }], archive: [], drafts: {}, reviewPlan: {} },
    sha: 'a'.repeat(40) }) });
  await settle();
  assert.equal(app.saved.get('dse_quiz_sync_session_v1'), 'new-session');
  assert.equal(app.saved.get('dse_quiz_sessions_v2'), '[]');
  assert.equal(puts, 0);
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
  assert.match(app.node('#syncStatus').textContent, /已上傳至雲端/);
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
  assert.match(app.node('#syncStatus').textContent, /已上傳至雲端/);
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
  const app = boot('', async () => ({ ok: false, status: 403, json: async () => ({ error: 'origin_denied' }) }), {
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

