/* Appearance is independent of the bank, router and exercise state. */
(function () {
  'use strict';
  var root = document.documentElement;
  var viewKey = 'dse_visual_view_v1', themeKey = 'dse_visual_theme_v1';
  var view = 'full', override = null, timer;
  var offset = 8 * 3600000, day = 86400000;
  function read(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  function scheduled(date) {
    var hour = new Date(Number(date) + offset).getUTCHours();
    return hour >= 7 && hour < 19 ? 'day' : 'night';
  }
  function boundary(now) {
    var local = now + offset, start = Math.floor(local / day) * day;
    var hour = new Date(local).getUTCHours();
    return start + (hour < 7 ? 7 : hour < 19 ? 19 : 31) * 3600000 - offset;
  }
  function load() {
    view = read(viewKey) === 'simple' ? 'simple' : 'full';
    try { override = JSON.parse(read(themeKey)); } catch (_) { override = null; }
  }
  function apply() {
    var now = Date.now();
    if (!override || !Number.isFinite(override.until) || override.until <= now ||
        override.until > boundary(now) || ['day', 'night'].indexOf(override.theme) < 0) override = null;
    var theme = override ? override.theme : scheduled(now);
    root.dataset.theme = theme;
    root.dataset.appearance = view;
    root.style.colorScheme = theme === 'night' ? 'dark' : 'light';
    document.querySelectorAll('[data-appearance-choice]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.appearanceChoice === view));
    });
    var button = document.getElementById('dayNightToggle');
    if (button) {
      var action = theme === 'day' ? '切換至夜晚模式' : '切換至日間模式';
      button.setAttribute('aria-label', action);
      button.title = action + '；手動選擇保留至下一個北京時間 07:00／19:00';
      button.dataset.icon = theme === 'day' ? 'moon' : 'sun';
    }
    var clock = document.getElementById('appearanceClock');
    if (clock) {
      var date = new Date(now + offset), pad = function (n) { return String(n).padStart(2, '0'); };
      clock.textContent = '北京時間 ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes());
      clock.title = (override ? '手動模式，下一個日夜分界自動恢復。' : '自動日夜模式。') + '07:00–19:00 日間，其餘夜晚。';
    }
    clearTimeout(timer);
    timer = setTimeout(apply, Math.min(30000, boundary(now) - now));
  }
  function setView(next) {
    if (next !== 'full' && next !== 'simple') return;
    view = next; write(viewKey, next); apply();
    announce(next === 'simple' ? '已切換至精簡無障礙版' : '已切換至完整版');
  }
  function announce(message) {
    var status = document.getElementById('appearanceStatus');
    if (status) status.textContent = message;
  }
  function toggle() {
    override = { theme: root.dataset.theme === 'day' ? 'night' : 'day', until: boundary(Date.now()) };
    write(themeKey, JSON.stringify(override)); apply();
    announce((override.theme === 'day' ? '已切換至日間模式' : '已切換至夜晚模式') + '，下次北京時間日夜分界恢復自動切換');
  }
  function routeLabel() {
    var part = location.hash.replace(/^#\/?/, '').split('/')[0];
    var title = { practice: ['TOPICS', '課題練習'], session: ['STUDY', '專注練習'], records: ['RECORDS', '練習記錄'],
      random: ['RANDOM', '隨機十題'], library: location.hash.indexOf('/papers') >= 0 ? ['PAPERS', '紅筆批改卷'] : ['ARCHIVE', '錯題庫與歸納'] }[part] || ['HOME', '學習主頁'];
    var heading = document.getElementById('shellHeading');
    if (heading) { heading.querySelector('b').textContent = title[0]; heading.querySelector('span').textContent = title[1]; }
    document.body.dataset.view = part || 'home';
    document.body.dataset.library = part === 'library' ? location.hash.split('?')[0].split('/')[2] || '' : '';
    document.querySelectorAll('.rail-item[data-route],.tab-item[data-route]').forEach(function (link) {
      var active = link.dataset.route === (part === 'library' && location.hash.indexOf('/papers') >= 0 ? 'papers' : part || 'home');
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
  }
  function ready() {
    document.querySelectorAll('[data-appearance-choice]').forEach(function (button) {
      button.addEventListener('click', function () { setView(button.dataset.appearanceChoice); });
    });
    document.getElementById('dayNightToggle').addEventListener('click', toggle);
    document.getElementById('skipLink').addEventListener('click', function (event) { event.preventDefault(); document.getElementById('app').focus(); });
    apply(); routeLabel();
  }
  window.DSEAppearance = { scheduled: scheduled, boundary: boundary, apply: apply, setView: setView, toggle: toggle };
  load(); apply();
  document.addEventListener('DOMContentLoaded', ready);
  addEventListener('hashchange', function () {
    routeLabel();
    requestAnimationFrame(function () {
      var main = document.getElementById('app');
      if (main) main.focus({ preventScroll: true });
    });
  });
  addEventListener('pageshow', apply);
  addEventListener('focus', apply);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) apply(); });
  addEventListener('storage', function (event) {
    if (event.key === null || event.key === viewKey || event.key === themeKey) { load(); apply(); }
  });
}());
