import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import worker, { mergeBackup, aiConfiguration, aiMessages, validateAIFeedback, requestAIFeedback } from './worker.js';

const ORIGIN = 'https://makise-kurisu-d.github.io';
const BASE = 'https://sync.example.workers.dev';
const SECRET = 'test-only-session-secret-with-enough-entropy';

const aiItem={id:'synthetic-ai',kind:'sub',stem:'解釋擴散方向與能量需求。',correct:'從高濃度向低濃度移動，不需能量。',checks:['由高濃度向低濃度移動','不需要能量','✗ 勿混淆主動運輸']};
const aiEnv={AI_BASE_URL:'https://ai.example/v1',AI_MODEL:'synthetic-model',AI_API_KEY:'test-only-key'};
function aiFixture(answer,status='hit') { return {summary:'合成服務測試回應',points:aiItem.checks.map((_,index)=>({index,status,evidence:answer,reason:'依本題提供的給分點比較。',suggestion:status==='hit'?'':'補上方向及能量條件。'})),tags:status==='hit'?[]:['概念混淆'],reply:'只限本題的合成說明',uncertainty:''}; }

test('AI stays unconfigured without an authorized provider, model and server key',()=>{
  assert.equal(aiConfiguration({}).configured,false);
  assert.deepEqual(aiConfiguration({}).missing,['DEEPSEEK_API_KEY']);
  assert.equal(aiConfiguration({...aiEnv,AI_BASE_URL:'http://example.com'}).configured,false);
  assert.equal(aiConfiguration(aiEnv).configured,true);
});

test('DeepSeek defaults need only its secret, support Pro and never expose credentials or enable images',()=>{
  const env={DEEPSEEK_API_KEY:'test-only-deepseek-key',AI_VISION:'true'};
  const config=aiConfiguration(env);
  assert.equal(config.configured,true);assert.equal(config.provider,'DeepSeek');
  assert.equal(config.model,'deepseek-flash');assert.equal(config.figuresEnabled,false);
  assert.doesNotMatch(JSON.stringify(config),/test-only-deepseek-key/);
  assert.equal(aiConfiguration({...env,DEEPSEEK_MODEL:'deepseek-v4-pro'}).configured,true);
  assert.equal(aiConfiguration({...env,DEEPSEEK_MODEL:'typo'}).configured,false);
  assert.equal(aiConfiguration({...env,AI_BASE_URL:'https://other.example'}).configured,false,'partial custom settings cannot reuse the DeepSeek key');
  assert.equal(aiConfiguration({...env,...aiEnv}).provider,'custom');
});

test('DeepSeek uses high thinking without output token caps and sends only text',async()=>{
  const answer='從較濃的地方走向較稀的地方，不耗能。';
  const out=await requestAIFeedback({...aiItem,figures:[{path:'private.jpg'}]}, {answer,mode:'review'},
    {DEEPSEEK_API_KEY:'test-only-deepseek-key',AI_VISION:'true'},['data:image/jpeg;base64,private'],async(url,init)=>{
      assert.equal(url,'https://api.deepseek.com/chat/completions');
      assert.equal(init.headers.authorization,'Bearer test-only-deepseek-key');
      const payload=JSON.parse(init.body);
      assert.equal(payload.model,'deepseek-flash');assert.deepEqual(payload.thinking,{type:'enabled'});
      assert.equal(payload.reasoning_effort,'high');assert.equal(payload.stream,false);
      assert.equal(payload.max_tokens,undefined);assert.equal(payload.max_completion_tokens,undefined);
      assert.equal(typeof payload.messages.at(-1).content,'string');
      assert.doesNotMatch(init.body,/base64,private/);
      return Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture(answer))}}]});
    });
  assert.equal(out.provider,'DeepSeek');assert.equal(out.model,'deepseek-flash');
  assert.match(out.materialNotes,/圖表未送入/);
});

test('complete feedback is preserved, while even parseable truncated responses are rejected',async()=>{
  const fixture=aiFixture('答案');fixture.reply='完整解析'.repeat(1000);
  const call=finish_reason=>requestAIFeedback(aiItem,{answer:'答案',mode:'review'},aiEnv,[],async()=>
    Response.json({choices:[{finish_reason,message:{content:JSON.stringify(fixture)}}]}));
  assert.equal((await call('stop')).reply,fixture.reply);
  await assert.rejects(call('length'),/ai_invalid_response/);
  await assert.rejects(call('content_filter'),/ai_invalid_response/);
});

test('synthetic provider fixtures map synonymous, partial and incorrect answers to the supplied checks',async()=>{
  for(const [answer,status] of [['粒子從較濃的地方走向較稀的地方，不耗能。','hit'],['向低濃度移動。','partial'],['從低濃度到高濃度並需要能量。','missed']]) {
    const out=await requestAIFeedback(aiItem,{answer,mode:'review'},aiEnv,[],async(url,init)=>{
      assert.equal(url,'https://ai.example/v1/chat/completions');
      const payload=JSON.parse(init.body);assert.match(payload.messages[0].content,/同義表達/);
      assert.match(payload.messages.at(-1).content,/由高濃度向低濃度移動/);
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture(answer,status))}}]});
    });
    assert.equal(out.points.length,3);assert.equal(out.points[0].status,status);assert.equal(out.points[0].basis,aiItem.checks[0]);assert.equal(out.points[2].scoring,false);
  }
});

test('AI rejects invented evidence, missing or duplicate checks, and never accepts model scores',()=>{
  assert.throws(()=>validateAIFeedback(aiFixture('編造引文'),aiItem,'真正原答','review'),/ai_invalid_evidence/);
  const missing=aiFixture('原答');missing.points.pop();assert.throws(()=>validateAIFeedback(missing,aiItem,'原答','review'),/ai_invalid_response/);
  const duplicate=aiFixture('原答');duplicate.points[2].index=0;assert.throws(()=>validateAIFeedback(duplicate,aiItem,'原答','review'),/ai_invalid_response/);
  const valid={...aiFixture('原答'),score:100,level:'5**'};
  const out=validateAIFeedback(valid,aiItem,'原答','review');assert.equal(out.score,undefined);assert.equal(out.level,undefined);
});

test('AI hints carry their requested depth, explicit figure uncertainty and bounded question chat',()=>{
  const messages=aiMessages({...aiItem,figures:[{path:'unused'}]},{answer:'合成答覆',mode:'hint',hintLevel:1,messages:[{role:'user',content:'追問本題'}]});
  assert.match(messages.at(-1).content,/圖表未提供/);assert.match(messages.at(-1).content,/"hintLevel":1/);assert.match(messages[0].content,/第1層只指方向/);
  const withFigures=aiMessages(aiItem,{answer:'答案'},['data:image/jpeg;base64,test']);assert.equal(withFigures.at(-1).content[1].type,'image_url');
});

test('AI provider errors, malformed payloads and timeouts expose safe retry errors',async()=>{
  const call=fetcher=>requestAIFeedback(aiItem,{answer:'合成答案'},aiEnv,[],fetcher);
  await assert.rejects(call(async()=>new Response('secret provider message',{status:503})),/ai_provider_error/);
  await assert.rejects(call(async()=>Response.json({choices:[]})),/ai_invalid_response/);
  await assert.rejects(call(async()=>{throw new DOMException('timeout','AbortError');}),/ai_timeout/);
});

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

test('AI routes reuse auth, reject blank answers, enforce limits and preserve separate confirmed backups',async t=>{
  const original=globalThis.fetch;let providerCalls=0;
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);
    if(url.endsWith('/user'))return Response.json({login:'Makise-Kurisu-D'});
    if(url.includes('/contents/question-bank/bank.json'))return Response.json({encoding:'base64',content:b64json({subjects:{chem:{items:[aiItem,{...aiItem,id:'no-basis',checks:[]}]}}})});
    if(url==='https://ai.example/v1/chat/completions'){providerCalls++;const payload=JSON.parse(init.body),answer=JSON.parse(payload.messages.at(-1).content).studentAnswer;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture(answer))}}]});}
    throw new Error('Unexpected synthetic network request');
  };t.after(()=>{globalThis.fetch=original;});
  const env={...aiEnv,SESSIONS:new MemoryKV(),SESSION_SECRET:SECRET,SITE_PASSWORD:'test-password',GITHUB_TOKEN:'synthetic-ai-token'};
  const login=await worker.fetch(new Request(BASE+'/auth/password',{method:'POST',headers:{Origin:ORIGIN},body:JSON.stringify({password:'test-password'})}),env);
  const auth=(await login.json()).sessionId,headers={Origin:ORIGIN,Authorization:'Bearer '+auth};
  const post=body=>new Request(BASE+'/ai/review',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await worker.fetch(new Request(BASE+'/ai/status',{headers:{Origin:ORIGIN}}),env)).status,401);
  assert.equal((await worker.fetch(new Request(BASE+'/ai/status',{headers:{...headers,Origin:'https://other.example'}}),env)).status,403);
  assert.equal((await (await worker.fetch(new Request(BASE+'/ai/status',{headers}),env)).json()).configured,true);
  assert.equal((await worker.fetch(post({questionId:aiItem.id,answer:'',mode:'review'}),env)).status,400);assert.equal(providerCalls,0);
  assert.equal((await worker.fetch(post({questionId:'no-basis',answer:'答案'}),env)).status,422);
  const noAI={...env,AI_API_KEY:''};assert.equal((await worker.fetch(post({questionId:aiItem.id,answer:'答案'}),noAI)).status,503);
  assert.equal((await worker.fetch(post({questionId:aiItem.id,answer:'合成同義答案'}),env)).status,200);
  assert.equal((await worker.fetch(post({questionId:aiItem.id,answer:'合成同義答案'}),env)).status,429);assert.equal(providerCalls,1);
  assert.equal([...env.SESSIONS.values.keys()].some(k=>k.includes('records')),false);
  const base={app:'kyle-dse-quiz',sessions:[{t:1,subj:'chem',topic:'T1',results:{}}],drafts:{},reviewPlan:{},aiReviews:{one:{questionId:'synthetic-ai',tags:['概念混淆']}}};
  const merged=mergeBackup(base,{...base,aiReviews:{two:{questionId:'synthetic-ai',tags:[]}}});assert.equal(merged.sessions.length,1);assert.equal(Object.keys(merged.aiReviews).length,2);
});

test('health and CORS preflight are available locally', async () => {
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, GITHUB_CLIENT_ID: 'test-client' };
  const health = await worker.fetch(new Request(`${BASE}/health`), env);
  assert.equal(health.status, 200);
  const status = await health.json();
  assert.equal(status.service, 'kyle-dse-quiz-sync');
  assert.equal(status.version, 'deepseek-ai-20261021');
  assert.equal(status.passwordConfigured, false);

  const preflight = await worker.fetch(new Request(`${BASE}/sync`, {
    method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' },
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(preflight.headers.get('access-control-max-age'), '600');
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
  assert.deepEqual(await response.json(), { ok: true, service: 'kyle-dse-quiz-sync', version: 'deepseek-ai-20261021', passwordConfigured: false, aiConfigured: false, aiProvider: 'DeepSeek', aiModel: 'deepseek-flash' });
});

test('concurrent drafts merge by answer, and deletion prevents stale answers returning', () => {
  const base = { app: 'kyle-dse-quiz', sessions: [], archive: [], reviewPlan: {}, cycle: '100' };
  const first = { ...base, drafts: { 'chem:T3': {
    pick: { a: 'A' }, text: {}, paper: {}, changedAt: { 'pick:a': 110 }, deletedAt: 0,
  } } };
  const second = { ...base, drafts: { 'chem:T3': {
    pick: { b: 'B' }, text: {}, paper: {}, changedAt: { 'pick:b': 120 }, deletedAt: 0,
  } } };
  const merged = mergeBackup(first, second);
  assert.deepEqual(merged.drafts['chem:T3'].pick, { a: 'A', b: 'B' });
  const stale = { ...base, drafts: { 'chem:T3': {
    pick: { a: 'C', b: 'B' }, text: {}, paper: {}, changedAt: { 'pick:a': 105, 'pick:b': 120 }, deletedAt: 0,
  } } };
  assert.deepEqual(mergeBackup(merged, stale).drafts['chem:T3'].pick, { a: 'A', b: 'B' });
  const deleted = { ...base, drafts: { 'chem:T3': {
    pick: {}, text: {}, paper: {}, changedAt: {}, deletedAt: 130,
  } } };
  assert.deepEqual(mergeBackup(merged, deleted).drafts['chem:T3'].pick, {});
  assert.deepEqual(mergeBackup(mergeBackup(merged, deleted), stale).drafts['chem:T3'].pick, {});
  const newer = { ...base, drafts: { 'chem:T3': {
    pick: { c: 'D' }, text: {}, paper: {}, changedAt: { 'pick:c': 140 }, deletedAt: 130,
  } } };
  assert.deepEqual(mergeBackup(mergeBackup(merged, deleted), newer).drafts['chem:T3'].pick, { c: 'D' });
  assert.deepEqual(mergeBackup(first, { ...second, cycle: '200' }).drafts['chem:T3'].pick, { b: 'B' });
});

test('OAuth handoff authenticates and sync merges through GitHub contents API', async t => {
  const env = {
    SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET,
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
  };
  const originalFetch = globalThis.fetch;
  const empty = { app: 'kyle-dse-quiz', version: 1, sessions: [], archive: [], drafts: {}, reviewPlan: {}, cycle: null };
  let file = { content: b64json(empty), sha: 'sha-1' };
  let putAttempts = 0, recordGets = 0, conflictNext = false;
  let login = 'Makise-Kurisu-D', githubCalls = 0, userCalls = 0;
  let pageAccess = true, bookPageCalls = 0, paperPageCalls = 0;
  const bookSha = 'a'.repeat(64), bookVersion = bookSha.slice(0, 16);
  const paperSha = 'c'.repeat(64), paperVersion = paperSha.slice(0, 16);
  let catalogFile = { subjects: { chem: ['2022'], bio: [] } };
  const bank = { subjects: { chem: { name: '化學', topics: [], items: [] }, bio: { name: '生物', topics: [], items: [] } } };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/')) {
      githubCalls++;
      assert.equal(new Headers(init.headers).get('user-agent'), 'kyle-dse-quiz-sync');
    }
    if (url.endsWith('/user')) { userCalls++; return Response.json({ login }); }
    if (url.endsWith('/contents/question-bank/bank.json')) return Response.json({ encoding: 'base64', content: b64json(bank) });
    if (url.endsWith('/contents/question-bank/images/chem-2022-mc-01.jpg')) {
      return Response.json({ encoding: 'base64', content: btoa(String.fromCharCode(255, 216, 255, 217)) });
    }
    if (url.endsWith('/contents/books/chem/manifest.json')) {
      return Response.json({ encoding: 'base64', content: b64json({
        version: bookVersion, pages: 2, format: 'jpeg', source_sha256: bookSha,
      }) });
    }
    if (url.endsWith(`/contents/books/chem/${bookVersion}/page-0001.jpg`)) {
      bookPageCalls++;
      if (!pageAccess) return Response.json({ message: 'Not Found' }, { status: 404 });
      return Response.json({ encoding: 'base64', content: btoa(String.fromCharCode(255, 216, 255, 217)) });
    }
    if (url.endsWith('/contents/papers/catalog.json')) {
      return Response.json({ encoding: 'base64', content: b64json(catalogFile) });
    }
    if (url.endsWith('/contents/papers/chem/2022/manifest.json')) {
      return Response.json({ encoding: 'base64', content: b64json({
        version: paperVersion, pages: 2, format: 'jpeg', source_sha256: paperSha, dpi: 200, quality: 85,
      }) });
    }
    if (url.endsWith(`/contents/papers/chem/2022/${paperVersion}/page-0001.jpg`)) {
      paperPageCalls++;
      if (!pageAccess) return Response.json({ message: 'Not Found' }, { status: 404 });
      return Response.json({ encoding: 'base64', content: btoa(String.fromCharCode(255, 216, 255, 217)) });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'mock-access-token-which-is-long-enough-for-validation',
        refresh_token: 'mock-refresh-token', expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.endsWith('/contents/records.json') && (!init.method || init.method === 'GET')) {
      recordGets++;
      return Response.json(file);
    }
    if (url.endsWith('/contents/records.json') && init.method === 'PUT') {
      putAttempts++;
      if (putAttempts === 1) return Response.json({ message: 'sha conflict' }, { status: 409 });
      if (conflictNext) {
        conflictNext = false;
        file = { content: b64json({ ...empty, sessions: [{ t: 3, subj: 'bio', topic: 'T1', results: {} }] }),
          sha: 'b'.repeat(40) };
        return Response.json({ message: 'sha conflict' }, { status: 409 });
      }
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

  // A client that just fetched records can upload with that SHA without a
  // redundant server GET; a concurrent write still falls back to merge/retry.
  file.sha = 'a'.repeat(40);
  const fastBackup = { ...backup, sessions: backup.sessions.concat({ t: 2, subj: 'chem', topic: 'T2', results: {} }) };
  const readsBeforeFastPut = recordGets;
  const fastSaved = await worker.fetch(new Request(`${BASE}/sync`, {
    method: 'PUT', headers: { Origin: ORIGIN, Authorization: `Bearer ${sessionId}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: fastBackup, sha: file.sha }),
  }), env);
  assert.equal(fastSaved.status, 200);
  assert.equal(recordGets, readsBeforeFastPut, 'matching SHA avoids a second records GET');
  assert.equal(fromB64json(file.content).sessions.length, 2);

  file.sha = 'a'.repeat(40);
  conflictNext = true;
  const readsBeforeConflict = recordGets;
  const mergedSaved = await worker.fetch(new Request(`${BASE}/sync`, {
    method: 'PUT', headers: { Origin: ORIGIN, Authorization: `Bearer ${sessionId}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: fastBackup, sha: file.sha }),
  }), env);
  assert.equal(mergedSaved.status, 200);
  assert.equal(recordGets, readsBeforeConflict + 1, 'SHA conflict reads the new remote version');
  assert.equal(fromB64json(file.content).sessions.length, 3, 'concurrent answers survive the retry');

  const privateHeaders = { Origin: ORIGIN, Authorization: `Bearer ${sessionId}` };
  const beforeDenied = githubCalls;
  for (const [path, headers, status] of [
    ['/bank', { Origin: ORIGIN }, 401],
    ['/bank/images/chem-2022-mc-01.jpg', { Origin: ORIGIN }, 401],
    ['/bank', { ...privateHeaders, Origin: 'https://attacker.example' }, 403],
    ['/bank/images/records.json', privateHeaders, 404],
    ['/bank/images/chem-2022-mc-01.jpg/extra', privateHeaders, 404],
    ['/bank/images/%2e%2e%2frecords.json', privateHeaders, 404],
    ['/papers/catalog', { Origin: ORIGIN }, 401],
    ['/papers/chem/2022/manifest', { Origin: ORIGIN }, 401],
    [`/papers/chem/2022/pages/${paperVersion}/1`, { Origin: ORIGIN }, 401],
    ['/papers/catalog', { ...privateHeaders, Origin: 'https://attacker.example' }, 403],
    [`/papers/chem/2022/pages/${paperVersion}/1`, { ...privateHeaders, Origin: 'https://attacker.example' }, 403],
    ['/papers/records.json', privateHeaders, 404],
    ['/papers/chem/2022/extra', privateHeaders, 404],
    ['/papers/chem/2022/pages/not-hex/1', privateHeaders, 404],
    [`/papers/chem/2022/pages/${paperVersion}/0001`, privateHeaders, 404],
    ['/papers/chem/%2e%2e/manifest', privateHeaders, 404],
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
  const retired = await worker.fetch(new Request(`${BASE}/books/chem/manifest`, { headers: privateHeaders }), env);
  assert.equal(retired.status, 410);
  assert.equal((await retired.json()).error, 'book_reader_retired');
  assert.equal(bookPageCalls, 0, 'retired books do not request old screenshots');
  const paperCatalog = await worker.fetch(new Request(`${BASE}/papers/catalog`, { headers: privateHeaders }), env);
  assert.equal(paperCatalog.status, 200);
  assert.equal(paperCatalog.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await paperCatalog.json(), { subjects: { chem: ['2022'], bio: [], math: [] } });
  catalogFile.papers = { chem: { '2022': { pages: 2, source_sha256: paperSha, ignored: 'private extra',
    assessment: { source_sha256: paperSha, earned: 70, total: 100, scope: '兩卷練習', basis: '非官方練習參考',
      components: [{ label: '卷一', earned: 70, total: 100 }],
      boundaries: [{ level: '4', minimumPercent: 65 }, { level: '5', minimumPercent: 75 }], ignored: 'extra' } },
    '2023': { pages: 2, source_sha256: paperSha } }, bio: {} };
  const withGrades = await (await worker.fetch(new Request(`${BASE}/papers/catalog?refresh=1`, { headers: privateHeaders }), env)).json();
  assert.equal(withGrades.papers.chem['2022'].assessment.earned, 70);
  assert.equal(withGrades.papers.chem['2022'].assessment.ignored, undefined);
  assert.equal(withGrades.papers.chem['2023'], undefined, 'unpublished years are never returned');
  catalogFile.papers.chem['2022'].assessment.source_sha256 = 'd'.repeat(64);
  const staleGrade = await (await worker.fetch(new Request(`${BASE}/papers/catalog?refresh=1`, { headers: privateHeaders }), env)).json();
  assert.equal(staleGrade.papers.chem['2022'].assessment, undefined, 'stale grades are omitted while the paper remains readable');
  catalogFile = { subjects: { chem: ['2022'], bio: [] } };
  const paperManifest = await worker.fetch(new Request(`${BASE}/papers/chem/2022/manifest`, { headers: privateHeaders }), env);
  assert.equal(paperManifest.status, 200);
  assert.deepEqual(await paperManifest.json(), { version: paperVersion, pages: 2, format: 'jpeg',
    source_sha256: paperSha, dpi: 200, quality: 85 });
  const paperPageUrl = `${BASE}/papers/chem/2022/pages/${paperVersion}/1`;
  const paperPage = await worker.fetch(new Request(paperPageUrl, { headers: privateHeaders }), env);
  assert.equal(paperPage.status, 200);
  assert.equal(paperPage.headers.get('content-type'), 'image/jpeg');
  assert.equal(paperPage.headers.get('cache-control'), 'no-store');
  assert.equal(paperPage.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await paperPage.arrayBuffer())], [255, 216, 255, 217]);
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/chem/2023/manifest`, { headers: privateHeaders }), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/chem/2022/pages/${'d'.repeat(16)}/1`, { headers: privateHeaders }), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/chem/2022/pages/${paperVersion}/3`, { headers: privateHeaders }), env)).status, 404);
  assert.equal(paperPageCalls, 1, 'unlisted, stale and out-of-range papers never fetch image files');
  pageAccess = false;
  const missingPaperPage = await worker.fetch(new Request(paperPageUrl, { headers: privateHeaders }), env);
  assert.equal(missingPaperPage.status, 404);
  assert.deepEqual(await missingPaperPage.json(), { error: 'paper_not_accessible' });
  pageAccess = true;
  login = 'someone-else';
  const stranger = await worker.fetch(new Request(`${BASE}/bank`, { headers: privateHeaders }), env);
  assert.equal(stranger.status, 403);
  assert.equal((await stranger.json()).error, 'owner_only');
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/catalog`, { headers: privateHeaders }), env)).status, 403);

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
  const userCallsBeforePasswordReads = userCalls;
  const bankViaPassword = await worker.fetch(new Request(`${BASE}/bank`, { headers: passwordHeaders }), env);
  assert.equal(bankViaPassword.status, 200);
  assert.deepEqual(await bankViaPassword.json(), bank);
  const savedViaPassword = await worker.fetch(new Request(`${BASE}/sync`, {
    method: 'PUT', headers: { ...passwordHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: backup }),
  }), env);
  assert.equal(savedViaPassword.status, 200);
  const pictureViaPassword = await worker.fetch(new Request(`${BASE}/bank/images/chem-2022-mc-01.jpg`, { headers: passwordHeaders }), env);
  assert.equal(pictureViaPassword.status, 200);
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/catalog`, { headers: passwordHeaders }), env)).status, 200);
  assert.equal((await worker.fetch(new Request(paperPageUrl, { headers: passwordHeaders }), env)).status, 200);
  assert.equal(userCalls, userCallsBeforePasswordReads, 'verified owner sessions avoid repeated GitHub identity reads');
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

test('password login never waits for expired storage tokens and transient refresh failures preserve the connection', async t => {
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, SITE_PASSWORD: 'test-password',
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' };
  const originalFetch = globalThis.fetch, originalNow = Date.now, originalSetTimeout = globalThis.setTimeout;
  const started = originalNow();
  let now = started, mode = 'healthy', refreshCalls = 0, finishRefresh;
  Date.now = () => now;
  t.after(() => { globalThis.fetch = originalFetch; Date.now = originalNow; globalThis.setTimeout = originalSetTimeout; });
  const token = () => Response.json({ access_token: 'test-access-' + now, refresh_token: 'test-refresh-' + now,
    expires_in: 28800, refresh_token_expires_in: 15897600 });
  const bank = { subjects: { chem: { topics: [], items: [] }, bio: { topics: [], items: [] } } };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/login/oauth/access_token')) {
      const refresh = JSON.parse(options.body).grant_type === 'refresh_token';
      if (!refresh) return token();
      refreshCalls++;
      if (mode === 'unavailable') return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
      if (mode === 'stalled') return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      if (mode === 'rotated') return new Promise(resolve => { finishRefresh = resolve; });
      return token();
    }
    if (String(url).endsWith('/user')) return Response.json({ login: 'Makise-Kurisu-D' });
    if (String(url).endsWith('/question-bank/bank.json')) return Response.json({ encoding: 'base64', content: b64json(bank) });
    throw new Error('Unexpected test request');
  };
  const start = await worker.fetch(new Request(`${BASE}/auth/start`), env);
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const connect = () => worker.fetch(new Request(`${BASE}/auth/callback?code=test-code&state=${state}`, { headers: { Cookie: cookie } }), env);
  assert.equal((await connect()).status, 302);
  const saved = await env.SESSIONS.get('service:github-owner');
  now += 9 * 3600000;
  mode = 'stalled';
  const login = await worker.fetch(new Request(`${BASE}/auth/password`, { method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) }), env);
  assert.equal(login.status, 200);
  assert.equal(refreshCalls, 0, 'correct password verification performs no upstream renewal');
  const id = (await login.json()).sessionId;
  const readBank = () => worker.fetch(new Request(`${BASE}/bank`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${id}` } }), env);
  mode = 'unavailable';
  const unavailable = await readBank();
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, 'storage_unavailable');
  assert.equal(await env.SESSIONS.get('service:github-owner'), saved);
  mode = 'stalled';
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 8000 ? 5 : ms, ...args);
  const timedOut = await readBank();
  globalThis.setTimeout = originalSetTimeout;
  assert.equal(timedOut.status, 503);
  assert.equal((await timedOut.json()).error, 'storage_timeout');
  assert.equal(timedOut.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(await env.SESSIONS.get('service:github-owner'), saved);
  mode = 'healthy';
  assert.equal((await readBank()).status, 200, 'a later request retries renewal without reconnecting');
  assert.equal(refreshCalls, 3);
  now += 9 * 3600000;
  mode = 'rotated';
  const pending = readBank();
  while (!finishRefresh) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await connect()).status, 302);
  const renewed = await env.SESSIONS.get('service:github-owner');
  finishRefresh(Response.json({ error: 'bad_refresh_token' }, { status: 400 }));
  assert.equal((await pending).status, 200, 'a losing renewal uses the newer stored connection');
  assert.equal(await env.SESSIONS.get('service:github-owner'), renewed);
});

test('login warms the bank while saving its session and private reads share only authorized short-lived results', { timeout: 2000 }, async t => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const started = originalNow();
  let now = started, bankCalls = 0, finishBank, releaseSession, warmingStarted, sessionStarted;
  const bankStarted = new Promise(resolve => { warmingStarted = resolve; });
  const sessionSaving = new Promise(resolve => { sessionStarted = resolve; });
  const saveAllowed = new Promise(resolve => { releaseSession = resolve; });
  const deletes = [];
  class SlowSessionKV extends MemoryKV {
    async put(key, value) {
      if (/^[A-Za-z0-9_-]{43}$/.test(key)) { sessionStarted(); await saveAllowed; }
      await super.put(key, value);
    }
    async delete(key) { deletes.push(key); await super.delete(key); }
  }
  const env = { SESSIONS: new SlowSessionKV(), SESSION_SECRET: SECRET, SITE_PASSWORD: 'test-password',
    GITHUB_TOKEN: 'speed-test-upstream-token' };
  Date.now = () => now;
  t.after(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });
  const bank = { subjects: { chem: { topics: [], items: [] }, bio: { topics: [], items: [] } } };
  globalThis.fetch = async url => {
    if (String(url).endsWith('/user')) return Response.json({ login: 'Makise-Kurisu-D' });
    if (String(url).endsWith('/question-bank/bank.json')) {
      bankCalls++;
      if (bankCalls === 1) { warmingStarted(); return new Promise(resolve => { finishBank = resolve; }); }
      return Response.json({ encoding: 'base64', content: b64json(bank) });
    }
    throw new Error('Unexpected speed-test request');
  };
  const background = [], ctx = { waitUntil(promise) { background.push(promise); } };
  const login = worker.fetch(new Request(`${BASE}/auth/password`, { method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) }), env, ctx);
  await Promise.all([bankStarted, sessionSaving]);
  assert.equal(bankCalls, 1, 'the bank starts loading before session persistence completes');
  releaseSession();
  const response = await login;
  assert.equal(response.status, 200, 'login does not await the bank download');
  assert.equal(deletes.length, 0, 'a first-attempt login avoids an unnecessary KV delete');
  const id = (await response.json()).sessionId;
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${id}` };
  const read = worker.fetch(new Request(`${BASE}/bank`, { headers }), env);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bankCalls, 1);
  finishBank(Response.json({ encoding: 'base64', content: b64json(bank) }));
  assert.deepEqual(await (await read).json(), bank);
  await Promise.all(background);
  assert.equal((await worker.fetch(new Request(`${BASE}/bank`, { headers }), env)).headers.get('cache-control'), 'no-store');
  assert.equal(bankCalls, 1, 'a recent authorized bank read skips GitHub');
  assert.equal((await worker.fetch(new Request(`${BASE}/bank`, { headers: { Origin: ORIGIN } }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(`${BASE}/bank`, { headers: { ...headers, Origin: 'https://attacker.example' } }), env)).status, 403);
  now += 31000;
  assert.equal((await worker.fetch(new Request(`${BASE}/bank`, { headers }), env)).status, 200);
  assert.equal(bankCalls, 2, 'bank data refreshes after the short memory TTL');
  await worker.fetch(new Request(`${BASE}/auth/logout`, { method: 'POST', headers }), env);
  assert.equal((await worker.fetch(new Request(`${BASE}/bank`, { headers }), env)).status, 401, 'warm bank data cannot bypass logout');
});

test('private bank fails closed when storage or secrets are not configured', async () => {
  const response = await worker.fetch(new Request(`${BASE}/bank`, { headers: { Origin: ORIGIN } }), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'service_not_configured');
});

test('paper navigation validates final pages and metadata caching never bypasses per-request authorization', async t => {
  const originalFetch = globalThis.fetch, counts = { catalog: 0, manifest: 0, pages: 0, figures: 0 };
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, SITE_PASSWORD: 'synthetic-password', GITHUB_TOKEN: 'unique-metadata-token' };
  const sha = 'e'.repeat(64), version = sha.slice(0, 16);
  let sections = [{ label: 'Summary', page: 1 }, { label: 'Part B', page: 2 }];
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/user')) return Response.json({ login: 'Makise-Kurisu-D' });
    if (url.endsWith('/papers/catalog.json')) {
      counts.catalog++;
      return Response.json({ encoding: 'base64', content: b64json({ subjects: { chem: ['2022'], bio: [] } }) });
    }
    if (url.endsWith('/manifest.json')) {
      counts.manifest++;
      return Response.json({ encoding: 'base64', content: b64json({ version, source_sha256: sha, pages: 2, format: 'jpeg', dpi: 200, quality: 85, sections }) });
    }
    if (url.includes('/question-bank/images/')) counts.figures++; else counts.pages++;
    return Response.json({ encoding: 'base64', content: btoa(String.fromCharCode(255, 216, 255, 217)) });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const login = await worker.fetch(new Request(`${BASE}/auth/password`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.SITE_PASSWORD }) }), env);
  const headers = { Origin: ORIGIN, Authorization: 'Bearer ' + (await login.json()).sessionId };
  const request = path => worker.fetch(new Request(BASE + path, { headers }), env);
  const manifest = await request('/papers/chem/2022/manifest');
  assert.deepEqual((await manifest.json()).sections, sections);
  assert.equal((await request(`/papers/chem/2022/pages/${version}/1`)).status, 200);
  assert.equal((await request(`/papers/chem/2022/pages/${version}/2`)).status, 200);
  assert.equal(counts.catalog, 1); assert.equal(counts.manifest, 1);
  assert.equal(counts.pages, 2, 'each page reads only its image after metadata is warmed');
  assert.equal((await request('/bank/images/chem-2022-fig-example.jpg')).status, 200);
  assert.equal(counts.figures, 1);
  assert.equal((await request('/bank/images/chem-2022-fig-../../records.json')).status, 404);
  assert.equal((await request(`/papers/chem/2022/pages/${'f'.repeat(16)}/1`)).status, 404);
  assert.equal(counts.pages, 2, 'old versions never request an archived image');
  sections = [{ label: 'Invalid', page: 3 }];
  assert.equal((await request('/papers/chem/2022/manifest?refresh=1')).status, 502);
  sections = [{ label: 'Revised section', page: 1 }];
  assert.deepEqual((await (await request('/papers/chem/2022/manifest?refresh=2')).json()).sections, sections);
  const before = JSON.stringify(counts);
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/catalog`, { headers: { ...headers, Origin: 'https://other.example' } }), env)).status, 403);
  await worker.fetch(new Request(`${BASE}/auth/logout`, { method: 'POST', headers }), env);
  assert.equal((await request('/papers/chem/2022/manifest')).status, 401);
  assert.equal((await request('/bank/images/chem-2022-fig-example.jpg')).status, 401);
  assert.equal(JSON.stringify(counts), before, 'invalid origin and logged-out sessions cannot consume cached private metadata');
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

test('storage failures return a readable CORS error instead of an opaque browser fetch failure', async () => {
  const env = { SITE_PASSWORD: 'test-password', SESSION_SECRET: SECRET, SESSIONS: {
    get: async () => { throw new Error('private-internal-detail'); }, put: async () => {},
  } };
  const response = await worker.fetch(new Request(`${BASE}/auth/password`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
  }), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  const health = await worker.fetch(new Request(`${BASE}/health`), env);
  assert.equal((await health.json()).passwordConfigured, true);
});



test('mathematics papers and figures keep the same authentication and path restrictions', async t => {
  const originalFetch = globalThis.fetch;
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, SITE_PASSWORD: 'synthetic-math-password', GITHUB_TOKEN: 'synthetic-math-token' };
  const sha = '9'.repeat(64), version = sha.slice(0, 16);
  const assessment = { source_sha256: sha, earned: 7, total: 10, scope: '示例卷一', basis: '示例評分', components: [{ label: '卷一', earned: 7, total: 10 }], boundaries: [] };
  const catalog = { subjects: { chem: [], bio: [], math: ['2022'] }, papers: { math: { '2022': { pages: 2, source_sha256: sha, assessment } } } };
  const paths = [];
  globalThis.fetch = async input => {
    const url = String(input); paths.push(url);
    if (url.endsWith('/user')) return Response.json({ login: 'Makise-Kurisu-D' });
    const value = url.endsWith('/catalog.json') ? catalog : { version, source_sha256: sha, pages: 2, format: 'jpeg', dpi: 200, quality: 85, sections: [{ label: 'Summary', page: 1 }] };
    if (url.endsWith('.jpg')) return Response.json({ encoding: 'base64', content: btoa(String.fromCharCode(255, 216, 255, 217)) });
    return Response.json({ encoding: 'base64', content: b64json(value) });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const login = await worker.fetch(new Request(`${BASE}/auth/password`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.SITE_PASSWORD }) }), env);
  const headers = { Origin: ORIGIN, Authorization: 'Bearer ' + (await login.json()).sessionId };
  const request = path => worker.fetch(new Request(BASE + path, { headers }), env);
  const response = await request('/papers/catalog');
  const published = await response.json();
  assert.deepEqual(published.subjects.math, ['2022']);
  assert.deepEqual(published.papers.math['2022'].assessment.boundaries, [], 'one paper does not invent a combined grade');
  assert.equal((await request('/papers/math/2022/manifest')).status, 200);
  assert.equal((await request(`/papers/math/2022/pages/${version}/2`)).status, 200);
  assert.equal((await request('/bank/images/math-2022-fig-example.jpg')).status, 200);
  assert.ok(paths.some(path => path.includes(`/papers/math/2022/${version}/page-0002.jpg`)));
  const before = paths.filter(path => path.includes('/contents/')).length;
  for (const path of ['/papers/math/2023/manifest', `/papers/math/2022/pages/${version}/3`, '/bank/images/math-2022-fig-example.jpg/extra', '/papers/math/2022/pages/not-a-hash/1']) {
    assert.equal((await request(path)).status, 404, path);
  }
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/math/2022/manifest`, { headers: { Origin: ORIGIN } }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/math/2022/manifest`, { headers: { ...headers, Origin: 'https://other.example' } }), env)).status, 403);
  assert.equal(paths.filter(path => path.includes('/contents/')).length, before, 'denied mathematics reads never reach private files');
});
