/* Private, structured mistake library. No examination data is shipped here. */
(function (global) {
  'use strict';
  var states = [
    { key: 'unseen', label: '未複習' }, { key: 'wrong', label: '仍需複習' },
    { key: 'learning', label: '待鞏固' }, { key: 'mastered', label: '已掌握' },
    { key: 'regressed', label: '回退' }
  ];
  var labels = {}, positions = {}, filters = {}, selectedYears = {}, topicGeneration = 0, activeKey = '', context;
  var searchState = { query:'', subject:'', year:'', kind:'', status:'', tag:'', limit:20 };
  states.forEach(function (s) { labels[s.key] = s.label; });
  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function text(value) { return esc(value).replace(/\n/g, '<br>'); }
  function full(result) {
    return !!result && result.ok === true && (!result.tot ||
      (Number.isFinite(result.marks) && result.marks >= result.tot));
  }
  function independentHistory(history) {
    var grouped = new Map();
    (history || []).forEach(function (session) {
      if (!session || !Number.isFinite(session.t) || session.t > Date.now() || !session.results) return;
      var key = JSON.stringify([session.t, session.subj, session.topic]);
      var row = grouped.get(key);
      if (!row) { row = { t: session.t, subj: session.subj, topic: session.topic, results: {} }; grouped.set(key, row); }
      Object.keys(session.results).forEach(function (id) {
        var next = session.results[id];
        if (!next || typeof next.ok !== 'boolean') return;
        // Replayed/merged copies of one submitted exercise count only once.
        if (!row.results[id] || !full(next)) row.results[id] = next;
      });
    });
    return Array.from(grouped.values()).sort(function (a, b) { return a.t - b.t; });
  }
  function indexHistory(history) {
    var index = Object.create(null);
    independentHistory(history).forEach(function (session) {
      Object.keys(session.results).forEach(function (id) {
        var result = session.results[id], correct = full(result);
        var row = index[id] || { streak: 0, everCorrect: false, attempts: 0, history: [] };
        if (correct && !row.everCorrect) row.firstCorrectAt = session.t;
        row.state = correct ? (row.streak >= 1 ? 'mastered' : 'learning') :
          (row.everCorrect ? 'regressed' : 'wrong');
        row.streak = correct ? row.streak + 1 : 0;
        row.everCorrect = row.everCorrect || correct;
        row.attempts++; row.lastAt = session.t;
        row.history.push({ t: session.t, correct: correct, marks: result.marks, tot: result.tot });
        if (row.history.length > 5) row.history.shift();
        index[id] = row;
      });
    });
    return index;
  }
  function summarize(items, history) {
    var out = { total: items.length, lost: 0, lostKnown: 0, newSolved: 0, regressions: 0 };
    states.forEach(function (s) { out[s.key] = 0; });
    items.forEach(function (item) {
      var row = history[item.id]; out[row ? row.state : 'unseen']++;
      if (Number.isFinite(item.lost) && item.lost >= 0) { out.lost += item.lost; out.lostKnown++; }
    });
    return out;
  }
  function dailyCandidates(data, history, plans, code, now) {
    var index = indexHistory(history), seen = new Set(), rows = [];
    var dayEnd = Math.floor((now + 8 * 3600e3) / 864e5) * 864e5 + 864e5 - 8 * 3600e3;
    Object.keys(data.subjects).forEach(function (subject) {
      if (code !== 'all' && code !== subject) return;
      data.subjects[subject].items.forEach(function (item) {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        var row = index[item.id], plan = plans[item.id], failures = 0;
        if (row) for (var i = row.history.length - 1; i >= 0 && !row.history[i].correct; i--) failures++;
        var due = !!(plan && Number.isFinite(plan.dueAt) && plan.dueAt < dayEnd);
        var regressed = !!row && row.state === 'regressed';
        var priority = due ? 0 : regressed ? 1 : failures >= 2 ? 2 : !row || row.state === 'wrong' ? 3 : row.state === 'learning' ? 4 : 5;
        rows.push({ item: item, code: subject, due: due, priority: priority, failures: failures,
          lastAt: row ? row.lastAt : 0,
          reason: due ? '複習到期' : regressed ? '答對後回退' : failures >= 2 ? '連續答錯' : !row ? '尚未複習' : row.state === 'wrong' ? '仍需鞏固' : '間隔鞏固' });
      });
    });
    return rows.sort(function (a, b) {
      return a.priority - b.priority || b.failures - a.failures ||
        (Number.isFinite(b.item.lost) ? b.item.lost : 0) - (Number.isFinite(a.item.lost) ? a.item.lost : 0) || a.lastAt - b.lastAt || a.item.id.localeCompare(b.item.id);
    });
  }
  function badge(state) { return '<span class="ml-badge ml-' + state + '">' + labels[state] + '</span>'; }
  function bar(stats) {
    return '<div class="ml-progress" role="img" aria-label="' +
      states.map(function (s) { return s.label + ' ' + stats[s.key] + ' 題'; }).join('，') + '">' +
      states.map(function (s) { return stats[s.key] ? '<span class="ml-' + s.key + '" style="width:' +
        (stats.total ? stats[s.key] / stats.total * 100 : 0) + '%"></span>' : ''; }).join('') + '</div>';
  }
  function legend(stats) {
    return '<div class="ml-legend">' + states.map(function (s) {
      return '<span><i class="ml-dot ml-' + s.key + '"></i>' + s.label + ' <b>' + stats[s.key] + '</b></span>';
    }).join('') + '</div>';
  }
  function subjectName(code) { return global.DSESubjects.names[code] || code; }
  function icon(code) { return global.DSESubjects.icon(code); }
  function header(title, sub, back, label) {
    return '<header class="page-head"><div><h1 class="page-title">' + title + '</h1><p class="page-sub">' + sub +
      '</p></div><a class="btn btn-ghost" href="' + back + '">← ' + label + '</a></header>';
  }
  function remember() {
    if (activeKey) positions[activeKey] = context.scrollRoot ? context.scrollRoot.scrollTop : global.scrollY || 0;
    activeKey = '';
  }
  function frame(key, html) {
    activeKey = key;
    context.root.innerHTML = '<section class="page ml-page' + (key === 'subjects' ? ' ml-subject-picker' : '') + '">' + html + '</section>';
    if (positions[key]) (global.requestAnimationFrame || function (fn) { fn(); })(function () {
      if (activeKey !== key) return;
      if (context.scrollRoot) context.scrollRoot.scrollTop = positions[key];
      else global.scrollTo(0, positions[key]);
    });
  }
  function overview() {
    var subjects = context.data.subjects;
    frame('subjects', header('<span class="persona-icon persona-icon-library" aria-hidden="true"></span> 錯題庫', '從科目到課題，直接找到需要重溫的錯題。', '#/', '主頁') +
      '<a class="btn btn-primary ml-global-entry" href="#/library/books/search">搜尋全科錯題 · 題號、知識點、答案與解析</a>' +
      '<div class="ml-subject-dock"><div class="ml-subjects">' + global.DSESubjects.libraryOrder(subjects).map(function (code) {
        var stats = summarize(subjects[code].items, context.index);
        var percent = stats.total ? Math.round(stats.mastered / stats.total * 100) : 0;
        return '<a class="ml-subject ml-subject-' + code + '" href="#/library/books/' + code + '">' +
          '<div class="ml-card-top"><span class="ml-subject-icon">' + icon(code) + '</span><span class="ml-eyebrow">DSE · 按課題複習</span></div>' +
          '<h2>' + subjectName(code) + '</h2><p>' + subjects[code].topics.length + ' 個收錄課題 · ' + stats.total + ' 張錯題卡</p>' +
          '<span class="ml-picker-count">' + stats.total + ' 張錯題卡</span>' +
          '<div class="ml-subject-metrics"><span><b>' + (stats.total - stats.mastered) + '</b>待複習／鞏固</span>' +
          '<span><b>' + percent + '%</b>已掌握</span></div>' + bar(stats) + legend(stats) +
          '<span class="ml-open">查看課題與錯因 <span aria-hidden="true">→</span></span></a>';
      }).join('') + '</div>' +
      '<p class="library-note">已掌握＝兩次獨立練習連續全對；之後未全對會標為回退。掌握狀態跨雙周保留，閱讀解析不計作答。</p></div>');
  }
  function summary(code, items, title) {
    var stats = summarize(items, context.index), fresh = 0, regressions = 0;
    items.forEach(function (item) {
      var row = context.index[item.id];
      if (!row) return;
      if (row.firstCorrectAt >= context.cycleStart && row.history[row.history.length - 1].correct) fresh++;
      if (row.state === 'regressed' && row.lastAt >= context.cycleStart) regressions++;
    });
    var lostText = stats.lostKnown === stats.total && stats.total ? stats.lost + ' 分原卷失分' : '原卷失分以已核實資料為準';
    return '<div class="ml-summary ml-summary-' + code + '"><div class="ml-summary-heading"><div><span class="ml-eyebrow">學習總覽</span>' +
      '<h2>' + esc(title) + '</h2><p>' + lostText + ' · 掌握進度以歷次已提交練習計算</p></div><span class="ml-summary-percent">' +
      (stats.total ? Math.round(stats.mastered / stats.total * 100) : 0) + '<small>% 已掌握</small></span></div>' +
      '<div class="ml-summary-metrics"><span><b>' + stats.total + '</b>收錄錯題卡</span><span><b>' + (stats.total - stats.mastered) +
      '</b>待複習／鞏固</span><span><b>' + fresh + '</b>本雙周新解決</span><span><b>' + regressions + '</b>本雙周回退</span></div>' +
      bar(stats) + legend(stats) + '</div>';
  }
  function topicPage(code) {
    var api = context, generation = ++topicGeneration, subject = api.data.subjects[code];
    var years = Array.from(new Set(subject.items.map(function (item) { return String(item.year); }))).sort().reverse();
    var selected = selectedYears[code] || 'all', catalog = null;
    if (selected !== 'all' && years.indexOf(selected) < 0) selected = 'all';
    var order = global.DSESubjects.libraryOrder(api.data.subjects);
    var subjectIndex = order.indexOf(code);
    var previous = order[(subjectIndex + order.length - 1) % order.length];
    var next = order[(subjectIndex + 1) % order.length];
    frame(code, header('錯題庫與歸納', '選年份，再選課題。原答案、錯因與正解依次展開。', '#/library/books', '科目') +
      '<div class="inventory-switch" aria-label="學科切換"><a class="shoulder-link" href="#/library/books/' + previous + '" aria-label="上一個學科：' + subjectName(previous) + '">‹ LB</a>' +
      '<strong>' + subjectName(code) + '</strong><a class="shoulder-link" href="#/library/books/' + next + '" aria-label="下一個學科：' + subjectName(next) + '">RB ›</a></div>' +
      '<div class="inventory-layout"><section class="inventory-years" aria-label="年份與原卷成績"><h2>YEAR SELECT / 年份與狀態</h2>' +
      '<div class="year-list" id="mlYears"></div><p class="year-grade-note">LV＝DSE 試卷參考等級（非官方估算）；HP＝原卷分數；SP＝錯題數。缺少適用分界時顯示「—」；單卷不評全科等級。</p>' +
      '<p class="year-grade-note" id="mlGradeStatus" role="status">正在核對原卷成績…</p><div id="mlYearSummary"></div></section>' +
      '<section class="inventory-topics" aria-label="課題目錄"><div class="ml-section-head"><h2>TOPIC LIST / 課題</h2><label>排序 <select id="mlTopicSort"><option value="syllabus">考綱順序</option>' +
      '<option value="pending">待複習最多</option></select></label></div><div class="ml-topics" id="mlTopics"></div>' +
      '<section class="topic-info" aria-label="課題資訊"><span aria-hidden="true">INFO</span><div id="mlTopicInfo" aria-live="polite"></div></section></section></div>' +
      '<p class="library-note">長期已掌握＝兩次獨立練習連續全對；閱讀不計作答。</p>');
    var root = api.root, sort = root.querySelector('#mlTopicSort');
    sort.value = (filters[code] || {}).sort || 'syllabus';
    function currentItems() { return subject.items.filter(function (item) { return selected === 'all' || String(item.year) === selected; }); }
    function drawYears() {
      root.querySelector('#mlYears').innerHTML = ['all'].concat(years).map(function (year) {
        var items = subject.items.filter(function (item) { return year === 'all' || String(item.year) === year; });
        var detail = catalog && catalog.papers && catalog.papers[code] && catalog.papers[code][year];
        var assessment = detail && detail.assessment;
        var metrics = api.gradeMetrics && api.gradeMetrics(assessment);
        var level = metrics && metrics.current ? metrics.current.level : '—';
        var score = metrics ? assessment.earned + '/' + assessment.total : '—';
        return '<button class="inventory-year" type="button" data-year="' + esc(year) + '" aria-pressed="' + (selected === year) + '">' +
          '<span class="year-number" aria-hidden="true">' + (year === 'all' ? 'ALL' : esc(year.slice(-2))) + '</span><span class="year-body"><span class="year-name">' +
          (year === 'all' ? '全部年份' : esc(year + ' ' + subjectName(code))) + '</span><span class="year-meters">' +
          (year === 'all' ? '' : '<span><abbr title="DSE 試卷等級">LV</abbr> <b>' + esc(level) + '</b></span><span><abbr title="原卷分數">HP</abbr> <b>' + score + '</b></span>') +
          '<span><abbr title="錯題數">SP</abbr> <b>' + items.length + '</b></span></span>' +
          (year !== 'all' && metrics ? '<span class="year-grade-note">' + esc(assessment.scope) + (metrics.current ? ' · 等級估算' : ' · 等級未評') + '</span>' : '') + '</span></button>';
      }).join('');
    }
    function inspect(row) {
      root.querySelector('#mlTopicInfo').innerHTML = '<h3>' + esc(row.topic.code + ' ' + row.topic.name) + '</h3><p>' +
        (selected === 'all' ? '全部年份' : esc(selected + ' 年')) + ' · ' + row.stats.total + ' 張錯題卡 · ' +
        (row.stats.total - row.stats.mastered) + ' 題待複習／鞏固 · ' + row.stats.mastered + ' 題長期已掌握。</p>' +
        '<a href="#/library/books/' + code + '/' + encodeURIComponent(row.topic.code) + '">展開本課題歸納 ↗</a>';
      Array.prototype.forEach.call(root.querySelectorAll('.ml-topic'), function (link) { link.classList.toggle('inspected', link.getAttribute('data-topic') === row.topic.code); });
    }
    function draw() {
      var items = currentItems();
      var rows = subject.topics.map(function (topic) {
        return { topic: topic, stats: summarize(items.filter(function (item) { return item.topic === topic.code; }), api.index) };
      }).filter(function (row) { return row.stats.total > 0; });
      if (sort.value === 'pending') rows.sort(function (a, b) { return (b.stats.total - b.stats.mastered) - (a.stats.total - a.stats.mastered); });
      root.querySelector('#mlYearSummary').innerHTML = summary(code, items, selected === 'all' ? '全部年份學習總覽' : selected + ' 年學習總覽');
      root.querySelector('#mlTopics').innerHTML = rows.map(function (row) {
        var st = row.stats;
        return '<a class="ml-topic" data-topic="' + esc(row.topic.code) + '" href="#/library/books/' + code + '/' + encodeURIComponent(row.topic.code) + '">' +
          '<div class="ml-topic-title"><span class="ml-topic-code">' + esc(row.topic.code) + '</span><div><h3>' + esc(row.topic.name) +
          '</h3><p>' + st.total + ' 張錯題卡 · ' + (st.total - st.mastered) + ' 題待複習／鞏固' +
          (st.lostKnown === st.total ? ' · 原卷失分 ' + st.lost + ' 分' : '') + '</p></div><span class="ml-topic-arrow" aria-hidden="true">↗</span></div>' + bar(st) + legend(st) + '</a>';
      }).join('') || '<p class="review-note">此年份尚未收錄錯題。</p>';
      Array.prototype.forEach.call(root.querySelectorAll('.ml-topic'), function (link) {
        var row = rows.filter(function (r) { return r.topic.code === link.getAttribute('data-topic'); })[0];
        link.addEventListener('mouseenter', function () { inspect(row); });
        link.addEventListener('focus', function () { inspect(row); });
      });
      if (rows.length) inspect(rows[0]); else root.querySelector('#mlTopicInfo').textContent = '尚未有可查看的課題。';
    }
    root.querySelector('#mlYears').addEventListener('click', function (event) {
      var button = event.target.closest('[data-year]');
      if (!button) return;
      selected = button.getAttribute('data-year'); selectedYears[code] = selected;
      subject.topics.forEach(function (topic) {
        var remembered = filters[code + '/' + topic.code];
        if (remembered) remembered.year = selected === 'all' ? '' : selected;
      });
      // Keep the pressed year button mounted so keyboard focus is preserved.
      Array.prototype.forEach.call(root.querySelectorAll('[data-year]'), function (node) { node.setAttribute('aria-pressed', String(node === button)); });
      draw();
    });
    sort.addEventListener('change', function () { filters[code] = { sort: sort.value }; draw(); });
    drawYears(); draw();
    if (api.catalog) api.catalog().then(function (result) {
      if (activeKey !== code || context !== api || generation !== topicGeneration) return;
      catalog = result;
      var focused = document.activeElement, year = focused && focused.getAttribute && focused.getAttribute('data-year');
      drawYears();
      if (year) { var replacement = root.querySelector('[data-year="' + year + '"]'); if (replacement && replacement.focus) replacement.focus(); }
      root.querySelector('#mlGradeStatus').textContent = result ? '已核對私人批改卷的成績與 DSE 參考分界。未有適用分界的原卷顯示「—」。' : '登入後可核對原卷分數；題目數與學習狀態仍可查看。';
    }).catch(function () {
      if (activeKey === code && context === api && generation === topicGeneration) root.querySelector('#mlGradeStatus').textContent = '原卷成績暫未能讀取。可先查看錯題；重新進入此頁可重試。';
    });
  }
  function card(item, year) {
    var row = context.index[item.id], state = row ? row.state : 'unseen';
    var own = item.kind === 'mc' ? text(item.option || '未作答') : (item.my || []).map(function (segment) {
      return '<span' + (segment[1] ? ' class="ml-answer-error"' : '') + '>' + text(segment[0]) + '</span>';
    }).join('<br>') || '未作答';
    var figures = Array.isArray(item.figures) ? item.figures : [];
    return '<details class="ml-question" id="question-' + esc(item.id) + '"><summary><span class="ml-question-meta">' +
      esc(item.year + ' · ' + item.paper + ' · ' + item.qref) + (Number.isFinite(item.lost) ? ' · 原卷失分 ' + item.lost : '') + '</span>' + badge(state) +
      '<span class="ml-question-title">' + esc(item.stem) + '</span><span class="ml-question-expand">展開答案與錯因</span></summary>' +
      '<div class="ml-question-body"><div class="ml-stem"><h3>' + (item.stemFull ? '題目' : '題目要點') + '</h3><p>' + text(item.stemFull || item.stem) + '</p>' +
      (Array.isArray(item.options) ? '<ol class="ml-options" type="A">' + item.options.map(function (option) { return '<li>' + text(option) + '</li>'; }).join('') + '</ol>' : '') +
      (Array.isArray(item.tables) ? item.tables.map(function (table) {
        return '<div class="ml-table-wrap" tabindex="0" role="region" aria-label="' + esc(table.caption) + '"><table><caption>' + text(table.caption) +
          '</caption><thead><tr>' + table.headers.map(function (head) { return '<th scope="col">' + text(head) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + table.rows.map(function (row) { return '<tr>' + row.map(function (cell) { return '<td>' + text(cell) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
      }).join('') : '') +
      figures.map(function (f) {
        return /^images\/(chem|bio|math|m2|physics)-\d{4}-fig-[a-z0-9-]+\.jpg$/.test(f.path) ? '<figure><img data-library-image="' + esc(f.path) +
          '" loading="lazy" decoding="async" alt="' + esc(f.alt || '原題圖表') + '"' +
          (f.width > 0 && f.height > 0 ? ' width="' + Number(f.width) + '" height="' + Number(f.height) + '"' : '') + '><figcaption>' + esc(f.alt) + '</figcaption></figure>' : '';
      }).join('') + '</div><div class="ml-answer ml-answer-own"><h3>我的原答案</h3><p>' + own + '</p></div>' +
      '<div class="ml-answer ml-answer-deduct"><h3>扣分點與錯因</h3><p>' + text(item.deduct) + '</p></div>' +
      '<div class="ml-answer ml-answer-correct"><h3>正解與踩分點</h3>' +
        (item.correctOpt || item.correct ? '<p>' + text(item.correctOpt || item.correct) + '</p>' : '') +
        (item.points ? '<p>' + text(item.points) + '</p>' : '') +
        (item.checks && item.checks.length ? '<ul>' + item.checks.map(function (p) { return '<li>' + text(p) + '</li>'; }).join('') + '</ul>' : '') + '</div>' +
      (row ? '<div class="ml-history"><h3>最近重做記錄</h3><p>與上方原卷答案分開記錄 · 連續全對 ' + row.streak + ' 次</p><ol>' +
        row.history.slice(-5).reverse().map(function (h) { return '<li>' + context.formatDate(h.t) + ' · ' +
          (h.correct ? '全對' : '未全對') + (h.tot ? ' · ' + esc(h.marks + '/' + h.tot) : '') + '</li>'; }).join('') + '</ol></div>' : '') +
      (context.aiHtml ? context.aiHtml(item.id) : '') + '<a class="btn btn-primary" href="#/session/' + context.code + '/' + encodeURIComponent(item.topic) + (year ? '/' + encodeURIComponent(year) : '') + '">練習本課題</a></div></details>';
  }
  function questions(code, topicCode) {
    var subject = context.data.subjects[code], topic = subject.topics.filter(function (t) { return t.code === topicCode; })[0];
    if (!topic) return topicPage(code);
    var items = subject.items.filter(function (item) { return item.topic === topicCode; });
    var key = code + '/' + topicCode, f = filters[key] || { query: '', status: '', kind: '', year: selectedYears[code] && selectedYears[code] !== 'all' ? selectedYears[code] : '' }, limit = 12;
    filters[key] = f; context.code = code;
    var years = Array.from(new Set(items.map(function (it) { return it.year; }))).sort().reverse();
    frame(key, header(esc(topic.code + ' · ' + topic.name), '原答案、扣分點與正解放在一起，按需要展開閱讀。', '#/library/books/' + code, subjectName(code) + '課題') +
      summary(code, items, topic.name) + '<div class="ml-filters"><label class="ml-search">搜尋<input id="mlSearch" type="search" placeholder="題號、題幹、錯因或答案" value="' + esc(f.query) + '"></label>' +
      '<label>狀態<select id="mlStatus"><option value="">全部狀態</option>' + states.map(function (s) { return '<option value="' + s.key + '">' + s.label + '</option>'; }).join('') + '</select></label>' +
      '<label>題型<select id="mlKind"><option value="">全部題型</option><option value="mc">選擇題</option><option value="sub">主觀題</option></select></label>' +
      '<label>年份<select id="mlYear"><option value="">全部年份</option>' + years.map(function (y) { return '<option>' + esc(y) + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="ml-section-head"><p id="mlMatchCount" role="status" aria-live="polite"></p><a class="btn btn-primary" id="mlPracticeLink" href="#/session/' + code + '/' + encodeURIComponent(topicCode) + '">練習本課題</a></div>' +
      '<div id="mlQuestions"></div><button class="btn btn-ghost" id="mlMore" hidden type="button">顯示更多</button>');
    var root = context.root, search = root.querySelector('#mlSearch'), timer;
    ['Status', 'Kind', 'Year'].forEach(function (name) {
      var element = root.querySelector('#ml' + name); element.value = f[name.toLowerCase()];
      element.addEventListener('change', function () { f[name.toLowerCase()] = element.value; limit = 12; draw(); });
    });
    var normalized = items.map(function (item) {
      return { item: item, search: context.normalize([item.qref, item.stem, item.stemFull, item.deduct, item.correct, item.points,
        JSON.stringify(item.my || []), (item.options || []).join(' ')].join(' ')).toLowerCase() };
    });
    function draw() {
      if (activeKey !== key) return;
      root.querySelector('#mlPracticeLink').href = '#/session/' + code + '/' + encodeURIComponent(topicCode) + (f.year ? '/' + encodeURIComponent(f.year) : '');
      var query = context.normalize(f.query.trim()).toLowerCase();
      var matches = normalized.filter(function (row) {
        var it = row.item, state = context.index[it.id];
        return (!f.status || (state ? state.state : 'unseen') === f.status) && (!f.kind || it.kind === f.kind) &&
          (!f.year || it.year === f.year) && (!query || row.search.indexOf(query) >= 0);
      });
      root.querySelector('#mlMatchCount').textContent = matches.length + ' / ' + items.length + ' 張錯題卡';
      root.querySelector('#mlQuestions').innerHTML = matches.slice(0, limit).map(function (row) { return card(row.item, f.year); }).join('') || '<div class="empty-ok">沒有符合條件的錯題。</div>';
      root.querySelector('#mlMore').hidden = matches.length <= limit;
      Array.prototype.forEach.call(root.querySelectorAll('.ml-question'), function (detail) {
        detail.addEventListener('toggle', function () {
          if (!detail.open) return;
          Array.prototype.forEach.call(detail.querySelectorAll('[data-library-image]'), function (img) {
            img.setAttribute('data-bank-image', img.getAttribute('data-library-image'));
            img.removeAttribute('data-library-image');
          });
          context.hydrate(detail);
        });
      });
    }
    search.addEventListener('input', function () {
      f.query = search.value; clearTimeout(timer); timer = setTimeout(function () { limit = 12; draw(); }, 120);
    });
    root.querySelector('#mlMore').addEventListener('click', function () { limit += 12; draw(); });
    draw();
  }
  function searchText(item, topic, tags) {
    return [item.id,item.qref,item.stem,item.stemFull,topic && topic.name,item.topic,item.option,item.correctOpt,item.deduct,item.correct,item.points,
      (item.my || []).map(function (s) { return s[0]; }).join(' '),(item.checks || []).join(' '),(item.options || []).join(' '),JSON.stringify(item.tables || []),(tags || []).join(' ')].filter(Boolean).join('\n');
  }
  function searchRows(data, historyIndex, f, normalize, tagsFor) {
    var terms = normalize(f.query.trim()).toLowerCase().split(/\s+/).filter(Boolean), rows=[];
    Object.keys(data.subjects).forEach(function (code) {
      if(f.subject && f.subject!==code)return;
      var subject=data.subjects[code];
      subject.items.forEach(function (item) {
        var state=historyIndex[item.id], tags=tagsFor ? tagsFor(item.id) : [], topic=subject.topics.filter(function (t) { return t.code===item.topic; })[0];
        if((f.year && String(item.year)!==f.year)||(f.kind && item.kind!==f.kind)||(f.status && (state ? state.state : 'unseen')!==f.status)||(f.tag && tags.indexOf(f.tag)<0))return;
        var source=searchText(item,topic,tags), normalized=normalize(source).toLowerCase();
        if(terms.some(function (term) { return normalized.indexOf(term)<0; }))return;
        var first=terms.length ? normalized.indexOf(terms[0]) : 0, start=Math.max(0,first-36), snippet=source.slice(start,start+150);
        rows.push({code:code,item:item,topic:topic,state:state ? state.state : 'unseen',tags:tags,snippet:(start?'…':'')+snippet+(source.length>start+150?'…':'')});
      });
    });
    return rows;
  }
  function snippetHtml(value, query) {
    var terms=context.normalize(query.trim()).toLowerCase().split(/\s+/).filter(Boolean), normalized=context.normalize(value).toLowerCase(), ranges=[];
    terms.forEach(function (term) { var at=normalized.indexOf(term);if(at>=0)ranges.push([at,at+term.length]); });
    ranges.sort(function (a,b) { return a[0]-b[0]; });
    var html='',cursor=0;
    ranges.forEach(function (range) { if(range[0]<cursor)return;html+=esc(value.slice(cursor,range[0]))+'<mark>'+esc(value.slice(range[0],range[1]))+'</mark>';cursor=range[1]; });
    return html+esc(value.slice(cursor));
  }
  function globalSearch() {
    if(context.loaded===false) return frame('search',header('全局搜尋','跨科目與課題搜尋錯題。','#/library/books','錯題庫')+'<p role="status">題庫尚未載入，載入後可開始搜尋。</p>');
    var f=searchState, subjects=context.data.subjects;
    var years=Array.from(new Set(Object.values(subjects).reduce(function (all,s) {return all.concat(s.items.map(function (it) {return String(it.year);}));},[]))).sort().reverse();
    var tags=Array.from(new Set(Object.values(subjects).reduce(function (all,s) {return all.concat(s.items.reduce(function (a,it) {return a.concat(context.tags?context.tags(it.id):[]);},[]));},[])));
    frame('search',header('全局搜尋','跨科目、跨課題查題號、題幹、知識點、原答案、扣分原因與解析。','#/library/books','錯題庫')+
      '<div class="ml-filters ml-global-filters"><label class="ml-search">關鍵詞<input id="globalQuery" type="search" maxlength="200" placeholder="支援簡體／繁體；多個關鍵詞以空格分隔" value="'+esc(f.query)+'"></label>'+
      '<label>科目<select id="globalSubject"><option value="">全部科目</option>'+Object.keys(subjects).map(function (code) {return '<option value="'+code+'">'+subjectName(code)+'</option>';}).join('')+'</select></label>'+
      '<label>年份<select id="globalYear"><option value="">全部年份</option>'+years.map(function (year) {return '<option>'+esc(year)+'</option>';}).join('')+'</select></label>'+
      '<label>題型<select id="globalKind"><option value="">全部題型</option><option value="mc">選擇題</option><option value="sub">主觀題</option></select></label>'+
      '<label>掌握狀態<select id="globalStatus"><option value="">全部狀態</option>'+states.map(function (s) {return '<option value="'+s.key+'">'+s.label+'</option>';}).join('')+'</select></label>'+
      '<label>已確認錯因<select id="globalTag"><option value="">全部標籤</option>'+tags.map(function (tag) {return '<option>'+esc(tag)+'</option>';}).join('')+'</select></label></div>'+
      '<p id="globalCount" role="status" aria-live="polite"></p><div class="ml-global-results" id="globalResults"></div><button id="globalMore" class="btn btn-ghost" type="button" hidden>顯示更多結果</button>');
    var api=context, root=api.root, timer;
    function draw() {
      if(context!==api || activeKey!=='search')return;
      var rows=searchRows(api.data,api.index,f,api.normalize,api.tags);
      root.querySelector('#globalCount').textContent=rows.length+' 題符合條件'+(tags.length?'':' · 尚未有已確認的錯因標籤');
      root.querySelector('#globalResults').innerHTML=rows.slice(0,f.limit).map(function (r) {
        return '<a class="ml-search-result" href="#/library/books/question/'+r.code+'/'+encodeURIComponent(r.item.id)+'"><span class="ml-result-meta">'+esc(subjectName(r.code)+' · '+r.item.year+' · '+r.item.topic+' '+(r.topic?r.topic.name:'')+' · '+r.item.qref)+'</span>'+badge(r.state)+
          '<h2>'+esc(r.item.stem)+'</h2><p>'+snippetHtml(r.snippet,f.query)+'</p>'+(r.tags.length?'<small>已確認錯因：'+esc(r.tags.join('、'))+'</small>':'')+'</a>';
      }).join('') || '<div class="empty-note">沒有匹配結果。可減少關鍵詞或放寬篩選條件。</div>';
      root.querySelector('#globalMore').hidden=rows.length<=f.limit;
    }
    root.querySelector('#globalQuery').addEventListener('input',function (event) {f.query=event.target.value;f.limit=20;clearTimeout(timer);timer=setTimeout(draw,120);});
    ['Subject','Year','Kind','Status','Tag'].forEach(function (name) {
      var element=root.querySelector('#global'+name);element.value=f[name.toLowerCase()];
      element.addEventListener('change',function () {f[name.toLowerCase()]=element.value;f.limit=20;draw();});
    });
    root.querySelector('#globalMore').addEventListener('click',function () {f.limit+=20;draw();});
    draw();
  }
  function questionPage(code, id) {
    var subject=context.data.subjects[code], item=subject && subject.items.filter(function (it) {return it.id===id;})[0];
    if(!item)return frame('question',header('未找到這道題','請返回搜尋結果或重新載入題庫。','#/library/books/search','搜尋結果'));
    context.code=code;
    frame('question/'+code+'/'+id,header(esc(subjectName(code)+' · '+item.year+' · '+item.qref),'原卷答案與重做、AI 輔評分開保存。','#/library/books/search','搜尋結果')+card(item,''));
    var detail=context.root.querySelector('.ml-question');
    if(detail){detail.open=true;Array.prototype.forEach.call(detail.querySelectorAll('[data-library-image]'),function (img) {img.setAttribute('data-bank-image',img.getAttribute('data-library-image'));img.removeAttribute('data-library-image');});context.hydrate(detail);}
  }
  function render(parts, api) {
    context = api; context.index = indexHistory(api.history);
    if(parts[0]==='search')return globalSearch();
    if(parts[0]==='question') {try{return questionPage(parts[1],decodeURIComponent(parts[2]||''));}catch(_){return overview();}}
    if (!parts.length || !api.data.subjects[parts[0]]) return overview();
    if (parts.length === 1) return topicPage(parts[0]);
    var topic;
    try { topic = decodeURIComponent(parts[1]); } catch (_) { return topicPage(parts[0]); }
    return questions(parts[0], topic);
  }
  function reset() { context = null; activeKey = ''; positions = {}; filters = {}; selectedYears = {};searchState={query:'',subject:'',year:'',kind:'',status:'',tag:'',limit:20}; topicGeneration++; }
  global.DSELibrary = { render: render, remember: remember, reset: reset, independentHistory: independentHistory, indexHistory: indexHistory, summarize: summarize, full: full, dailyCandidates: dailyCandidates, searchRows: searchRows };
})(window);
