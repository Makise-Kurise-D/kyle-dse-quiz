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
      get src() { return this._src; }, set src(value) { this._src = value; if (this.onload) this.onload(); },
      classList: { toggle() {}, add() {}, remove() {} },
      style: { setProperty() {} }, setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; },
      focus() { this.focused = true; },
      removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; },
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
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval(fn, delay) { intervals.push({ fn, delay }); }, clearInterval() {},
    confirm: () => true,
    scrollTo() {}, addEventListener(type, fn) { events[type] = fn; }, removeEventListener(type, fn) { if (events[type] === fn) delete events[type]; },
    QUIZ_SYNC_API: 'https://sync.example.workers.dev', QUIZ_PRIVATE_BANK: privateBank, QUIZ_PASSWORD_AUTH: passwordAuth,
    URL, Blob,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(data, context);
  vm.runInContext(readFileSync(new URL('./subject-config.js', import.meta.url), 'utf8'), context);
vm.runInContext(readFileSync(new URL('./library.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('./paper-reader.js', import.meta.url), 'utf8'), context);
  vm.runInContext(source, context);
  return { context, location, nodes, node, saved, timers, intervals, events };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function structuredQuestion(app) {
  const item = app.context.QUIZ_DATA.subjects.chem.items[0];
  delete item.img;
  Object.assign(item, { year: '2021', stemFull: '完整示例題幹\n第二行',
    options: ['第一項 <script>bad()</script>', '第二項', '第三項\n補充', '第四項'],
    figures: [{ path: 'images/chem-2021-fig-example.jpg', alt: '示例電路圖', width: 800, height: 400 }],
    tables: [{ caption: '示例數據', headers: ['時間', '讀數'], rows: [['0', '1 < 2']] }],
    correct: 'PRIVATE_CORRECT', deduct: 'PRIVATE_DEDUCTION', option: 'D' });
  return item;
}

test('structured MC content includes options, figures and tables in topic and random practice without revealing answers', () => {
  const app = boot(); structuredQuestion(app);
  for (const topic of ['T3', '__random__']) {
    app.location.hash = '#/session/chem/' + topic + '/2021'; app.events.hashchange();
    const html = app.node('#app').innerHTML;
    assert.match(html, /完整示例題幹<br>第二行/);
    assert.match(html, /<ol class="q-options" type="A"/);
    for (const text of ['第一項 &lt;script&gt;bad()&lt;\/script&gt;', '第二項', '第三項<br>補充', '第四項']) assert.ok(html.includes(text));
    assert.match(html, /src="images\/chem-2021-fig-example.jpg"/);
    assert.match(html, /alt="示例電路圖" width="800" height="400"/);
    assert.match(html, /<caption>示例數據<\/caption>/);
    assert.match(html, /<th scope="col">讀數<\/th>/);
    assert.match(html, /<td>1 &lt; 2<\/td>/);
    assert.equal((html.match(/class="opt(?: picked)?"/g) || []).length, 4);
    assert.doesNotMatch(html, /<script>|PRIVATE_CORRECT|PRIVATE_DEDUCTION/);
  }
});

test('subjective practice includes its supporting figures and tables before the answer box', () => {
  const app = boot(), item = structuredQuestion(app);
  item.kind = 'sub'; item.checks = ['示例給分點'];
  app.location.hash = '#/session/chem/T3/2021'; app.events.hashchange();
  const html = app.node('#app').innerHTML;
  assert.match(html, /src="images\/chem-2021-fig-example.jpg"/);
  assert.match(html, /<caption>示例數據<\/caption>/);
  assert.ok(html.indexOf('</figure>') < html.indexOf('<textarea'));
  assert.doesNotMatch(html, /class="q-options"/);
});

test('legacy MC keeps its complete original image and does not duplicate structured choices', () => {
  const app = boot(), item = structuredQuestion(app);
  item.img = 'images/chem-2021-mc-01.jpg';
  app.location.hash = '#/session/chem/T3/2021'; app.events.hashchange();
  const html = app.node('#app').innerHTML;
  assert.match(html, /src="images\/chem-2021-mc-01.jpg"/);
  assert.doesNotMatch(html, /class="q-options"|chem-2021-fig-example/);
});

test('structured private figures use the authenticated image loader and are released at logout', async () => {
  const calls = [], revoked = [];
  let finishBank;
  const app = boot('#/session/chem/T3/2021', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/bank')) return new Promise(resolve => { finishBank = resolve; });
    if (url.endsWith('/sync')) return { ok: true, json: async () => ({ data: null }) };
    return { ok: true, blob: async () => new Blob(['synthetic-figure']) };
  }, { dse_quiz_sync_session_v1: 'test-session' }, true);
  structuredQuestion(app);
  app.context.URL = { createObjectURL: () => 'blob:structured-figure', revokeObjectURL: url => revoked.push(url) };
  const img = { getAttribute: () => 'images/chem-2021-fig-example.jpg', src: '' };
  app.context.document.querySelectorAll = selector => selector === 'img[data-bank-image]' ? [img] : [];
  finishBank({ ok: true, json: async () => app.context.QUIZ_DATA });
  await settle(); await settle();
  app.location.hash = '#/session/chem/T3/2021'; app.events.hashchange();
  await settle();
  assert.match(app.node('#app').innerHTML, /data-bank-image="images\/chem-2021-fig-example.jpg"/);
  assert.doesNotMatch(app.node('#app').innerHTML, /src="images\/chem-2021-fig-example.jpg"/);
  const request = calls.find(call => call.url.endsWith('/bank/images/chem-2021-fig-example.jpg'));
  assert.equal(request.options.headers.Authorization, 'Bearer test-session');
  assert.equal(img.src, 'blob:structured-figure');
  app.saved.delete('dse_quiz_sync_session_v1');
  app.events.storage({ key: 'dse_quiz_sync_session_v1', newValue: null });
  assert.deepEqual(revoked, ['blob:structured-figure']);
});

test('replayed submissions seed one spaced-review attempt and confirmed AI records sync separately',async()=>{
  const past=Date.now()-20*864e5, exercise={t:past,subj:'chem',topic:'T3',results:{'example-mc':{ok:true,marks:1,tot:1}}};
  const app=boot('',async()=>({ok:true,json:async()=>({data:{app:'kyle-dse-quiz',sessions:[],archive:[exercise],drafts:{},reviewPlan:{},aiReviews:{remote:{questionId:'example-mc',confirmedAt:past,tags:['概念混淆']}}}})}),
    {dse_quiz_archive_v1:JSON.stringify([exercise,exercise]),dse_quiz_ai_reviews_v1:JSON.stringify({local:{questionId:'example-mc',confirmedAt:past+1,tags:['表達不完整']}}),dse_quiz_sync_session_v1:'s'.repeat(43)});
  assert.equal(JSON.parse(app.saved.get('dse_quiz_review_v1') || '{}')['example-mc']?.streak,undefined,'seeding does not itself write a new exercise');
  app.location.hash='#/records';app.events.hashchange();app.node('#syncNowBtn').listeners.click();await settle();await settle();
  const reviews=JSON.parse(app.saved.get('dse_quiz_ai_reviews_v1'));
  assert.equal(Object.keys(reviews).length,2);assert.equal(JSON.parse(app.saved.get('dse_quiz_review_v1'))['example-mc'].streak,1);
  assert.equal(app.node('#app').innerHTML.includes('未分類'),false);
});

test('navigation resets the content pane and returning to the library restores its reading position', () => {
  const app = boot();
  const pane = app.node('#contentScroll');
  pane.scrollTop = 620;
  app.location.hash = '#/records'; app.events.hashchange();
  assert.equal(pane.scrollTop, 0);
  pane.scrollTop = 410;
  app.location.hash = '#/library/books'; app.events.hashchange();
  pane.scrollTop = 230;
  app.location.hash = '#/'; app.events.hashchange();
  assert.equal(pane.scrollTop, 0);
  app.location.hash = '#/library/books'; app.events.hashchange();
  assert.equal(pane.scrollTop, 230, 'returning to the library restores the inner pane position');
});

test('archive backdrop reuses current home, has no duplicate IDs, and clears when leaving books', () => {
  const app = boot();
  app.location.hash = '#/library/books'; app.events.hashchange();
  const backdrop = app.node('#archiveBackdrop');
  assert.equal(backdrop.hidden, false);
  assert.match(backdrop.innerHTML, /開始練習/);
  assert.match(backdrop.innerHTML, /<b>1<\/b> 題在庫/);
  assert.doesNotMatch(backdrop.innerHTML, /\sid=|aria-live=|role="status"/);
  assert.doesNotMatch(app.node('#app').innerHTML, /archive-home-content/);
  app.location.hash = '#/library/papers'; app.events.hashchange();
  assert.equal(backdrop.hidden, true);
  assert.equal(backdrop.innerHTML, '');
});

test('private home backdrop is cleared when another tab removes the session', async () => {
  let finishBank;
  const app = boot('', async url => url.endsWith('/bank') ? new Promise(resolve => { finishBank = resolve; }) : { ok: true, json: async () => ({ data: null }) },
    { dse_quiz_sync_session_v1: 'p'.repeat(43), dse_quiz_auth_mode_v1: 'password' }, true, true);
  finishBank({ ok: true, json: async () => app.context.QUIZ_DATA });
  await settle();
  app.location.hash = '#/library/books'; app.events.hashchange();
  assert.equal(app.node('#archiveBackdrop').hidden, false);
  const saved = [...app.saved.entries()];
  assert.ok(saved.every(([, value]) => !value.includes('archive-home-content')));
  app.saved.delete('dse_quiz_sync_session_v1');
  app.events.storage({ key: 'dse_quiz_sync_session_v1' });
  assert.equal(app.node('#archiveBackdrop').hidden, true);
  assert.equal(app.node('#archiveBackdrop').innerHTML, '');
  assert.match(app.node('#app').innerHTML, /passwordLoginForm/);
});

function practiceFixture(app) {
  const subjects = app.context.QUIZ_DATA.subjects;
  subjects.chem.items[0].lost = 2;
  subjects.chem.topics.push({ code: 'T4', name: '另一個示例課題' });
  subjects.chem.items.push(
    { id: 'new-mc', kind: 'mc', topic: 'T3', year: '2023', paper: '卷一', qref: '示例 2', stem: '新年份選擇題', correctOpt: 'B', lost: 1 },
    { id: 'new-sub', kind: 'sub', topic: 'T3', year: '2023', paper: '卷一', qref: '示例 3', stem: '新年份主觀題', checks: ['示例給分點'], lost: 1 },
    { id: 'other-topic', kind: 'mc', topic: 'T4', year: '2023', paper: '卷一', qref: '示例 4', stem: '另一課題選擇題', correctOpt: 'C', lost: 1 }
  );
  subjects.bio.topics.push({ code: 'I', name: '生物示例課題' });
  subjects.bio.items.push({ id: 'bio-mc', kind: 'mc', topic: 'I', year: '2023', paper: '卷一', qref: '示例 5', stem: '生物選擇題', correctOpt: 'D', lost: 1 });
}

test('TOPICS filters years, subject switches, topic counts, information and random practice together', () => {
  const app = boot(); practiceFixture(app);
  app.location.hash = '#/practice/chem/2023'; app.events.hashchange();
  const html = app.node('#app').innerHTML;
  assert.match(html, /2023 年 · 化學 · 3 道錯題/);
  assert.match(html, /02 TOPICS/);
  assert.match(html, /href="#\/session\/chem\/T3\/2023"/);
  assert.match(html, /href="#\/session\/chem\/__random__\/2023"/);
  assert.match(html, /href="#\/practice\/bio\/2023"/);
  assert.match(app.node('#practiceYears').innerHTML, /data-practice-year="2023" aria-pressed="true"/);
  assert.match(app.node('#practiceTopicInfo').innerHTML, /2023 年 · 2 道錯題 · 2 題待複習 · 原卷失分 2 分/);
  app.node('#practiceYears').listeners.click({ target: { closest: () => ({ dataset: { practiceYear: '2022' } }) } });
  assert.equal(app.location.hash, '#/practice/chem/2022');
  app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /2022 年 · 化學 · 1 道錯題/);
  assert.doesNotMatch(app.node('#app').innerHTML, /另一個示例課題/);
  assert.match(app.node('#app').innerHTML, /href="#\/practice\/bio"/, 'a subject without the selected year falls back to all its available years');
  app.node('#practiceYears').listeners.click({ target: { closest: () => ({ dataset: { practiceYear: 'all' } }) } });
  app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /全部年份 · 化學 · 4 道錯題/);
  app.location.hash = '#/practice/bio/2023'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /生物示例課題/);
  assert.doesNotMatch(app.node('#practiceYears').innerHTML, /data-practice-year="2022"/);
});

test('year-scoped sessions and MC-only toggles exclude other years while unscoped links retain all questions', () => {
  const app = boot(); practiceFixture(app);
  app.location.hash = '#/session/chem/T3/2023'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /data-id="new-mc"/);
  assert.match(app.node('#app').innerHTML, /data-id="new-sub"/);
  assert.doesNotMatch(app.node('#app').innerHTML, /data-id="example-mc"|data-id="other-topic"/);
  assert.match(app.node('#app').innerHTML, /href="#\/practice\/chem\/2023"/);
  assert.equal(app.node('#totalCount').textContent, 2);
  app.node('#mcOnlyChk').listeners.change.call({ checked: true });
  assert.equal(app.node('#totalCount').textContent, 1);
  app.location.hash = '#/session/chem/T3'; app.events.hashchange();
  assert.equal(app.node('#totalCount').textContent, 3, 'existing topic links still include every year');
});

test('year-scoped random practice keeps its filter on reroll and on switching to MC only', () => {
  const app = boot(); practiceFixture(app);
  app.location.hash = '#/session/chem/__random__/2023'; app.events.hashchange();
  assert.equal(app.node('#totalCount').textContent, 3);
  assert.doesNotMatch(app.node('#app').innerHTML, /data-id="example-mc"/);
  app.node('#rerollBtn').listeners.click();
  assert.equal(app.node('#totalCount').textContent, 3);
  assert.doesNotMatch(app.node('#app').innerHTML, /data-id="example-mc"/);
  app.node('#mcOnlyChk').listeners.change.call({ checked: true });
  assert.equal(app.node('#totalCount').textContent, 2);
  assert.doesNotMatch(app.node('#app').innerHTML, /data-id="new-sub"|data-id="example-mc"/);
});

test('library year filters carry through both practice entrances and clearing them restores all-year practice', () => {
  const app = boot(); practiceFixture(app);
  app.location.hash = '#/library/books/chem/T3'; app.events.hashchange();
  app.node('#mlYear').value = '2023'; app.node('#mlYear').listeners.change();
  assert.equal(app.node('#mlPracticeLink').href, '#/session/chem/T3/2023');
  assert.match(app.node('#mlQuestions').innerHTML, /href="#\/session\/chem\/T3\/2023"/);
  assert.doesNotMatch(app.node('#mlQuestions').innerHTML, /id="question-example-mc"/);
  app.node('#mlYear').value = ''; app.node('#mlYear').listeners.change();
  assert.equal(app.node('#mlPracticeLink').href, '#/session/chem/T3');
});

test('saving a year-scoped exercise records only submitted questions and preserves other-year drafts', () => {
  const draft = { pick: { 'example-mc': 'A', 'new-mc': 'B' }, text: {}, paper: {}, changedAt: {} };
  const app = boot('', undefined, { dse_quiz_draft_v2: JSON.stringify({ 'chem:T3': draft }) });
  practiceFixture(app);
  app.node('#resultPanel').scrollIntoView = () => {};
  app.location.hash = '#/session/chem/T3/2022'; app.events.hashchange();
  app.node('#submitBtn').listeners.click();
  assert.match(app.node('#resultPanel').innerHTML, /href="#\/practice\/chem\/2022"/);
  app.node('#saveSessionBtn').listeners.click();
  const sessions = JSON.parse(app.saved.get('dse_quiz_sessions_v2'));
  assert.deepEqual(Object.keys(sessions.at(-1).results), ['example-mc']);
  const remaining = JSON.parse(app.saved.get('dse_quiz_draft_v2'))['chem:T3'];
  assert.equal(remaining.pick['new-mc'], 'B');
  assert.equal(remaining.pick['example-mc'], '');
  assert.match(app.node('#resultPanel').innerHTML, /href="#\/practice\/chem\/2022"/);
});

test('late grade requests cannot overwrite a different subject and missing grades stay unknown', async () => {
  let finish;
  const app = boot('', async () => new Promise(resolve => { finish = resolve; }), { dse_quiz_sync_session_v1: 'test-session' });
  practiceFixture(app);
  app.location.hash = '#/practice/chem/2022'; app.events.hashchange();
  const resolveOld = finish;
  app.location.hash = '#/practice/bio/2023'; app.events.hashchange();
  const catalog = { subjects: { chem: ['2022'], bio: ['2023'] }, papers: { chem: { '2022': { assessment: { earned: 75, total: 100 } } } } };
  finish({ ok: true, json: async () => catalog }); await settle();
  resolveOld({ ok: true, json: async () => catalog }); await settle();
  assert.match(app.node('#practiceYears').innerHTML, /2023 生物/);
  assert.doesNotMatch(app.node('#practiceYears').innerHTML, /2022 化學|75/);
  app.location.hash = '#/practice/chem/2022'; app.events.hashchange(); await settle();
  assert.match(app.node('#practiceYears').innerHTML, /HP<\/abbr> <b>75<small>\/100/);
  assert.match(app.node('#practiceYears').innerHTML, /LV<\/abbr> <b>—/);
});

test('practice and mistake-library LV share paper DSE boundaries, not review progress or a raw level field', async () => {
  const catalog = { subjects: { chem: ['2023', '2022'], bio: ['2023'], math: ['2023'] }, papers: {
    chem: {
      '2023': { assessment: { earned: 65, total: 100, scope: '兩卷示例', boundaries: [
        { level: '3', minimumPercent: 50 }, { level: '4', minimumPercent: 65 }, { level: '5', minimumPercent: 80 }
      ] } },
      '2022': { assessment: { earned: 49, total: 100, scope: '缺少較低分界', boundaries: [
        { level: '3', minimumPercent: 50 }
      ] } }
    },
    bio: { '2023': { assessment: { earned: 31, total: 40, scope: '兩卷示例', boundaries: [
      { level: '5', minimumPercent: 67 }, { level: '5*', minimumPercent: 77 }, { level: '5**', minimumPercent: 83 }
    ] } } },
    math: { '2023': { assessment: { earned: 90, total: 100, scope: '僅卷一，未評全科', level: '5**', boundaries: [] } } }
  } };
  const app = boot('', async () => ({ ok: true, json: async () => catalog }),
    { dse_quiz_sync_session_v1: 'test-session' });
  practiceFixture(app);
  app.context.QUIZ_DATA.subjects.math = { name: '數學', topics: [{ code: 'M1', name: '示例單元' }], items: [
    { id: 'math-example', kind: 'sub', topic: 'M1', year: '2023', qref: '示例 6', stem: '數學示例', checks: ['示例給分點'] }
  ] };
  for (const [subject, level, scope] of [['chem', '4', '兩卷示例'], ['bio', '5*', '兩卷示例'], ['math', '—', '僅卷一，未評全科']]) {
    for (const [route, selector, status] of [
      ['#/practice/', '#practiceYears', '#practiceGradeStatus'], ['#/library/books/', '#mlYears', '#mlGradeStatus']
    ]) {
      app.location.hash = route + subject; app.events.hashchange(); await settle();
      const html = app.node(selector).innerHTML;
      assert.ok(html.includes('title="DSE 試卷等級">LV</abbr> <b>' + level + '</b>'), route + subject);
      assert.ok(html.includes(scope));
      assert.ok(html.includes(subject === 'math' ? '等級未評' : '等級估算'));
      assert.match(app.node(status).textContent, /DSE 參考分界/);
      assert.match(app.node('#app').innerHTML, /非官方估算/);
      if (subject === 'chem') assert.match(html, /LV<\/abbr> <b>—/, 'an incomplete boundary table never invents a lower grade');
      if (subject === 'math') {
        assert.doesNotMatch(html, /<b>5\*\*/);
        assert.match(html, /HP<\/abbr> <b>90/);
      }
    }
  }
});

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
  assert.match(app.node('#mlYearSummary').innerHTML, /100/);
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
  assert.equal(app.node('#paperImage-1').src, 'blob:paper-1');
  assert.equal(app.node('#paperReader').hidden, false);
  assert.equal(app.node('#paperOpen').href, 'blob:paper-1');
  app.node('#paperNext').listeners.click();
  await settle();
  assert.equal(app.node('#paperImage-2').src, 'blob:paper-2');
  assert.equal(app.node('#paperImage-1').src, 'blob:paper-1', 'previous pages stay visible in the continuous stream');
  assert.equal(calls.at(-1).url, 'https://sync.example.workers.dev/papers/chem/2024/pages/cccccccccccccccc/2');
  assert.deepEqual(revoked, [], 'jumping does not revoke the previous visible page');
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
  assert.equal(app.node('#paperImage-2').src, 'blob:paper-cache-2');
  assert.equal(app.node('#paperImage-1').hidden, false);
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
  assert.equal(app.node('#paperImage-1').src, 'blob:graded-1');
  version = 'e'.repeat(16);
  app.node('#paperReload').listeners.click();
  await settle();
  assert.deepEqual(revoked, ['blob:graded-1']);
  assert.equal(app.node('#paperImage-1').src, 'blob:graded-2');
  assert.equal(urls.at(-1), 'https://sync.example.workers.dev/papers/chem/2022/pages/eeeeeeeeeeeeeeee/1');
});

test('unpublished graded papers show an explanation and no image', async () => {
  const app = boot('', async () => ({ ok: false, status: 404,
    json: async () => ({ error: 'paper_not_accessible' }) }),
  { dse_quiz_sync_session_v1: 'valid-session' });
  app.location.hash = '#/library/papers/bio/2022'; app.events.hashchange();
  await settle();
  assert.match(app.node('#paperStatus').textContent, /暫未發布/);
  assert.equal(app.node('#paperReader').hidden, true);
});

test('continuous reader bounds pending requests, skips abandoned pages and releases late private responses', async () => {
  const pending = [], revoked = [];
  const app = boot('', async (url, options) => {
    if (url.includes('/manifest')) return { ok: true, json: async () => ({ version: 'a'.repeat(16), pages: 40 }) };
    return new Promise(resolve => pending.push({ url, options, resolve }));
  }, { dse_quiz_sync_session_v1: 'valid-session' });
  let serial = 0;
  app.context.URL = { createObjectURL: () => 'blob:bounded-' + (++serial), revokeObjectURL: url => revoked.push(url) };
  app.location.hash = '#/library/papers/chem/2022'; app.events.hashchange(); await settle();
  app.timers.find(timer => timer.delay === 200).fn();
  assert.equal(pending.length, 2);
  app.node('#paperPageSelect').listeners.change({ target: { value: '40' } });
  assert.equal(pending.length, 2, 'no unbounded requests while both slots are occupied');
  assert.ok(pending.every(r => r.options.signal.aborted), 'distant requests are cancelled for a jump');
  pending[0].resolve({ ok: true, blob: async () => new Blob(['old']) }); await settle();
  assert.ok(pending[2].url.endsWith('/40'), 'the jump target takes the first freed slot');
  assert.equal(serial, 0, 'an abandoned page is never attached');
  app.location.hash = '#/records'; app.events.hashchange();
  for (const p of pending) p.resolve({ ok: true, blob: async () => new Blob(['late']) });
  await settle();
  assert.equal(serial, 0, 'late responses cannot attach private images on another route');
  assert.deepEqual(revoked, []);
});

test('failed continuous pages retry locally without clearing readable neighbours or exercise records', async () => {
  let attempts = 0;
  const app = boot('', async url => {
    if (url.includes('/manifest')) return { ok: true, json: async () => ({ version: 'a'.repeat(16), pages: 2 }) };
    if (url.endsWith('/2') && ++attempts === 1) return { ok: false, status: 503, json: async () => ({ error: 'paper_unavailable' }) };
    return { ok: true, blob: async () => new Blob(['page']) };
  }, { dse_quiz_sync_session_v1: 'valid-session' });
  let serial = 0;
  app.context.URL = { createObjectURL: () => 'blob:retry-' + (++serial), revokeObjectURL() {} };
  app.location.hash = '#/library/papers/chem/2022'; app.events.hashchange(); await settle();
  app.node('#paperNext').listeners.click(); await settle();
  assert.equal(app.node('#paperRetry-2').hidden, false);
  assert.equal(app.node('#paperImage-1').src, 'blob:retry-1');
  app.node('#paperRetry-2').listeners.click(); await settle();
  assert.equal(app.node('#paperImage-2').src, 'blob:retry-2');
  assert.equal(app.node('#paperRetry-2').hidden, true);
  assert.ok(!app.saved.has('dse_quiz_sessions_v2'));
});

test('a page cancelled by a distant jump loads normally when revisited', async () => {
  let secondPageCalls = 0;
  const app = boot('', async (url, options) => {
    if (url.includes('/manifest')) return { ok: true, json: async () => ({ version: 'a'.repeat(16), pages: 40 }) };
    if (url.endsWith('/2') && ++secondPageCalls === 1) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
    });
    return { ok: true, blob: async () => new Blob(['page']) };
  }, { dse_quiz_sync_session_v1: 'valid-session' });
  app.context.URL = { createObjectURL: () => 'blob:revisited', revokeObjectURL() {} };
  app.location.hash = '#/library/papers/chem/2022'; app.events.hashchange(); await settle();
  app.timers.find(timer => timer.delay === 200).fn();
  app.node('#paperPageSelect').listeners.change({ target: { value: '40' } }); await settle();
  app.node('#paperPageSelect').listeners.change({ target: { value: '2' } }); await settle();
  assert.equal(secondPageCalls, 2);
  assert.equal(app.node('#paperImage-2').src, 'blob:revisited');
  assert.equal(app.node('#paperRetry-2').hidden, true);
});

test('reading tools open on demand and restoring the site header neither reloads nor loses the current page', async () => {
  const calls = [];
  const app = boot('', async url => {
    calls.push(url);
    if (url.includes('/manifest')) return { ok: true, json: async () => ({ version: 'a'.repeat(16), pages: 2 }) };
    return { ok: true, blob: async () => new Blob(['page']) };
  }, { dse_quiz_sync_session_v1: 'valid-session' });
  app.context.URL = { createObjectURL: () => 'blob:focus', revokeObjectURL() {} };
  app.location.hash = '#/library/papers/chem/2022'; app.events.hashchange(); await settle();
  assert.equal(app.node('#paperTools').hidden, true);
  app.node('#paperToolsToggle').listeners.click();
  assert.equal(app.node('#paperTools').hidden, false);
  assert.equal(app.node('#paperToolsToggle')['aria-expanded'], 'true');
  const count = calls.length;
  app.node('#paperHeaderToggle').listeners.click();
  assert.equal(app.node('#paperHeaderToggle')['aria-pressed'], 'true');
  assert.equal(app.node('#paperTools').hidden, true);
  assert.equal(app.node('#paperToolsToggle').focused, true);
  assert.equal(app.node('#paperPageSelect').value, '1');
  assert.equal(calls.length, count);
  app.node('#paperToolsToggle').listeners.click(); app.node('#paperHeaderToggle').listeners.click();
  assert.equal(app.node('#paperHeaderToggle')['aria-pressed'], 'false');
  assert.equal(calls.length, count);
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
  assert.match(app.node('#app').innerHTML, /本輪已全對<strong class="c-green">0<small>/);
  finishSync({ ok: true, json: async () => ({ data: remote }) });
  await settle();
  assert.match(app.node('#app').innerHTML, /本輪已全對<strong class="c-green">1<small>/);
  assert.match(app.node('#app').innerHTML, /本輪待複習<strong class="c-red">0<small>/);
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

test('sync deadlines cover slow headers and bodies for both reads and writes, then recover automatically', async () => {
  for (const method of ['GET', 'PUT']) for (const phase of ['headers', 'body']) {
    const calls = [];
    let failed = false;
    const records = JSON.stringify([{ t: Date.now(), subj: 'chem', topic: 'T3', results: {} }]);
    const app = boot('', async (url, options) => {
      calls.push(options.method);
      if (!failed && options.method === method) {
        failed = true;
        const stall = () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        return phase === 'headers' ? stall() : { ok: true, json: stall };
      }
      return { ok: true, json: async () => options.method === 'GET' ? { data: null } : { ok: true } };
    }, { dse_quiz_sync_session_v1: 'valid-session', dse_quiz_auth_mode_v1: 'password', dse_quiz_sessions_v2: records }, false, true);
    app.location.hash = '#/records'; app.events.hashchange();
    app.node('#syncNowBtn').listeners.click(); await settle();
    const deadline = app.timers.find(timer => timer.delay === 60000 && !timer.cleared);
    assert.ok(deadline, `${method} ${phase} retains its deadline until the body is read`);
    assert.equal(app.timers.some(timer => timer.delay === 15000), false, 'sync allows upstream refresh and conflict resolution beyond 15 seconds');
    deadline.fn(); await settle();
    assert.match(app.node('#syncStatus').textContent, /正在自動重試/);
    assert.equal(app.saved.has('dse_quiz_sync_at_v1'), false);
    assert.equal(app.saved.get('dse_quiz_sessions_v2'), records);
    app.events.focus(); await settle();
    assert.deepEqual(calls, method === 'GET' ? ['GET'] : ['GET', 'PUT'], 'concurrent triggers share the retry');
    app.timers.find(timer => timer.delay === 1000).fn(); await settle();
    assert.deepEqual(calls.slice(-2), ['GET', 'PUT']);
    assert.match(app.node('#syncStatus').textContent, /已上傳至雲端/);
    assert.equal(app.saved.get('dse_quiz_sync_session_v1'), 'valid-session');
    assert.ok(app.saved.has('dse_quiz_sync_at_v1'));
  }
});

test('a lost upload response rechecks the cloud without duplicating an already saved exercise', async () => {
  let remote = null, puts = 0;
  const records = JSON.stringify([{ t: Date.now(), subj: 'chem', topic: 'T3', results: {} }]);
  const app = boot('', async (_, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ data: remote, sha: 'a'.repeat(40) }) };
    puts++; remote = JSON.parse(options.body).data;
    return { ok: true, json: async () => { throw new TypeError('Response stream disconnected after commit'); } };
  }, { dse_quiz_sync_session_v1: 'valid-session', dse_quiz_auth_mode_v1: 'password', dse_quiz_sessions_v2: records }, false, true);
  app.location.hash = '#/records'; app.events.hashchange();
  app.node('#syncNowBtn').listeners.click(); await settle();
  assert.equal(app.saved.has('dse_quiz_sync_at_v1'), false, 'a lost acknowledgement cannot report upload success');
  app.timers.find(timer => timer.delay === 1000).fn(); await settle();
  assert.equal(puts, 1);
  assert.equal(remote.sessions.length, 1);
  assert.equal(app.saved.get('dse_quiz_sessions_v2'), records);
  assert.match(app.node('#syncStatus').textContent, /雲端已核對/);
});

test('retrying a failed write re-reads the cloud version and includes new local and remote answers', async () => {
  const cycle = boot().saved.get('dse_quiz_cycle_v1');
  const local = { pick: { a: 'A' }, text: {}, paper: {}, changedAt: { 'pick:a': 110 }, deletedAt: 0 };
  const remote = { app: 'kyle-dse-quiz', sessions: [], archive: [], drafts: {}, reviewPlan: {}, cycle };
  const uploads = [];
  let gets = 0;
  const app = boot('', async (_, options) => {
    if (options.method === 'GET') {
      gets++;
      if (gets > 1) remote.drafts['chem:T3'] = { ...local, pick: { b: 'B' }, changedAt: { 'pick:b': 120 } };
      return { ok: true, json: async () => ({ data: remote, sha: (gets === 1 ? 'a' : 'b').repeat(40) }) };
    }
    uploads.push(JSON.parse(options.body));
    return uploads.length === 1 ? { ok: false, status: 409, json: async () => ({ error: 'conflict' }) }
      : { ok: true, json: async () => ({ ok: true }) };
  }, { dse_quiz_sync_session_v1: 'valid-session', dse_quiz_auth_mode_v1: 'password', dse_quiz_cycle_v1: cycle,
    dse_quiz_draft_v2: JSON.stringify({ 'chem:T3': local }) }, false, true);
  app.location.hash = '#/records'; app.events.hashchange();
  app.node('#syncNowBtn').listeners.click(); await settle();
  const choice = { dataset: { l: 'C' }, classList: { toggle() {} }, setAttribute() {} };
  const box = { dataset: { id: 'example-mc' }, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelectorAll: () => [choice] };
  app.node('#app').querySelectorAll = selector => selector === '.opts' ? [box] : [];
  app.location.hash = '#/session/chem/T3'; app.events.hashchange();
  box.listeners.click({ target: { closest: () => choice } });
  app.timers.find(timer => timer.delay === 1000).fn(); await settle();
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].sha, 'b'.repeat(40), 'retry uses the latest cloud version');
  assert.deepEqual(uploads[1].data.drafts['chem:T3'].pick, { a: 'A', b: 'B', 'example-mc': 'C' });
  assert.match(app.node('#syncStatus').textContent, /已上傳至雲端/);
});

test('temporary network and HTTP failures have bounded retries and later recover on the minute poll', async () => {
  for (const failure of ['network', 408, 429, 500, 502, 503, 504]) {
    let calls = 0;
    const app = boot('', async (_, options) => {
      if (++calls <= 3) {
        if (failure === 'network') throw new TypeError('Failed to fetch');
        return { ok: false, status: failure, json: async () => ({ error: 'storage_unavailable' }) };
      }
      return { ok: true, json: async () => options.method === 'GET' ? { data: null } : { ok: true } };
    }, { dse_quiz_sync_session_v1: 'valid-session', dse_quiz_auth_mode_v1: 'password' }, false, true);
    app.location.hash = '#/records'; app.events.hashchange();
    app.node('#syncNowBtn').listeners.click(); await settle();
    app.timers.find(timer => timer.delay === 1000).fn(); await settle();
    app.timers.find(timer => timer.delay === 3000).fn(); await settle();
    assert.equal(calls, 3);
    assert.match(app.node('#syncStatus').textContent, /稍後會自動重試；本機記錄已保留/);
    assert.equal(app.saved.has('dse_quiz_sync_at_v1'), false);
    assert.equal(app.saved.get('dse_quiz_sync_session_v1'), 'valid-session');
    app.intervals.find(timer => timer.delay === 60000).fn(); await settle();
    assert.equal(calls, 5);
    assert.match(app.node('#syncStatus').textContent, /已上傳至雲端/);
  }
});

test('sync never retries permanent failures or writes over an invalid successful read', async () => {
  for (const kind of [401, 403, 404, 'service_not_configured', 'owner_connection_required', 'html', 'empty', 'wrong-app']) {
    const calls = [];
    const records = JSON.stringify([{ t: Date.now(), subj: 'chem', topic: 'T3', results: {} }]);
    const app = boot('', async (_, options) => {
      calls.push(options.method);
      if (typeof kind === 'number') return { ok: false, status: kind, json: async () => ({ error: 'denied' }) };
      if (kind.endsWith('required') || kind.endsWith('configured')) return { ok: false, status: 503, json: async () => ({ error: kind }) };
      return { ok: true, json: async () => {
        if (kind === 'html') throw new SyntaxError('Unexpected HTML');
        return kind === 'empty' ? {} : { data: { app: 'wrong-app' } };
      } };
    }, { dse_quiz_sync_session_v1: 'valid-session', dse_quiz_auth_mode_v1: 'password', dse_quiz_sessions_v2: records }, false, true);
    app.location.hash = '#/records'; app.events.hashchange();
    app.node('#syncNowBtn').listeners.click(); await settle();
    assert.deepEqual(calls, ['GET']);
    assert.equal(app.timers.some(timer => timer.delay === 1000 || timer.delay === 3000), false);
    assert.equal(app.saved.has('dse_quiz_sync_at_v1'), false);
    assert.equal(app.saved.get('dse_quiz_sessions_v2'), records);
    assert.match(app.node('#syncStatus').textContent, /同步失敗/);
  }
});

test('logout or session replacement cancels queued sync retries before any further request', async () => {
  for (const next of [null, 'new-session']) {
    const calls = [];
    const app = boot('', async (_, options) => {
      calls.push(options.headers.Authorization);
      throw new TypeError('Failed to fetch');
    }, { dse_quiz_sync_session_v1: 'old-session', dse_quiz_auth_mode_v1: 'password' }, false, true);
    app.location.hash = '#/records'; app.events.hashchange();
    app.node('#syncNowBtn').listeners.click(); await settle();
    if (next) app.saved.set('dse_quiz_sync_session_v1', next);
    else app.saved.delete('dse_quiz_sync_session_v1');
    app.timers.find(timer => timer.delay === 1000).fn(); await settle();
    assert.deepEqual(calls, ['Bearer old-session']);
    assert.equal(app.saved.get('dse_quiz_sync_session_v1'), next || undefined);
    assert.equal(app.saved.has('dse_quiz_sync_at_v1'), false);
  }
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
  const choice = { dataset: { l: 'A' }, classList: { toggle() {} }, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } };
  const box = { dataset: { id: 'example-mc' }, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelectorAll(selector) { return selector === '.opt' ? [choice] : []; } };
  app.node('#app').querySelectorAll = selector => selector === '.opts' ? [box] : [];
  app.location.hash = '#/session/chem/T3'; app.events.hashchange();
  box.listeners.click({ target: { closest: () => choice } });
  assert.equal(choice.attrs['aria-pressed'], 'true', 'selected answer is announced without relying on colour');
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
  assert.equal((calendar.node('#heat').innerHTML.match(/data-tip="[^"]*1 次練習/g) || []).length, 2);
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



function mathFixture(app) {
  app.context.QUIZ_DATA.subjects.math = { name: '數學', topics: [{ code: 'U8', name: '示例數學課題' }], items: [
    { id: 'math-example-a', kind: 'sub', topic: 'U8', year: '2022', paper: '卷一', qref: '示例甲', stem: '簡題', stemFull: '完整數學示例題\n第二行條件', marks: 1, lost: 1, checks: ['完整給分點'] },
    { id: 'math-example-b', kind: 'sub', topic: 'U8', year: '2022', paper: '卷一', qref: '示例乙', stem: '另一示例題', marks: 2, lost: 1, checks: ['給分點一', '給分點二'] }
  ] };
}

test('mathematics is selectable in the library, practice and random picker without duplicating its card', () => {
  const app = boot(); mathFixture(app);
  app.location.hash = '#/library/books'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /href="#\/library\/books\/math"/);
  assert.doesNotMatch(app.node('#app').innerHTML, /尚未收錄|準備中/);
  app.location.hash = '#/library/books/math'; app.events.hashchange();
  assert.match(app.node('#mlYearSummary').innerHTML, /2 分原卷失分/);
  assert.match(app.node('#app').innerHTML, /上一個學科：化學/);
  assert.match(app.node('#app').innerHTML, /下一個學科：生物/);
  app.location.hash = '#/practice/math/2022'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /2022 年 · 數學 · 2 道錯題/);
  assert.match(app.node('#app').innerHTML, /href="#\/practice\/bio"[^>]*上一個學科/);
  assert.match(app.node('#app').innerHTML, /href="#\/practice\/chem\/2022"[^>]*下一個學科/);
  app.location.hash = '#/random'; app.events.hashchange();
  assert.equal((app.node('#app').innerHTML.match(/href="#\/session\/math\/__random__"/g) || []).length, 1);
  assert.match(app.node('#app').innerHTML, /2 題錯題中隨機抽 2 題/);
  app.location.hash = '#/session/math/__random__'; app.events.hashchange();
  assert.equal(app.node('#totalCount').textContent, 2);
  assert.match(app.node('#app').innerHTML, /完整數學示例題<br>第二行條件/);
  assert.match(app.node('#app').innerHTML, /大題 1 分/);
  assert.match(app.node('#app').innerHTML, /id="mcOnlyChk"[^>]*disabled/);
});

test('saving mathematics marks preserves existing chemistry sessions and other subject drafts', () => {
  const cycle = boot().saved.get('dse_quiz_cycle_v1');
  const prior = { t: Date.now() - 1000, subj: 'chem', topic: 'T3', results: { 'example-mc': { ok: true, marks: 1, tot: 1 } } };
  const draft = { pick: {}, text: {}, paper: { 'math-example-a': true, 'math-example-b': true }, changedAt: {} };
  const app = boot('', undefined, { dse_quiz_sessions_v2: JSON.stringify([prior]), dse_quiz_cycle_v1: cycle,
    dse_quiz_draft_v2: JSON.stringify({ 'math:U8': draft, 'chem:T3': { pick: { 'example-mc': 'B' } } }) });
  mathFixture(app);
  app.node('#resultPanel').scrollIntoView = () => {};
  app.location.hash = '#/session/math/U8/2022'; app.events.hashchange();
  app.node('#submitBtn').listeners.click();
  assert.match(app.node('#resultPanel').innerHTML, /待核對 \/ 3/);
  const a = app.node('.chk-form[data-id="math-example-a"]');
  const b = app.node('.chk-form[data-id="math-example-b"]');
  a.dataset = { wtot: '1' }; b.dataset = { wtot: '2' };
  a.querySelectorAll = () => [{ dataset: { w: '1' } }];
  b.querySelectorAll = () => [{ dataset: { w: '1' } }];
  app.node('#saveSessionBtn').listeners.click();
  const saved = JSON.parse(app.saved.get('dse_quiz_sessions_v2'));
  assert.deepEqual(saved[0], prior);
  assert.equal(saved.at(-1).subj, 'math');
  assert.deepEqual(saved.at(-1).results['math-example-a'], { kind: 'sub', marks: 1, tot: 1, ok: true, got: 1, checks: 1 });
  assert.equal(saved.at(-1).results['math-example-b'].ok, false);
  assert.equal(saved.at(-1).sub, '2/3');
  assert.equal(JSON.parse(app.saved.get('dse_quiz_draft_v2'))['chem:T3'].pick['example-mc'], 'B');
  app.location.hash = '#/records'; app.events.hashchange();
  assert.match(app.node('#app').innerHTML, /數學/);
});

test('Yeelam loads only account-scoped browser records and never uploads Kyle records', async () => {
  const owner = [{ t: 1791510000000, subj: 'chem', topic: 'T3', results: { 'owner-only': { ok: true } } }];
  let uploaded;
  const app = boot('#/records', async (url, options) => {
    if (options.method === 'PUT') uploaded = JSON.parse(options.body).data;
    return { ok: true, json: async () => options.method === 'GET' ? { data: null } : { savedAt: '2026-10-22T00:00:00Z' } };
  }, {
    dse_quiz_user_v1: 'yeelam', dse_quiz_sessions_v2: JSON.stringify(owner),
    dse_quiz_draft_v2: JSON.stringify({ 'owner-private': {} }),
    dse_quiz_ai_reviews_v1: JSON.stringify({ 'owner-ai': {} }),
    dse_quiz_sync_session_v1: 'synthetic-guest-session', dse_quiz_auth_mode_v1: 'password'
  }, false, true);
  app.timers.filter(timer => timer.delay === 0 && !timer.cleared).forEach(timer => timer.fn());
  await settle();
  assert.ok(uploaded);
  assert.deepEqual(uploaded.sessions, []);
  assert.deepEqual(uploaded.drafts, {});
  assert.deepEqual(uploaded.aiReviews, {});
  assert.equal(app.saved.get('dse_quiz_sessions_v2'), JSON.stringify(owner));
  assert.doesNotMatch(app.node('#app').innerHTML, /owner-only|owner-private|owner-ai/);
  let reloaded = false;
  app.location.reload = () => { reloaded = true; };
  app.saved.set('dse_quiz_user_v1', 'kyle');
  app.events.storage({ key: 'dse_quiz_user_v1' });
  assert.equal(reloaded, true, 'other tabs discard old in-memory account state');
});

test('switching from Kyle to Yeelam reloads before any old records can sync', async () => {
  const owner = [{ t: Date.now(), subj: 'chem', results: { 'owner-only': { ok: true } } }];
  const calls = [];
  const app = boot('', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ sessionId: 'Y'.repeat(48), userId: 'yeelam' }) };
  }, { dse_quiz_sessions_v2: JSON.stringify(owner) }, true, true);
  let reloaded = false;
  app.location.reload = () => { reloaded = true; };
  app.node('#syncUsername').value = 'Yeelam';
  app.node('#syncPassword').value = 'synthetic-guest-password';
  app.node('#passwordLoginForm').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(reloaded, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.username, 'Yeelam');
  assert.equal(app.saved.get('dse_quiz_user_v1'), 'yeelam');
  assert.equal(app.saved.get('dse_quiz_sessions_v2'), JSON.stringify(owner));
  assert.ok(![...app.saved.values()].some(v => String(v).includes('synthetic-guest-password')));
});

test('Yeelam subject entrances use math, M2 and physics while Kyle keeps all original subjects', async () => {
  const guest = boot('', undefined, { dse_quiz_user_v1: 'yeelam' });
  const source = guest.context.QUIZ_DATA.subjects;
  assert.deepEqual(Object.keys(source), ['math', 'm2', 'physics']);
  source.math.items.push({ id:'guest-math',kind:'sub',topic:'U1',year:'2024',stem:'數學示例',checks:['步驟'],correct:'示例解答' });
  source.math.topics.push({ code:'U1',name:'數學課題' });
  ['m2','physics'].forEach(code => {
    source[code].topics.push({code:'U1',name:code+' 課題'});
    source[code].items.push({id:code+'-synthetic',kind:'sub',topic:'U1',year:'2024',stem:'完整'+code+' 題幹',checks:['說明'],correct:'示例解答',figures:[{path:'images/'+code+'-2024-fig-synthetic.jpg',alt:'合成圖表'}]});
  });
  for (const hash of ['#/','#/random','#/library/books','#/library/papers','#/today','#/records']) {
    guest.location.hash = hash; guest.events.hashchange();
    const html = guest.node('#app').innerHTML;
    assert.match(html,/數學/); assert.match(html,/M2/); assert.match(html,/物理/);
    assert.doesNotMatch(html,/化學|生物|href="#\/(?:session|practice)\/(?:chem|bio)/);
  }
  guest.location.hash = '#/library/books/m2'; guest.events.hashchange();
  assert.match(guest.node('#app').innerHTML,/數學延伸 2（M2）/);
  assert.match(guest.node('#app').innerHTML, /下一個學科：物理/);
  for (const code of ['math','m2','physics']) {
    guest.location.hash = '#/practice/'+code; guest.events.hashchange();
    assert.match(guest.node('#app').innerHTML,/1 道錯題/);
    guest.location.hash = '#/session/'+code+'/U1/2024'; guest.events.hashchange();
    assert.equal(guest.node('#totalCount').textContent,1);
  }
  guest.location.hash = '#/practice/chem'; guest.events.hashchange();
  assert.doesNotMatch(guest.node('#app').innerHTML,/化學|生物/);
  const owner = boot('#/library/books');
  assert.match(owner.node('#app').innerHTML,/化學/); assert.match(owner.node('#app').innerHTML,/生物/);
  assert.match(owner.node('#app').innerHTML,/數學/); assert.doesNotMatch(owner.node('#app').innerHTML,/M2|物理/);
});

test('one-mark subjective answers use one field without practice AI or prefilled solutions', () => {
  const app=boot(),item=structuredQuestion(app);
  item.kind='sub';item.marks=1;item.checks=['PRIVATE_CHECK','PRIVATE_ALTERNATIVE','✗ PRIVATE_WARNING'];item.correct='PRIVATE_CORRECT';
  app.location.hash='#/session/chem/T3/2021';app.events.hashchange();
  const html=app.node('#app').innerHTML;
  assert.match(html,/data-answer-mode="steps" aria-pressed="true"/);
  assert.equal((html.match(/class="step-input"/g)||[]).length,1);
  assert.doesNotMatch(html,/data-ai-mode|ai-panel|AI 幫我拆題|方向提示|step-add|formula-pad|data-formula/);
  assert.doesNotMatch(html,/PRIVATE_CHECK|PRIVATE_CORRECT|PRIVATE_DEDUCTION/);
  assert.match(html,/<label class="answer-free" hidden>/);
});

test('legacy free-text drafts remain visible and are not converted on opening a question', () => {
  const draft={pick:{},text:{'example-mc':'保留原來的完整答案'},paper:{}};
  const app=boot('',undefined,{dse_quiz_draft_v2:JSON.stringify({'chem:T3':draft})}),item=structuredQuestion(app);
  item.kind='sub';item.checks=['給分點'];
  app.location.hash='#/session/chem/T3/2021';app.events.hashchange();
  const html=app.node('#app').innerHTML;
  assert.match(html,/data-answer-mode="text" aria-pressed="true"/);
  assert.match(html,/>保留原來的完整答案<\/textarea>/);
  assert.equal(JSON.parse(app.saved.get('dse_quiz_draft_v2'))['chem:T3'].text['example-mc'],'保留原來的完整答案');
});

test('personalized fields follow the question rather than the number of checks and escape field labels', () => {
  const app=boot(),item=structuredQuestion(app);
  item.kind='sub';item.marks=2;item.checks=['PRIVATE_POINT_ONE','PRIVATE_POINT_TWO','✗ PRIVATE_WARNING'];
  item.answerFields=['試劑名稱','預期觀察 <script>unsafe()</script>'];
  app.location.hash='#/session/chem/T3/2021';app.events.hashchange();
  const html=app.node('#app').innerHTML;
  assert.equal((html.match(/class="step-input"/g)||[]).length,2);
  assert.match(html,/試劑名稱/);assert.match(html,/預期觀察 &lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/PRIVATE_POINT|PRIVATE_WARNING|data-ai-mode|ai-panel|<script>unsafe/);
});

test('old three-step drafts migrate into the new one-mark field without dropping any answer text', () => {
  const original='1. 舊思路\n2. 舊計算\n3. 舊結論';
  const draft={pick:{},text:{'example-mc':original},paper:{},steps:{'example-mc':{mode:'steps',assisted:true,rows:[{prompt:'OLD_AI_PROMPT',answer:'舊思路'},{prompt:'OLD_FORMULA_PROMPT',answer:'舊計算'},{prompt:'OLD_FINAL_PROMPT',answer:'舊結論'}]}}};
  const app=boot('',undefined,{dse_quiz_draft_v2:JSON.stringify({'chem:T3':draft})}),item=structuredQuestion(app);
  item.kind='sub';item.marks=1;item.answerFields=['本題結論'];item.checks=['核對點'];
  app.location.hash='#/session/chem/T3/2021';app.events.hashchange();
  const html=app.node('#app').innerHTML;
  assert.equal((html.match(/class="step-input"/g)||[]).length,1);
  assert.match(html,/舊思路\n2\. 舊計算\n3\. 舊結論/);
  assert.doesNotMatch(html,/OLD_AI_PROMPT|OLD_FORMULA_PROMPT|OLD_FINAL_PROMPT/);
  assert.equal(JSON.parse(app.saved.get('dse_quiz_draft_v2'))['chem:T3'].text['example-mc'],original);
});

test('practice loads no AI configuration or generation requests even when an authenticated student types', async () => {
  const calls=[],app=boot('',async(url)=>{calls.push(url);return {ok:true,json:async()=>({data:null})};},{dse_quiz_sync_session_v1:'s'.repeat(48)}),item=structuredQuestion(app);
  item.kind='sub';item.marks=1;item.checks=['PRIVATE_POINT'];
  app.location.hash='#/session/chem/T3/2021';app.events.hashchange();
  await settle();
  assert.equal(calls.some(url=>url.includes('/ai/')),false);
  assert.doesNotMatch(app.node('#app').innerHTML,/ai-panel|data-ai-mode|ai-probe|ai-question/);
});

test('saved added rows collapse to the preset fields while preserving nonempty extra answers', () => {
  for (const extra of ['', '舊補充內容']) {
    const original='原本答案'+(extra?'\n2. '+extra:'');
    const draft={pick:{},text:{'example-mc':original},paper:{},steps:{'example-mc':{version:2,mode:'steps',rows:[
      {prompt:'本題結論',answer:'原本答案'},{prompt:'補充步驟',answer:''},{prompt:'補充步驟',answer:extra}
    ]}}};
    const app=boot('',undefined,{dse_quiz_draft_v2:JSON.stringify({'chem:T3':draft})}),item=structuredQuestion(app);
    item.kind='sub';item.marks=1;item.answerFields=['本題結論'];
    app.location.hash='#/session/chem/T3/2021';app.events.hashchange();
    const html=app.node('#app').innerHTML;
    assert.equal((html.match(/class="step-input"/g)||[]).length,1);
    assert.match(html,extra?/原本答案\n舊補充內容<\/textarea>/:/原本答案<\/textarea>/);
    assert.doesNotMatch(html,/補充步驟|step-add|formula-pad|data-formula/);
    assert.equal(JSON.parse(app.saved.get('dse_quiz_draft_v2'))['chem:T3'].text['example-mc'],original);
  }
});
