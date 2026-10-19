import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./appearance.js', import.meta.url), 'utf8');
const viewKey = 'dse_visual_view_v1', themeKey = 'dse_visual_theme_v1';
function boot(time, initial = {}, blocked = false) {
  let now = Date.parse(time);
  const saved = new Map(Object.entries(initial)), events = {}, timers = [];
  const root = { dataset: {}, style: {} };
  const world = { dataset: {} };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    Date: Clock, document: { documentElement: root, getElementById(id) { return id === 'visualWorld' ? world : null; }, querySelectorAll() { return []; }, addEventListener() {} },
    localStorage: {
      getItem(key) { if (blocked) throw new Error('storage unavailable'); return saved.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw new Error('storage unavailable'); saved.set(key, value); }
    },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    addEventListener(type, fn) { events[type] = fn; }
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(source, context);
  return { api: context.DSEAppearance, root, world, saved, events, timers, at(time) { now = Date.parse(time); } };
}

test('archive world follows the current home theme through manual and automatic changes', () => {
  const app = boot('2026-10-18T01:00:00Z');
  assert.equal(app.world.dataset.theme, 'day');
  app.api.toggle();
  assert.equal(app.root.dataset.theme, 'night');
  assert.equal(app.world.dataset.theme, 'night');
  app.api.toggle();
  assert.equal(app.world.dataset.theme, 'day');
  app.at('2026-10-18T11:00:00Z'); app.api.apply();
  assert.equal(app.world.dataset.theme, 'night');
});

test('Beijing schedule changes at exactly 07:00 and 19:00 regardless of host time zone', () => {
  const { api } = boot('2026-10-18T00:00:00Z');
  for (const [time, expected] of [
    ['2026-10-17T22:59:59.999Z', 'night'], ['2026-10-17T23:00:00Z', 'day'],
    ['2026-10-18T10:59:59.999Z', 'day'], ['2026-10-18T11:00:00Z', 'night'],
    ['2026-10-18T16:00:00Z', 'night'], ['2026-10-18T23:00:00Z', 'day']
  ]) assert.equal(api.scheduled(new Date(time)), expected);
  assert.equal(api.boundary(Date.parse('2026-10-18T12:00:00Z')), Date.parse('2026-10-18T23:00:00Z'));
});

test('manual choice survives navigation and reload, then resumes automatic switching at the next boundary', () => {
  const app = boot('2026-10-17T22:59:59.990Z');
  assert.equal(app.root.dataset.theme, 'night');
  app.api.toggle();
  assert.equal(app.root.dataset.theme, 'day');
  assert.equal(app.timers.at(-1).delay, 10, 'wake at the boundary instead of waiting a polling interval');
  const reload = boot('2026-10-17T22:59:59.995Z', Object.fromEntries(app.saved));
  assert.equal(reload.root.dataset.theme, 'day', 'correct appearance is set before DOMContentLoaded');
  reload.at('2026-10-17T23:00:00Z'); reload.events.focus();
  assert.equal(reload.root.dataset.theme, 'day');
  reload.api.toggle(); assert.equal(reload.root.dataset.theme, 'night');
  reload.at('2026-10-18T11:00:00Z'); reload.api.apply();
  assert.equal(reload.root.dataset.theme, 'night');
  reload.at('2026-10-18T23:00:00Z'); reload.api.apply();
  assert.equal(reload.root.dataset.theme, 'day', 'expired manual override does not return the next day');
});

test('version and theme changes only write appearance preferences and preserve drafts and records', () => {
  const original = { dse_quiz_draft_v2: '{"pick":"B"}', dse_quiz_sessions_v2: '[{"id":"stable"}]' };
  const app = boot('2026-10-18T01:00:00Z', original);
  app.api.setView('simple'); app.api.toggle(); app.api.setView('full');
  for (const [key, value] of Object.entries(original)) assert.equal(app.saved.get(key), value);
  assert.equal(app.saved.get(viewKey), 'full');
  assert.equal(boot('2026-10-18T02:00:00Z', { [viewKey]: 'simple' }).root.dataset.appearance, 'simple');
});

test('blocked storage and malformed, expired, or implausible preferences have a readable scheduled fallback', () => {
  for (const value of ['{', 'null', '"pink"', '{"theme":"day","until":9999999999999}', '{"theme":"night","until":1}']) {
    assert.equal(boot('2026-10-18T01:00:00Z', { [themeKey]: value }).root.dataset.theme, 'day');
  }
  const app = boot('2026-10-18T01:00:00Z', {}, true);
  app.api.setView('simple'); app.api.toggle();
  assert.equal(app.root.dataset.appearance, 'simple'); assert.equal(app.root.dataset.theme, 'night');
});

test('another tab updates both preferences, including removal and clear events', () => {
  const app = boot('2026-10-18T01:00:00Z');
  app.saved.set(viewKey, 'simple');
  app.saved.set(themeKey, JSON.stringify({ theme: 'night', until: Date.parse('2026-10-18T11:00:00Z') }));
  app.events.storage({ key: themeKey });
  assert.equal(app.root.dataset.theme, 'night'); assert.equal(app.root.dataset.appearance, 'simple');
  app.saved.clear(); app.events.storage({ key: null });
  assert.equal(app.root.dataset.theme, 'day'); assert.equal(app.root.dataset.appearance, 'full');
});

test('sidebar collapse persists across reload and does not change appearance or exercise records', () => {
  const original = { dse_quiz_draft_v2: '{"pick":"B"}', dse_quiz_sessions_v2: '[{"id":"stable"}]' };
  const app = boot('2026-10-18T01:00:00Z', original);
  assert.equal(app.root.dataset.rail, 'expanded');
  app.api.toggleRail();
  assert.equal(app.root.dataset.rail, 'collapsed');
  assert.equal(app.saved.get('dse_visual_rail_v1'), 'collapsed');
  app.api.setView('simple'); app.api.toggle();
  assert.equal(app.root.dataset.rail, 'collapsed');
  const reload = boot('2026-10-18T02:00:00Z', Object.fromEntries(app.saved));
  assert.equal(reload.root.dataset.rail, 'collapsed');
  reload.api.toggleRail();
  assert.equal(reload.root.dataset.rail, 'expanded');
  assert.equal(reload.root.dataset.theme, 'night');
  assert.equal(reload.root.dataset.appearance, 'simple');
  for (const [key, value] of Object.entries(original)) assert.equal(reload.saved.get(key), value);
});

test('sidebar preference follows another tab and restores expanded navigation on removal', () => {
  const app = boot('2026-10-18T01:00:00Z');
  app.saved.set('dse_visual_rail_v1', 'collapsed');
  app.events.storage({ key: 'dse_visual_rail_v1' });
  assert.equal(app.root.dataset.rail, 'collapsed');
  app.saved.delete('dse_visual_rail_v1');
  app.events.storage({ key: 'dse_visual_rail_v1' });
  assert.equal(app.root.dataset.rail, 'expanded');
});

test('sidebar remains operable when preference storage is unavailable', () => {
  const app = boot('2026-10-18T01:00:00Z', {}, true);
  app.api.toggleRail();
  assert.equal(app.root.dataset.rail, 'collapsed');
  app.api.toggleRail();
  assert.equal(app.root.dataset.rail, 'expanded');
  assert.equal(boot('2026-10-18T01:00:00Z', { dse_visual_rail_v1: 'invalid' }).root.dataset.rail, 'expanded');
});
