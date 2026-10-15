/* Private, structured mistake library. No examination data is shipped here. */
(function (global) {
  'use strict';
  var states = [
    { key: 'unseen', label: '未複習' }, { key: 'wrong', label: '仍需複習' },
    { key: 'learning', label: '待鞏固' }, { key: 'mastered', label: '已掌握' },
    { key: 'regressed', label: '回退' }
  ];
  var labels = {}, positions = {}, filters = {}, activeKey = '', context;
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
  function indexHistory(history) {
    var grouped = new Map(), index = Object.create(null);
    (history || []).forEach(function (session) {
      if (!session || !Number.isFinite(session.t) || session.t > Date.now() || !session.results) return;
      var key = JSON.stringify([session.t, session.subj, session.topic]);
      var row = grouped.get(key);
      if (!row) { row = { t: session.t, results: {} }; grouped.set(key, row); }
      Object.keys(session.results).forEach(function (id) {
        var next = session.results[id];
        if (!next || typeof next.ok !== 'boolean') return;
        // Replayed/merged copies of one submitted exercise count only once.
        if (!row.results[id] || !full(next)) row.results[id] = next;
      });
    });
    Array.from(grouped.values()).sort(function (a, b) { return a.t - b.t; }).forEach(function (session) {
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
  function subjectName(code) { return code === 'chem' ? '化學' : '生物'; }
  function icon(code) { return code === 'chem' ? '⚗️' : '🧬'; }
  function header(title, sub, back, label) {
    return '<header class="page-head"><div><h1 class="page-title">' + title + '</h1><p class="page-sub">' + sub +
      '</p></div><a class="btn btn-ghost" href="' + back + '">← ' + label + '</a></header>';
  }
  function remember() { if (activeKey) positions[activeKey] = global.scrollY || 0; activeKey = ''; }
  function frame(key, html) {
    activeKey = key;
    context.root.innerHTML = '<section class="page ml-page">' + html + '</section>';
    if (positions[key]) (global.requestAnimationFrame || function (fn) { fn(); })(function () {
      if (activeKey === key) global.scrollTo(0, positions[key]);
    });
  }
  function overview() {
    var subjects = context.data.subjects;
    frame('subjects', header('📚 錯題庫', '從科目到課題，直接找到需要重溫的錯題。', '#/', '主頁') +
      '<div class="ml-subjects">' + ['bio', 'chem'].map(function (code) {
        var stats = summarize(subjects[code].items, context.index);
        var percent = stats.total ? Math.round(stats.mastered / stats.total * 100) : 0;
        return '<a class="ml-subject ml-subject-' + code + '" href="#/library/books/' + code + '">' +
          '<div class="ml-card-top"><span class="ml-subject-icon">' + icon(code) + '</span><span class="ml-eyebrow">DSE · 按課題複習</span></div>' +
          '<h2>' + subjectName(code) + '</h2><p>' + subjects[code].topics.length + ' 個收錄課題 · ' + stats.total + ' 張錯題卡</p>' +
          '<div class="ml-subject-metrics"><span><b>' + (stats.total - stats.mastered) + '</b>待複習／鞏固</span>' +
          '<span><b>' + percent + '%</b>已掌握</span></div>' + bar(stats) + legend(stats) +
          '<span class="ml-open">查看課題與錯因 <span aria-hidden="true">→</span></span></a>';
      }).join('') + '<div class="ml-subject ml-subject-math" aria-disabled="true"><span class="ml-subject-icon">📐</span>' +
        '<h2>數學</h2><p>尚未收錄 · 為之後的錯題預留位置</p><span class="ml-badge ml-unseen">準備中</span></div></div>' +
      '<p class="library-note">已掌握＝兩次獨立練習連續全對；之後未全對會標為回退。掌握狀態跨雙周保留，閱讀解析不計作答。</p>');
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
    var subject = context.data.subjects[code], rows = subject.topics.map(function (topic) {
      var items = subject.items.filter(function (item) { return item.topic === topic.code; });
      return { topic: topic, stats: summarize(items, context.index) };
    });
    frame(code, header(icon(code) + ' ' + subjectName(code) + '錯題庫', '先看整體，再選課題；每條進度都可以追溯到具體錯題。', '#/library/books', '科目') +
      summary(code, subject.items, subjectName(code) + ' · 從錯因找下一步') +
      '<div class="ml-section-head"><h2>課題目錄</h2><label>排序 <select id="mlTopicSort"><option value="syllabus">考綱順序</option>' +
        '<option value="pending">待複習最多</option></select></label></div><div class="ml-topics" id="mlTopics"></div>' +
      '<p class="library-note">只列出已有錯題的課題；未收錄不代表已掌握整個課題。雙周新解決表示歷來首次全對，且目前仍全對。</p>');
    function draw(sort) {
      var sorted = rows.slice();
      if (sort === 'pending') sorted.sort(function (a, b) {
        return (b.stats.total - b.stats.mastered) - (a.stats.total - a.stats.mastered);
      });
      context.root.querySelector('#mlTopics').innerHTML = sorted.map(function (row) {
        var s = row.stats;
        return '<a class="ml-topic" href="#/library/books/' + code + '/' + encodeURIComponent(row.topic.code) + '">' +
          '<div class="ml-topic-title"><span class="ml-topic-code">' + esc(row.topic.code) + '</span><div><h3>' + esc(row.topic.name) +
          '</h3><p>' + s.total + ' 張錯題卡' + (s.lostKnown === s.total && s.total ? ' · 原卷失分 ' + s.lost + ' 分' : '') + '</p></div><span class="ml-topic-arrow">→</span></div>' +
          bar(s) + legend(s) + '</a>';
      }).join('') || '<div class="empty-ok">此科目尚未收錄錯題。</div>';
    }
    var sort = context.root.querySelector('#mlTopicSort');
    sort.value = (filters[code] || {}).sort || 'syllabus'; draw(sort.value);
    sort.addEventListener('change', function () { filters[code] = { sort: sort.value }; draw(sort.value); });
  }
  function card(item) {
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
        return /^images\/(chem|bio)-\d{4}-fig-[a-z0-9-]+\.jpg$/.test(f.path) ? '<figure><img data-library-image="' + esc(f.path) +
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
      '<a class="btn btn-primary" href="#/session/' + context.code + '/' + encodeURIComponent(item.topic) + '">練習本課題</a></div></details>';
  }
  function questions(code, topicCode) {
    var subject = context.data.subjects[code], topic = subject.topics.filter(function (t) { return t.code === topicCode; })[0];
    if (!topic) return topicPage(code);
    var items = subject.items.filter(function (item) { return item.topic === topicCode; });
    var key = code + '/' + topicCode, f = filters[key] || { query: '', status: '', kind: '', year: '' }, limit = 12;
    filters[key] = f; context.code = code;
    var years = Array.from(new Set(items.map(function (it) { return it.year; }))).sort().reverse();
    frame(key, header(esc(topic.code + ' · ' + topic.name), '原答案、扣分點與正解放在一起，按需要展開閱讀。', '#/library/books/' + code, subjectName(code) + '課題') +
      summary(code, items, topic.name) + '<div class="ml-filters"><label class="ml-search">搜尋<input id="mlSearch" type="search" placeholder="題號、題幹、錯因或答案" value="' + esc(f.query) + '"></label>' +
      '<label>狀態<select id="mlStatus"><option value="">全部狀態</option>' + states.map(function (s) { return '<option value="' + s.key + '">' + s.label + '</option>'; }).join('') + '</select></label>' +
      '<label>題型<select id="mlKind"><option value="">全部題型</option><option value="mc">選擇題</option><option value="sub">主觀題</option></select></label>' +
      '<label>年份<select id="mlYear"><option value="">全部年份</option>' + years.map(function (y) { return '<option>' + esc(y) + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="ml-section-head"><p id="mlMatchCount" role="status" aria-live="polite"></p><a class="btn btn-primary" href="#/session/' + code + '/' + encodeURIComponent(topicCode) + '">練習本課題</a></div>' +
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
      var query = context.normalize(f.query.trim()).toLowerCase();
      var matches = normalized.filter(function (row) {
        var it = row.item, state = context.index[it.id];
        return (!f.status || (state ? state.state : 'unseen') === f.status) && (!f.kind || it.kind === f.kind) &&
          (!f.year || it.year === f.year) && (!query || row.search.indexOf(query) >= 0);
      });
      root.querySelector('#mlMatchCount').textContent = matches.length + ' / ' + items.length + ' 張錯題卡';
      root.querySelector('#mlQuestions').innerHTML = matches.slice(0, limit).map(function (row) { return card(row.item); }).join('') || '<div class="empty-ok">沒有符合條件的錯題。</div>';
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
  function render(parts, api) {
    context = api; context.index = indexHistory(api.history);
    if (!parts.length || !api.data.subjects[parts[0]]) return overview();
    if (parts.length === 1) return topicPage(parts[0]);
    var topic;
    try { topic = decodeURIComponent(parts[1]); } catch (_) { return topicPage(parts[0]); }
    return questions(parts[0], topic);
  }
  function reset() { context = null; activeKey = ''; positions = {}; filters = {}; }
  global.DSELibrary = { render: render, remember: remember, reset: reset, indexHistory: indexHistory, summarize: summarize, full: full };
})(window);
