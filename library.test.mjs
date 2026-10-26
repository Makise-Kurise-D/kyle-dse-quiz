import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const context = { Date, window: {} };
vm.createContext(context);
vm.runInContext(readFileSync(new URL('./subject-config.js', import.meta.url), 'utf8'), context);
vm.runInContext(readFileSync(new URL('./library.js', import.meta.url), 'utf8'), context);
const library = context.window.DSELibrary;
const right = { ok: true, marks: 3, tot: 3 };
const wrong = { ok: false, marks: 2, tot: 3 };
const exercise = (t, results) => ({ t, subj: 'chem', topic: 'T1', results });
const verifiedExercise = (t, results, options = {}) => exercise(t, Object.fromEntries(Object.entries(results).map(([id, result]) => {
  const copy = { ...result }, item = { id, kind:'sub', marks:result.tot, stem:'合成題', checks:['合成核對點'] };
  copy.attempt = library.attemptSnapshot(item, '學生原答', [0], copy, t, options);
  return [id, copy];
})));

test('daily review orders due, regression and repeated errors without counting replayed submissions', () => {
  const now = Date.now(), days = 864e5;
  const data = { subjects: { chem: { items: [
    { id: 'due', lost: 1 }, { id: 'repeat', lost: 2 }, { id: 'new', lost: 9 }
  ] }, bio: { items: [{ id: 'back', lost: 1 }, { id: 'due', lost: 99 }] } } };
  const history = [exercise(now-days*3, { back:right, repeat:wrong }),
    exercise(now-days*2, { back:right, repeat:wrong }), exercise(now-days, { back:wrong })];
  history.push(history[1]);
  const rows = library.dailyCandidates(data, history, { due:{dueAt:now-1} }, 'all', now);
  assert.deepEqual(Array.from(rows, r=>r.item.id), ['due','back','repeat','new']);
  assert.equal(rows[2].failures, 2);
  assert.equal(new Set(rows.map(r=>r.item.id)).size, rows.length);
  assert.deepEqual(Array.from(library.dailyCandidates(data, history, {}, 'bio', now),r=>r.item.id), ['back','due']);
});

test('daily due dates follow the Beijing calendar, including the rest of today', () => {
  const now=Date.UTC(2026,9,19,15,30), data={subjects:{chem:{items:[{id:'today'},{id:'tomorrow'}]}}};
  const rows=library.dailyCandidates(data,[],{today:{dueAt:Date.UTC(2026,9,19,15,59)},tomorrow:{dueAt:Date.UTC(2026,9,19,16)}},'all',now);
  assert.equal(rows.find(r=>r.item.id==='today').due,true);
  assert.equal(rows.find(r=>r.item.id==='tomorrow').due,false);
});

test('global search covers subjects, topics, original answers, deductions and marking checks with filters',()=>{
  const item={id:'sample-1',qref:'Q7(b)',topic:'T1',year:'2022',kind:'sub',stem:'合成題',my:[['原答案的獨有詞',true]],deduct:'漏掉必要條件',checks:['向低濃度移動'],correct:'參考解析'};
  const data={subjects:{chem:{topics:[{code:'T1',name:'運輸課題'}],items:[item]},bio:{topics:[{code:'I',name:'另一課題'}],items:[{...item,id:'sample-2',topic:'I'}]}}};
  const normalize=s=>String(s).replaceAll('输','輸').replaceAll('浓','濃').replaceAll('条','條').replaceAll('参','參');
  const f={query:'',subject:'',year:'',kind:'',status:'',tag:''},search=patch=>library.searchRows(data,{'sample-2':{state:'regressed'}},{...f,...patch},normalize,id=>id==='sample-2'?['概念混淆']:[]);
  assert.equal(search({query:'低浓度'}).length,2);assert.equal(search({query:'原答案的獨有詞'}).length,2);assert.equal(search({query:'必要条件'}).length,2);
  assert.equal(search({query:'運输課題'}).length,1);assert.equal(search({query:'Q7(b) 參考'}).length,2);
  assert.equal(search({subject:'bio',year:'2022',kind:'sub',status:'regressed',tag:'概念混淆'}).length,1);
  assert.equal(search({query:'不存在詞'}).length,0);assert.equal(search({kind:'mc'}).length,0);
});

test('global search distinguishes an unloaded private bank from zero matches',()=>{
  const root={innerHTML:''};library.reset();library.render(['search'],{root,history:[],loaded:false,data:{subjects:{}}});
  assert.match(root.innerHTML,/題庫尚未載入/);assert.doesNotMatch(root.innerHTML,/沒有匹配結果/);
});

test('reading position belongs to the content pane, not the fixed document', () => {
  library.reset();
  const pane = { scrollTop: 0 }, root = { innerHTML: '' }, frames = [];
  const api = { root, scrollRoot: pane, history: [], data: { subjects: {
    bio: { items: [], topics: [] }, chem: { items: [], topics: [] }
  } } };
  context.window.scrollY = 999;
  context.window.requestAnimationFrame = fn => frames.push(fn);
  library.render([], api);
  pane.scrollTop = 340;
  library.remember();
  pane.scrollTop = 0;
  library.render([], api);
  frames.shift()();
  assert.equal(pane.scrollTop, 340);
  assert.equal(context.window.scrollY, 999);
  library.remember();
  pane.scrollTop = 0;
  library.render([], api);
  library.reset();
  frames.shift()();
  assert.equal(pane.scrollTop, 0, 'a stale restoration cannot scroll a different route');
});

test('mastery requires saved independent evidence and a due spaced review, then regresses after a non-full answer', () => {
  const day = 864e5;
  const first = verifiedExercise(1, { q: right }, {nextReviewAt:15*day+1});
  assert.equal(library.indexHistory([first]).q.state, 'learning');
  assert.equal(library.indexHistory([first, verifiedExercise(2, {q:right})]).q.state, 'learning', 'an immediate repeat is not consolidation');
  assert.equal(library.indexHistory([first, verifiedExercise(day+1, {q:right})]).q.state, 'learning', 'the review must also be due');
  const second = verifiedExercise(15*day+1, { q: right });
  assert.equal(library.indexHistory([second, first]).q.state, 'mastered');
  assert.equal(library.indexHistory([first, second, exercise(16*day, { q: wrong })]).q.state, 'regressed');
  assert.equal(library.indexHistory([first, second, exercise(16*day, { q: wrong }), verifiedExercise(17*day, { q: right })]).q.state, 'learning');
  assert.equal(library.indexHistory([exercise(1, { q: wrong })]).q.state, 'wrong');
  assert.equal(library.full({ ok: true, marks: 299, tot: 300 }), false, 'almost-full marks are not full marks');
  assert.equal(library.indexHistory([exercise(1,{q:right}),exercise(20*day,{q:right})]).q.state,'learning','legacy scores do not invent original-answer evidence');
  assert.equal(library.indexHistory([first,verifiedExercise(20*day,{q:right},{assisted:true})]).q.state,'learning');
  assert.equal(library.indexHistory([first,verifiedExercise(20*day,{q:right},{onPaper:true})]).q.state,'learning');
  const changed=verifiedExercise(20*day,{q:right});changed.results.q.attempt.questionVersion='changed';
  assert.equal(library.indexHistory([first,changed]).q.state,'learning','different question versions require new evidence');
});

test('duplicate sync and archive copies never manufacture mastery, and conflicting copies fail conservatively', () => {
  const one = exercise(1, { q: right });
  const duplicate = JSON.parse(JSON.stringify(one));
  const combined = library.indexHistory([one, duplicate]);
  assert.equal(combined.q.attempts, 1);
  assert.equal(combined.q.state, 'learning');
  assert.equal(library.indexHistory([one, exercise(1, { q: wrong })]).q.state, 'wrong');
  assert.equal(library.indexHistory([exercise(1, { q: wrong }), one]).q.state, 'wrong');
  assert.equal(library.indexHistory([null, {}, exercise(Date.now() + 100000, { q: right })]).q, undefined);
});

test('summary counts cards once and never substitutes question maximum for original lost marks', () => {
  const stats = library.summarize([{ id: 'a', lost: 1 }, { id: 'b', tot: 12 }, { id: 'c', lost: 2 }],
    library.indexHistory([verifiedExercise(1, { a: right }), verifiedExercise(864e5+1, { a: right, b: wrong })]));
  assert.equal(stats.total, 3);
  assert.equal(stats.mastered, 1);
  assert.equal(stats.wrong, 1);
  assert.equal(stats.unseen, 1);
  assert.equal(stats.lost, 3);
  assert.equal(stats.lostKnown, 2);
});

test('a one-mark checklist cannot produce a full score by rounding half its descriptions',()=>{
  const item={id:'one-mark',kind:'sub',marks:1,checks:['比較單位成本','選擇正確方法']};
  assert.equal(library.practiceScore(item,[0],null),null);
  assert.equal(library.practiceScore(item,[0],0),0);
  assert.equal(library.practiceScore(item,[0],1),1,'a score without reviewed groups is an explicit human assessment');
  assert.equal(library.practiceScore(item,[0],1.1),null);
  item.practiceRubric={version:1,groups:[{id:'correct-selection',marks:1,all:[1]}]};
  assert.equal(library.practiceScore(item,[0],null),0);
  assert.equal(library.practiceScore(item,[1],null),1);
});

test('reviewed scoring groups preserve independent marks, required conditions and alternative answers',()=>{
  const item={marks:3,checks:['方法','條件','替代甲','替代乙','✗提醒'],practiceRubric:{version:1,groups:[
    {id:'method',marks:1,condition:{all:[0,1]}},
    {id:'answer',marks:2,condition:{any:[2,3]}}
  ]}};
  assert.equal(library.practiceScore(item,[0,2],null),2);
  assert.equal(library.practiceScore(item,[0,1,3,4],null),3);
  assert.equal(library.practiceScore(item,[2,3],null),2,'alternatives never count twice');
  item.practiceRubric.groups[0].condition={all:[4]};
  assert.equal(library.practiceRubric(item),null,'a warning cannot become a scoring condition');
  item.practiceRubric.groups[0].condition={all:[0,1]};item.practiceRubric.groups[1].marks=1;
  assert.equal(library.practiceRubric(item),null,'group maxima must match the actual maximum');
});

test('attempt snapshots preserve submitted text, selections and source versions without retaining a mutable draft or bank',()=>{
  const item={id:'snapshot',kind:'sub',marks:1,stem:'PRIVATE_QUESTION',correct:'PRIVATE_REFERENCE',checks:['point'],source_sha256:'a'.repeat(64)};
  const checked=[0],score={marks:1,tot:1,ok:true};
  const snapshot=library.attemptSnapshot(item,'原答 <script>\n第二行',checked,score,123,{nextReviewAt:456});
  checked.length=0;item.checks[0]='changed';score.marks=0;
  assert.equal(snapshot.answer,'原答 <script>\n第二行');assert.deepEqual(Array.from(snapshot.checkedIndices),[0]);
  assert.equal(snapshot.marks,1);assert.equal(snapshot.sourceSha256,'a'.repeat(64));
  assert.equal(snapshot.nextReviewAt,456);assert.equal(snapshot.rubricVersion,'manual-v1');
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_QUESTION|PRIVATE_REFERENCE/);
});
