import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const context = { Date, window: {} };
vm.createContext(context);
vm.runInContext(readFileSync(new URL('./library.js', import.meta.url), 'utf8'), context);
const library = context.window.DSELibrary;
const right = { ok: true, marks: 3, tot: 3 };
const wrong = { ok: false, marks: 2, tot: 3 };
const exercise = (t, results) => ({ t, subj: 'chem', topic: 'T1', results });

test('mastery requires two distinct submitted exercises, survives archives, and regresses after any non-full answer', () => {
  const first = exercise(1, { q: right });
  assert.equal(library.indexHistory([first]).q.state, 'learning');
  const second = exercise(2, { q: right });
  assert.equal(library.indexHistory([second, first]).q.state, 'mastered');
  assert.equal(library.indexHistory([first, second, exercise(3, { q: wrong })]).q.state, 'regressed');
  assert.equal(library.indexHistory([first, second, exercise(3, { q: wrong }), exercise(4, { q: right })]).q.state, 'learning');
  assert.equal(library.indexHistory([exercise(1, { q: wrong })]).q.state, 'wrong');
  assert.equal(library.full({ ok: true, marks: 299, tot: 300 }), false, 'almost-full marks are not full marks');
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
    library.indexHistory([exercise(1, { a: right }), exercise(2, { a: right, b: wrong })]));
  assert.equal(stats.total, 3);
  assert.equal(stats.mastered, 1);
  assert.equal(stats.wrong, 1);
  assert.equal(stats.unseen, 1);
  assert.equal(stats.lost, 3);
  assert.equal(stats.lostKnown, 2);
});
