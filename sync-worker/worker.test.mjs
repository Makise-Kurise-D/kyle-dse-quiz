import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pbkdf2Sync } from 'node:crypto';
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

test('removed provider cannot be selected through primary or fallback configuration', async()=>{
  for (const patch of [{AI_MODEL:'gemini-4-argon'}, {AI_MODEL:'gemini-argon-thinking'},
      {AI_BASE_URL:'https://argon.example/v1'}]) {
    const config=aiConfiguration({...aiEnv,...patch});
    assert.equal(config.configured,false);
    assert.equal(config.invalidModel,true);
    await assert.rejects(()=>requestAIFeedback(aiItem,{answer:'submitted',mode:'review'},
      {...aiEnv,...patch},[],async()=>{throw new Error('removed provider was contacted');}),
      error=>error.code==='ai_config_incomplete'||/config|model/i.test(error.message));
  }
  const config=aiConfiguration({...aiEnv,AI_FALLBACK_BASE_URL:'https://fallback.example/v1',
    AI_FALLBACK_MODEL:'gemini-4-argon',AI_FALLBACK_API_KEY:'independent-test-only'});
  assert.equal(config.configured,true);
  assert.equal(config.fallbackConfigured,false);
});

test('DeepSeek defaults use 4.1 Flash, reject Pro, and keep native vision opt-in',()=>{
  const env={DEEPSEEK_API_KEY:'test-only-deepseek-key',AI_VISION:'true'};
  const config=aiConfiguration(env);
  assert.equal(config.configured,true);assert.equal(config.provider,'DeepSeek');
  assert.equal(config.model,'deepseek-flash');assert.equal(config.figuresEnabled,true);
  assert.equal(aiConfiguration({DEEPSEEK_API_KEY:'test-only-key'}).figuresEnabled,false);
  assert.doesNotMatch(JSON.stringify(config),/test-only-deepseek-key/);
  assert.equal(aiConfiguration({...env,DEEPSEEK_MODEL:'deepseek-v4-pro'}).configured,false);
  assert.equal(aiConfiguration({...env,DEEPSEEK_MODEL:'typo'}).configured,false);
  assert.equal(aiConfiguration({...env,AI_BASE_URL:'https://other.example'}).configured,false,'partial custom settings cannot reuse the DeepSeek key');
  assert.equal(aiConfiguration({...env,...aiEnv}).provider,'custom');
});

test('DeepSeek uses high thinking without output token caps and sends images only when enabled',async()=>{
  const answer='從較濃的地方走向較稀的地方，不耗能。';
  const out=await requestAIFeedback({...aiItem,figures:[{path:'private.jpg'}]}, {answer,mode:'review'},
    {DEEPSEEK_API_KEY:'test-only-deepseek-key',AI_VISION:'true'},['data:image/jpeg;base64,private'],async(url,init)=>{
      assert.equal(url,'https://api.deepseek.com/chat/completions');
      assert.equal(init.headers.authorization,'Bearer test-only-deepseek-key');
      const payload=JSON.parse(init.body);
      assert.equal(payload.model,'deepseek-flash');assert.deepEqual(payload.thinking,{type:'enabled'});
      assert.equal(payload.reasoning_effort,'high');assert.equal(payload.stream,false);
      assert.equal(payload.max_tokens,undefined);assert.equal(payload.max_completion_tokens,undefined);
      assert.ok(Array.isArray(payload.messages.at(-1).content));
      assert.match(init.body,/base64,private/);
      return Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture(answer))}}]});
    });
  assert.equal(out.provider,'DeepSeek');assert.equal(out.model,'deepseek-flash');
  assert.equal(out.materialNotes,'');
});

test('DeepSeek vision-disabled calls strip even supplied image content',async()=>{
  const answer='答案';
  const out=await requestAIFeedback({...aiItem,figures:[{path:'private.jpg'}]}, {answer},
    {DEEPSEEK_API_KEY:'test-only-key'},['data:image/jpeg;base64,private'],async(url,init)=>{
      assert.equal(typeof JSON.parse(init.body).messages.at(-1).content,'string');
      assert.doesNotMatch(init.body,/base64,private/);
      return Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture(answer))}}]});
    });
  assert.match(out.materialNotes,/圖表未送入/);
});

test('practice hints and scaffolds are rejected before any model call',async()=>{
  let calls=0;
  for(const mode of ['hint','scaffold']) {
    assert.throws(()=>aiMessages(aiItem,{answer:'答案',mode}),/ai_practice_disabled/);
    await assert.rejects(requestAIFeedback(aiItem,{answer:'答案',mode},aiEnv,[],async()=>{calls++;}),/ai_practice_disabled/);
  }
  assert.equal(calls,0);
  assert.equal(aiConfiguration(aiEnv).practiceEnabled,false);
  assert.deepEqual(aiConfiguration(aiEnv).modes,['review','followup']);
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

test('submitted analysis carries figure limits, independent-answer rules and bounded question chat',()=>{
  const messages=aiMessages({...aiItem,figures:[{path:'unused'}]},{answer:'合成答覆',mode:'followup',question:'漏了哪一點？',messages:[{role:'user',content:'追問本題'}]});
  assert.match(messages.at(-1).content,/圖表未提供/);
  assert.match(messages.at(-1).content,/"phase":"submitted_review"/);
  assert.match(messages[0].content,/不提供作答前提示或拆題/);
  assert.match(messages[0].content,/數量不等於題目分數/);
  const withFigures=aiMessages(aiItem,{answer:'答案'},['data:image/jpeg;base64,test']);assert.equal(withFigures.at(-1).content[1].type,'image_url');
});

test('AI receives verified historical answers separately from the current attempt and ignores client replacements',()=>{
  const item={...aiItem,year:'2021',paper:'卷一',qref:'Q3',my:[['當年寫了錯誤方向。',true],['當年寫了需要能量。',true]],deduct:'方向及能量概念錯誤。'};
  const messages=aiMessages(item,{mode:'followup',answer:'這次已寫正確方向，不需要能量。',question:'我當年為甚麼答錯？',originalAttempt:{answer:'假原答'}});
  const payload=JSON.parse(messages.at(-1).content);
  assert.deepEqual(payload.materials.originalAttempt,{year:'2021',paper:'卷一',questionRef:'Q3',answer:'當年寫了錯誤方向。\n當年寫了需要能量。',deduction:item.deduct});
  assert.equal(payload.studentAnswer,'這次已寫正確方向，不需要能量。');
  assert.doesNotMatch(messages.at(-1).content,/假原答/);
  assert.match(messages[0].content,/evidence 不可引用當年原答/);
  assert.equal(JSON.parse(aiMessages(aiItem,{answer:'本次答案'}).at(-1).content).materials.originalAttempt.answer,null);
});

test('historical evidence cannot be accepted as proof of the current answer',async()=>{
  const item={...aiItem,my:[['當年原答',true]]};
  await assert.rejects(requestAIFeedback(item,{answer:'這次重做答案',mode:'review'},aiEnv,[],async()=>
    Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture('當年原答'))}}]})),/ai_invalid_evidence/);
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
  for(const mode of ['hint','scaffold'])assert.equal((await worker.fetch(post({questionId:aiItem.id,answer:'',mode}),env)).status,410);
  assert.equal(providerCalls,0);
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
  assert.equal(status.version, 'grading-evidence-papers-20261026');
  assert.equal(status.passwordConfigured, false);
  assert.equal(status.aiFiguresEnabled, false);
  const enabled = await worker.fetch(new Request(`${BASE}/health`), {...env, DEEPSEEK_API_KEY: 'synthetic-only', AI_VISION: 'true'});
  const enabledStatus = await enabled.json();
  assert.equal(enabledStatus.aiModel, 'deepseek-flash');
  assert.equal(enabledStatus.aiFiguresEnabled, true);
  assert.doesNotMatch(JSON.stringify(enabledStatus), /synthetic-only/);

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
  assert.deepEqual(await response.json(), { ok: true, service: 'kyle-dse-quiz-sync', version: 'grading-evidence-papers-20261026', passwordConfigured: false, aiConfigured: false, aiProvider: 'DeepSeek', aiModel: 'deepseek-flash', aiFiguresEnabled: false });
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
  assert.deepEqual(await loaded.json(), globalThis.DSESubjects.bankFor('kyle', bank));
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
  assert.deepEqual(await bankViaPassword.json(), globalThis.DSESubjects.bankFor('kyle', bank));
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
  assert.deepEqual(await (await read).json(), globalThis.DSESubjects.bankFor('kyle', bank));
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
  let thumbnails = { columns: 2, rows: 1, width: 200, height: 283 };
  let page_sizes = [[595, 842], [700, 842]];
  let mistakes = [{ label: 'Q1(a)', page: 2, x: 0.75, y: 0.1, privateExtra: 'omit' }, { label: 'Q1(b)', page: 2, x: 0.75, y: 0.4 }];
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
      return Response.json({ encoding: 'base64', content: b64json({ version, source_sha256: sha, pages: 2, format: 'jpeg', dpi: 200, quality: 85, sections, thumbnails, page_sizes, mistakes }) });
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
  const atlas = await request(`/papers/chem/2022/thumbnails/${version}`);
  assert.equal(atlas.status, 200);
  assert.equal(atlas.headers.get('cache-control'), 'no-store');
  assert.equal(atlas.headers.get('content-type'), 'image/jpeg');
  assert.equal(counts.pages, 3, 'all previews use one private image request');
  assert.equal((await request(`/papers/chem/2022/thumbnails/${'f'.repeat(16)}`)).status, 404);
  assert.equal(counts.pages, 3);
  const indexed = await (await request('/papers/chem/2022/manifest?refresh=mistakes')).json();
  assert.deepEqual(indexed.mistakes, mistakes.map(({ label, page, x, y }) => ({ label, page, x, y })));
  const goodMistakes = mistakes;
  for (const invalid of [[{ ...mistakes[0], page: 3 }], [{ ...mistakes[0], y: 1 }],
    [{ ...mistakes[0], x: -0.1 }], [...mistakes].reverse(), [mistakes[0], mistakes[0]],
    [{ ...mistakes[0], label: '' }], { page: 2 }]) {
    mistakes = invalid;
    assert.equal((await request('/papers/chem/2022/manifest?refresh=invalid-mistake')).status, 502);
  }
  mistakes = [];
  assert.deepEqual((await (await request('/papers/chem/2022/manifest?refresh=no-mistakes')).json()).mistakes, []);
  mistakes = undefined;
  assert.equal('mistakes' in await (await request('/papers/chem/2022/manifest?refresh=legacy')).json(), false);
  mistakes = goodMistakes;
  thumbnails = { ...thumbnails, rows: 0 };
  assert.equal((await request('/papers/chem/2022/manifest?refresh=atlas')).status, 502);
  thumbnails = { columns: 2, rows: 1, width: 200, height: 283 };
  page_sizes = [[595, 0], [700, 842]];
  assert.equal((await request('/papers/chem/2022/manifest?refresh=sizes')).status, 502);
  page_sizes = [[595, 842], [700, 842]];
  sections = [{ label: 'Invalid', page: 3 }];
  assert.equal((await request('/papers/chem/2022/manifest?refresh=1')).status, 502);
  sections = [{ label: 'Revised section', page: 1 }];
  assert.deepEqual((await (await request('/papers/chem/2022/manifest?refresh=2')).json()).sections, sections);
  const before = JSON.stringify(counts);
  assert.equal((await worker.fetch(new Request(`${BASE}/papers/catalog`, { headers: { ...headers, Origin: 'https://other.example' } }), env)).status, 403);
  await worker.fetch(new Request(`${BASE}/auth/logout`, { method: 'POST', headers }), env);
  assert.equal((await request('/papers/chem/2022/manifest')).status, 401);
  assert.equal((await request(`/papers/chem/2022/thumbnails/${version}`)).status, 401);
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

test('Yeelam identity isolates every private route and cannot upgrade or select another user', async t => {
  const password = 'synthetic-yeelam-password';
  const salt = '0123456789abcdef0123456789abcdef';
  const hash = `pbkdf2-sha256:100000:${salt}:${pbkdf2Sync(password, Buffer.from(salt,'hex'), 100000, 32, 'sha256').toString('hex')}`;
  const env = { ...aiEnv, SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, SITE_PASSWORD: 'synthetic-owner-password', YEELAM_PASSWORD_VERIFIER: hash, GITHUB_TOKEN: 'synthetic-isolation-token' };
  const seen = [], files = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/user') return Response.json({ login: 'Makise-Kurisu-D' });
    seen.push({ path, method: init.method || 'GET' });
    assert.match(path, /\/contents\/users\/yeelam\//, 'no guest request may reach owner data');
    if (init.method === 'PUT') {
      files.set(path, JSON.parse(init.body).content);
      return Response.json({ content: { sha: 'a'.repeat(40) } });
    }
    if (init.method === 'DELETE') { files.delete(path); return Response.json({}); }
    if (files.has(path)) return Response.json({ encoding: 'base64', content: files.get(path), sha: 'a'.repeat(40) });
    return Response.json({ message: 'not found' }, { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });
  const login = async (username, pass = password, options = {}) => worker.fetch(new Request(`${BASE}/auth/password`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: pass })
  }), { ...env, ...options });
  assert.equal((await login('Kyle')).status, 401);
  assert.equal((await login('../kyle')).status, 401);
  assert.equal((await login('Yeelam', password, { YEELAM_PASSWORD_VERIFIER: undefined })).status, 401);
  const response = await login(' Yeelam ');
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.userId, 'yeelam');
  assert.doesNotMatch(JSON.stringify(session), /synthetic-/);
  const call = (path, method = 'GET', body) => worker.fetch(new Request(`${BASE}${path}`, {
    method, headers: { Origin: ORIGIN, Authorization: `Bearer ${session.sessionId}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env);
  assert.deepEqual((await (await call('/bank')).json()).subjects.math.items, []);
  assert.deepEqual((await (await call('/papers/catalog')).json()).subjects, { math: [], m2: [], physics: [] });
  assert.equal((await call('/bank/images/chem-2022-mc-01.jpg')).status, 404);
  assert.equal((await call('/papers/chem/2022/manifest')).status, 404);
  assert.equal((await call('/auth/upgrade', 'POST')).status, 403);
  assert.equal((await call('/ai/review', 'POST', { questionId: 'owner-question', answer: 'answer' })).status, 404);
  const data = { app: 'kyle-dse-quiz', sessions: [{ t: 1, subj: 'chem', results: {} }], drafts: {}, archive: [] };
  assert.equal((await call('/sync?userId=kyle', 'PUT', { data, userId: 'kyle' })).status, 200);
  assert.deepEqual((await (await call('/sync')).json()).data.sessions, data.sessions);
  assert.ok(seen.some(v => v.path.endsWith('/users/yeelam/records.json') && v.method === 'PUT'));
  assert.equal((await call('/sync', 'DELETE')).status, 200);
  assert.equal((await (await call('/sync')).json()).data, null);
  env.YEELAM_PASSWORD_VERIFIER = '0'.repeat(64);
  assert.equal((await call('/sync')).status, 401, 'changing only guest verifier revokes guest sessions');
  const owner = await login('Kyle', env.SITE_PASSWORD);
  assert.equal(owner.status, 200, 'guest verifier rotation does not invalidate owner login');
});

test('salted Kyle verifier replaces legacy password and revokes old sessions without affecting Yeelam', async () => {
  const salt = 'abcdef0123456789abcdef0123456789';
  const verifier = password => `pbkdf2-sha256:100000:${salt}:${pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex')}`;
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, SITE_PASSWORD: 'synthetic-old-owner', GITHUB_TOKEN: 'synthetic-verifier-token' };
  const login = (username, password) => worker.fetch(new Request(`${BASE}/auth/password`, {
    method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({ username, password })
  }), env);
  const old = await (await login('Kyle', env.SITE_PASSWORD)).json();
  env.KYLE_PASSWORD_VERIFIER = verifier('synthetic-new-owner');
  env.YEELAM_PASSWORD_VERIFIER = verifier('synthetic-new-guest');
  assert.equal((await login('Kyle', env.SITE_PASSWORD)).status, 401);
  assert.equal((await login('Kyle', 'synthetic-new-guest')).status, 401);
  assert.equal((await login('Yeelam', 'synthetic-new-owner')).status, 401);
  assert.equal((await login('Kyle', 'synthetic-new-owner')).status, 200);
  assert.equal((await login('Yeelam', 'synthetic-new-guest')).status, 200);
  const upgrade = await worker.fetch(new Request(`${BASE}/auth/upgrade`, {
    method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${old.sessionId}` }
  }), env);
  assert.equal(upgrade.status, 401);
  env.KYLE_PASSWORD_VERIFIER = 'invalid';
  assert.equal((await login('Kyle', env.SITE_PASSWORD)).status, 401, 'invalid verifier cannot fall back to old password');
});

test('deployment requires both protected passwords before any secret write and never logs verifiers', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8');
  const section = workflow.split('      - name: Configure isolated account password secrets\n')[1].split('      - name: Deploy Worker\n')[0];
  const code = section.split("node --input-type=module <<'NODE'\n")[1].split('          NODE')[0]
    .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
    .replace("import { pbkdf2Sync } from 'node:crypto';", '');
  const execute = new (Object.getPrototypeOf(async function(){}).constructor)('pbkdf2Sync', 'process', 'fetch', 'console', code);
  let writes = 0;
  const logged = [];
  const sink = { log: value => logged.push(value) };
  await assert.rejects(execute(pbkdf2Sync, { env: { KYLE_SITE_PASSWORD: 'synthetic-owner' } }, async () => { writes++; }, sink), /YEELAM_SITE_PASSWORD/);
  assert.equal(writes, 0);
  await execute(pbkdf2Sync, { env: { KYLE_SITE_PASSWORD: 'synthetic-owner', YEELAM_SITE_PASSWORD: 'synthetic-guest', CLOUDFLARE_API_TOKEN: 'synthetic-cloud-token' } }, async (url, init) => {
    writes++;
    assert.match(url, /\/workers\/scripts\/snowy-cake-a0a7\/secrets$/);
    const body = JSON.parse(init.body);
    const [method, iterations, salt, derived] = body.text.split(':');
    assert.equal(method, 'pbkdf2-sha256');
    const password = body.name === 'KYLE_PASSWORD_VERIFIER' ? 'synthetic-owner' : 'synthetic-guest';
    assert.equal(derived, pbkdf2Sync(password, Buffer.from(salt, 'hex'), Number(iterations), 32, 'sha256').toString('hex'));
    return Response.json({ success: true });
  }, sink);
  assert.equal(writes, 2);
  assert.doesNotMatch(logged.join('\n'), /synthetic-|pbkdf2|[a-f0-9]{32}/);
});

test('account subject profiles isolate M2 and physics materials while preserving mathematics', async t => {
  const salt = 'abcdef0123456789abcdef0123456789';
  const guestVerifier = `pbkdf2-sha256:100000:${salt}:${pbkdf2Sync('synthetic-guest',Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`;
  const env = { ...aiEnv, SESSIONS:new MemoryKV(), SESSION_SECRET:SECRET, SITE_PASSWORD:'synthetic-owner', YEELAM_PASSWORD_VERIFIER:guestVerifier, GITHUB_TOKEN:'subject-profile-token' };
  const allCodes = ['chem','bio','math','m2','physics'];
  const subjects = Object.fromEntries(allCodes.map(code => [code,{ name:globalThis.DSESubjects.names[code],topics:[{code:'U1',name:'合成課題'}],items:[{...aiItem,id:code+'-question',topic:'U1',year:'2024',figures:[{path:'images/'+code+'-2024-fig-synthetic.jpg'}]}] }]));
  const rawBank = { subjects }, seen = [], original = globalThis.fetch, sha = 'a'.repeat(64), version = sha.slice(0,16);
  globalThis.fetch = async (input,init={}) => {
    const url=String(input);
    if(url.endsWith('/user')) return Response.json({login:'Makise-Kurisu-D'});
    if(url==='https://ai.example/v1/chat/completions') return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture('合成答案'))}}]});
    seen.push(url);
    if(url.endsWith('/question-bank/bank.json')) return Response.json({encoding:'base64',content:b64json(rawBank)});
    if(url.endsWith('/papers/catalog.json')) return Response.json({encoding:'base64',content:b64json({subjects:Object.fromEntries(allCodes.map(code=>[code,['2024']]))})});
    if(url.endsWith('/manifest.json')) return Response.json({encoding:'base64',content:b64json({version,source_sha256:sha,pages:1,format:'jpeg',dpi:200,quality:85})});
    if(url.endsWith('.jpg')) return Response.json({encoding:'base64',content:btoa(String.fromCharCode(255,216,255,217))});
    throw new Error('Unexpected subject fixture URL');
  };
  t.after(()=>{globalThis.fetch=original;});
  const login=async(username,password)=>{
    const response=await worker.fetch(new Request(BASE+'/auth/password',{method:'POST',headers:{Origin:ORIGIN},body:JSON.stringify({username,password})}),env);
    assert.equal(response.status,200);return (await response.json()).sessionId;
  };
  const owner=await login('Kyle','synthetic-owner'),guest=await login('Yeelam','synthetic-guest');
  const call=(session,path,method='GET',body)=>worker.fetch(new Request(BASE+path,{method,headers:{Origin:ORIGIN,Authorization:'Bearer '+session,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
  const guestBank=await (await call(guest,'/bank')).json();
  const ownerBank=await (await call(owner,'/bank')).json();
  assert.deepEqual(Object.keys(guestBank.subjects),['math','m2','physics']);
  assert.deepEqual(Object.keys(ownerBank.subjects),['chem','bio','math']);
  assert.deepEqual(guestBank.subjects.math,subjects.math);
  assert.deepEqual(ownerBank.subjects.chem,subjects.chem);
  assert.deepEqual(ownerBank.subjects.bio,subjects.bio);
  assert.deepEqual(ownerBank.subjects.math,subjects.math);
  assert.deepEqual(Object.keys((await (await call(guest,'/papers/catalog')).json()).subjects),['math','m2','physics']);
  for (const code of ['m2','physics']) {
    assert.equal((await call(guest,'/bank/images/'+code+'-2024-fig-synthetic.jpg')).status,200);
    assert.equal((await call(guest,'/papers/'+code+'/2024/manifest')).status,200);
    assert.equal((await call(guest,'/papers/'+code+'/2024/pages/'+version+'/1')).status,200);
    for(const key of env.SESSIONS.values.keys()) if(key.startsWith('ai-limit:')) await env.SESSIONS.delete(key);
    assert.equal((await call(guest,'/ai/review','POST',{questionId:code+'-question',answer:'合成答案'})).status,200);
  }
  const before=seen.length;
  for (const [session,codes] of [[guest,['chem','bio']],[owner,['m2','physics']]]) {
    for(const code of codes) {
      assert.equal((await call(session,'/bank/images/'+code+'-2024-fig-synthetic.jpg')).status,404);
      assert.equal((await call(session,'/papers/'+code+'/2024/manifest')).status,404);
    }
  }
  assert.equal(seen.length,before,'disabled subject routes never reach storage');
  assert.ok(seen.filter(url=>/m2|physics/.test(url)).every(url=>url.includes('/users/yeelam/')));
});

test('fallback requires independent complete HTTPS settings and never reveals either credential', () => {
  const env={DEEPSEEK_API_KEY:'private-primary',AI_FALLBACK_BASE_URL:'https://backup.example/v1',AI_FALLBACK_MODEL:'backup'};
  assert.equal(aiConfiguration(env).fallbackConfigured,false);
  const configured=aiConfiguration({...env,AI_FALLBACK_API_KEY:'private-backup'});
  assert.equal(configured.fallbackConfigured,true);assert.equal(configured.fallbackModel,'backup');
  assert.doesNotMatch(JSON.stringify(configured),/private-primary|private-backup/);
  assert.equal(aiConfiguration({...env,AI_FALLBACK_API_KEY:'private-backup',AI_FALLBACK_BASE_URL:'http://localhost:5918'}).fallbackConfigured,false);
});

test('provider failures switch once, isolate keys and omit images unsupported by the fallback', async () => {
  const env={DEEPSEEK_API_KEY:'failover-primary-one',AI_VISION:'true',AI_FALLBACK_BASE_URL:'https://backup.example/v1',AI_FALLBACK_MODEL:'backup',AI_FALLBACK_API_KEY:'failover-backup-one'};
  const calls=[],item={...aiItem,figures:[{path:'private.jpg'}]};
  const fetcher=async(url,init)=>{
    calls.push(url);const payload=JSON.parse(init.body);
    if(url.startsWith('https://api.deepseek.com')) {assert.equal(init.headers.authorization,'Bearer failover-primary-one');return new Response('',{status:503});}
    assert.equal(init.headers.authorization,'Bearer failover-backup-one');
    assert.doesNotMatch(init.body,/data:image/);assert.equal(payload.model,'backup');
    return Response.json({model:'backup',choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture('原答'))}}]});
  };
  const out=await requestAIFeedback(item,{answer:'原答'},env,['data:image/jpeg;base64,private'],fetcher);
  assert.equal(out.failover,true);assert.equal(out.failoverReason,'ai_provider_error');assert.match(out.materialNotes,/圖表未送入/);
  assert.equal(calls.length,2);
  const next=await requestAIFeedback(item,{answer:'原答'},env,[],fetcher);
  assert.equal(next.failoverReason,'ai_circuit_open');assert.equal(calls.length,3);
});

test('invalid grading evidence never switches providers, while network errors do', async () => {
  const env={DEEPSEEK_API_KEY:'evidence-primary',AI_FALLBACK_BASE_URL:'https://backup.example/v1',AI_FALLBACK_MODEL:'backup',AI_FALLBACK_API_KEY:'evidence-backup'};
  let calls=0;
  await assert.rejects(requestAIFeedback(aiItem,{answer:'真正原答'},env,[],async()=>{
    calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture('虛構原答'))}}]});
  }),/ai_invalid_evidence/);
  assert.equal(calls,1);
  const out=await requestAIFeedback(aiItem,{answer:'真正原答'},env,[],async(url)=>{
    calls++;if(url.startsWith('https://api.deepseek.com'))throw new TypeError('fetch failed');
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(aiFixture('真正原答'))}}]});
  });
  assert.equal(out.failover,true);assert.equal(out.failoverReason,'ai_network_error');assert.equal(calls,3);
});

test('provider diagnostics distinguish auth, balance, rate limiting and request rejection without raw errors', async () => {
  for(const [status,code] of [[401,'ai_auth_error'],[403,'ai_auth_error'],[402,'ai_balance_exhausted'],[429,'ai_provider_busy'],[400,'ai_request_rejected']]) {
    await assert.rejects(requestAIFeedback(aiItem,{answer:'原答'},aiEnv,[],async()=>new Response('PRIVATE_PROVIDER_DIAGNOSTIC',{status})),new RegExp('^Error: '+code+'$'));
  }
  const env={...aiEnv,AI_FALLBACK_BASE_URL:'https://backup.example/v1',AI_FALLBACK_MODEL:'backup',AI_FALLBACK_API_KEY:'all-down-backup'};
  let calls=0;
  await assert.rejects(requestAIFeedback(aiItem,{answer:'原答'},env,[],async()=>{calls++;return new Response('',{status:503});}),/ai_provider_error/);
  assert.equal(calls,2,'one attempt per provider, never a retry loop');
});

test('step drafts merge without losing legacy answers and completed-draft tombstones clear both forms', () => {
  const base={app:'kyle-dse-quiz',cycle:'1',sessions:[],drafts:{session:{text:{q:'舊草稿'},steps:{q:{mode:'steps',assisted:true,rows:[{prompt:'下一步',answer:'舊草稿'}]}},changedAt:{'text:q':10,'steps:q':10}}}};
  const incoming={...base,drafts:{session:{text:{q:'新草稿'},steps:{q:{mode:'text',assisted:true,rows:[]}},changedAt:{'text:q':20,'steps:q':20}}}};
  const merged=mergeBackup(base,incoming).drafts.session;
  assert.equal(merged.text.q,'新草稿');assert.equal(merged.steps.q.mode,'text');
  const cleared=mergeBackup(base,{...base,drafts:{session:{deletedAt:30}}}).drafts.session;
  assert.deepEqual(cleared.text,{});assert.deepEqual(cleared.steps,{});
});

test('AI probe performs real synthetic generation without reading a bank or writing practice records', async t => {
  const original=globalThis.fetch;let providerCalls=0;
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/user'))return Response.json({login:'Makise-Kurisu-D'});
    assert.equal(url,'https://ai.example/v1/chat/completions');providerCalls++;
    const task=JSON.parse(JSON.parse(init.body).messages.at(-1).content);
    assert.equal(task.materials.questionId,'service-probe');assert.equal(task.mode,'review');
    const fixture={summary:'成功',points:task.materials.checks.map(c=>({index:c.index,status:'hit',evidence:task.studentAnswer,reason:'符合合成核對點',suggestion:''})),tags:[],reply:'合成測試',uncertainty:''};
    return Response.json({model:'synthetic-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(fixture)}}]});
  };t.after(()=>{globalThis.fetch=original;});
  const env={...aiEnv,SESSIONS:new MemoryKV(),SESSION_SECRET:SECRET,SITE_PASSWORD:'probe-password',GITHUB_TOKEN:'probe-only-token'};
  const login=await worker.fetch(new Request(BASE+'/auth/password',{method:'POST',headers:{Origin:ORIGIN},body:JSON.stringify({password:'probe-password'})}),env);
  const session=(await login.json()).sessionId,headers={Origin:ORIGIN,Authorization:'Bearer '+session};
  const probe=()=>worker.fetch(new Request(BASE+'/ai/probe',{method:'POST',headers,body:'{}'}),env);
  const result=await probe();assert.equal(result.status,200);assert.equal((await result.json()).ok,true);assert.equal(providerCalls,1);
  assert.equal((await probe()).status,429);assert.equal(providerCalls,1);
  assert.equal((await worker.fetch(new Request(BASE+'/ai/probe',{method:'POST',headers:{Origin:ORIGIN}}),env)).status,401);
  assert.equal([...env.SESSIONS.values.keys()].some(k=>k.includes('records')),false);
});


test('named papers of the same year use exact catalog membership and preserve account isolation', async t => {
  const original = globalThis.fetch, paths = [];
  const password = 'synthetic-named-guest';
  const salt = '1123456789abcdef0123456789abcdef';
  const verifier = `pbkdf2-sha256:100000:${salt}:${pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex')}`;
  const env = { SESSIONS: new MemoryKV(), SESSION_SECRET: SECRET, SITE_PASSWORD: 'named-owner-password',
    YEELAM_PASSWORD_VERIFIER: verifier, GITHUB_TOKEN: 'named-paper-fixture-token' };
  const identities = ['', 'publisher-2025-mock9-p1', 'publisher-2025-mock10-p1'];
  const shaFor = id => (id.includes('mock10') ? 'b' : id ? 'c' : 'd').repeat(64);
  const catalog = { subjects: { chem: [], bio: [], math: ['2025'], m2: [], physics: [] },
    entries: identities.map(id => ({ subject: 'math', year: '2025', paper_id: id, title: id || 'Legacy paper', pages: 1, source_sha256: shaFor(id) })) };
  globalThis.fetch = async input => {
    const url = String(input); paths.push(url);
    if (url.endsWith('/user')) return Response.json({ login: 'Makise-Kurisu-D' });
    if (url.endsWith('/papers/catalog.json')) return Response.json({ encoding: 'base64', content: b64json(catalog) });
    const named = url.match(/\/papers\/math\/2025(?:\/(publisher-2025-mock(?:9|10)-p1))?\/manifest.json$/);
    if (named) {
      const id = named[1] || '', sha = shaFor(id);
      return Response.json({ encoding: 'base64', content: b64json({ version: sha.slice(0, 16), source_sha256: sha,
        pages: 1, format: 'jpeg', dpi: 200, quality: 85, ...(id ? { paper_id: id } : {}) }) });
    }
    if (url.endsWith('.jpg')) return Response.json({ encoding: 'base64', content: btoa(String.fromCharCode(255, 216, 255, 217)) });
    throw new Error('Unexpected fixture path ' + url);
  };
  t.after(() => { globalThis.fetch = original; });
  for (const [account, pass] of [['kyle', env.SITE_PASSWORD], ['yeelam', password]]) {
    const login = await worker.fetch(new Request(BASE + '/auth/password', { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({ username: account, password: pass }) }), env);
    assert.equal(login.status, 200);
    const headers = { Origin: ORIGIN, Authorization: 'Bearer ' + (await login.json()).sessionId };
    const call = path => worker.fetch(new Request(BASE + path, { headers }), env);
    const before = paths.length;
    const published = await (await call('/papers/catalog')).json();
    assert.equal(published.entries.length, 3);
    for (const id of identities) {
      const base = '/papers/math/2025' + (id ? '/' + id : '');
      const manifest = await (await call(base + '/manifest')).json();
      assert.equal(manifest.source_sha256, shaFor(id));
      assert.equal((await call(base + '/pages/' + shaFor(id).slice(0, 16) + '/1')).status, 200);
    }
    const contents = paths.slice(before).filter(url => url.includes('/contents/'));
    assert.ok(contents.length > 0);
    assert.ok(contents.every(url => account === 'yeelam' ? url.includes('/contents/users/yeelam/') : !url.includes('/contents/users/')));
    const deniedBefore = paths.filter(url => url.includes('/contents/')).length;
    assert.equal((await call('/papers/math/2025/unknown-p1/manifest')).status, 404);
    assert.equal((await call('/papers/math/2025/Bad_ID/manifest')).status, 404);
    assert.equal(paths.filter(url => url.includes('/contents/')).length, deniedBefore, 'unknown identities cannot read private files');
  }
});
