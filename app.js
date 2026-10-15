/* Kyle 錯題本 —— 純靜態 SPA（hash 路由，localStorage 儲存，無依賴）
 * 視圖：主頁 / 練習（課題排序）/ 做題會話（一次提交、MC 自動批改、大題踩分點自改）/ 記錄（熱力圖＋仍錯查詢）
 */
(function () {
  'use strict';
  function emptyBank() {
    return { subjects: { chem: { name: '化學', topics: [], items: [] }, bio: { name: '生物', topics: [], items: [] } } };
  }
  var PRIVATE_BANK = window.QUIZ_PRIVATE_BANK === true;
  var DATA = PRIVATE_BANK ? emptyBank() : window.QUIZ_DATA;
  var bankLoaded = !PRIVATE_BANK, bankPromise = null, bankMessage = '', bankFailed = false, bankRequest = 0;
  var imageUrls = new Map(), imageReads = new Map(), imageObserver = null;
  var LS_SESS = 'dse_quiz_sessions_v2';
  var LS_DRAFT = 'dse_quiz_draft_v2';
  var LS_ARCHIVE = 'dse_quiz_archive_v1';
  var LS_CYCLE = 'dse_quiz_cycle_v1';
  var LS_REVIEW = 'dse_quiz_review_v1';
  var LS_SYNC_SESSION = 'dse_quiz_sync_session_v1';
  var LS_SYNCED_AT = 'dse_quiz_sync_at_v1';
  var LS_AUTH_MODE = 'dse_quiz_auth_mode_v1';
  var SYNC_API = String(window.QUIZ_SYNC_API || '').replace(/\/+$/, '');
  var PASSWORD_AUTH = window.QUIZ_PASSWORD_AUTH === true;
  var passwordLoginBusy = false;
  var syncTimer = null, syncBusy = false, syncAgain = false, syncRevision = 0;
  var syncMessage = '';
  var paperSubject = '', paperYear = '', paperPage = 1, paperManifest = null;
  var paperUrl = null, paperController = null, paperRequest = 0;
  var readerPages = new Map();
  var paperCatalogSnapshot = null;
  var startupHash = location.hash;
  // 所有網頁日期及雙週週期均以北京時間（UTC+8）為準；儲存的時間戳仍使用 UTC。
  var DAY_MS = 24 * 3600 * 1000;
  var BEIJING_OFFSET_MS = 8 * 3600 * 1000;
  var CYCLE_MS = 14 * DAY_MS;
  var CYCLE_ANCHOR = Date.UTC(2026, 9, 4, 16); // 北京時間 2026-10-05（一）00:00

  var sessions = load(LS_SESS, []);
  var archive = load(LS_ARCHIVE, []);
  var drafts = load(LS_DRAFT, {});
  var reviewPlan = load(LS_REVIEW, {});
  var SUBJECT_ORDER = ['chem', 'bio'];
  var SUBJECT_META = {
    chem: { name: '化學', icon: '⚗️', soon: false },
    bio: { name: '生物', icon: '🧬', soon: false },
    math: { name: '數學', icon: '📐', soon: true }
  };

  function load(k, d) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; }
    catch (e) { return d; }
  }
  function save() {
    localStorage.setItem(LS_SESS, JSON.stringify(sessions));
    localStorage.setItem(LS_DRAFT, JSON.stringify(drafts));
    localStorage.setItem(LS_REVIEW, JSON.stringify(reviewPlan));
    syncRevision++;
    scheduleSync();
  }

  function backupData() {
    return {
      app: 'kyle-dse-quiz', version: 1, exportedAt: new Date().toISOString(),
      sessions: sessions, archive: archive, drafts: drafts, reviewPlan: reviewPlan,
      cycle: localStorage.getItem(LS_CYCLE) || null
    };
  }
  function mergeDraft(a, b) {
    a = a || {}; b = b || {};
    var deletedAt = Math.max(Number(a.deletedAt) || 0, Number(b.deletedAt) || 0);
    var merged = { pick: {}, text: {}, paper: {}, changedAt: {}, deletedAt: deletedAt };
    ['pick', 'text', 'paper'].forEach(function (kind) {
      var left = a[kind] || {}, right = b[kind] || {};
      var ids = {};
      Object.keys(left).concat(Object.keys(right)).forEach(function (id) { ids[id] = true; });
      Object.keys(a.changedAt || {}).concat(Object.keys(b.changedAt || {})).forEach(function (key) {
        if (key.indexOf(kind + ':') === 0) ids[key.slice(kind.length + 1)] = true;
      });
      Object.keys(ids).forEach(function (id) {
        var key = kind + ':' + id;
        var leftAt = Number((a.changedAt || {})[key]) || 0;
        var rightAt = Number((b.changedAt || {})[key]) || 0;
        var useRight = rightAt > leftAt || (rightAt === leftAt && Object.prototype.hasOwnProperty.call(right, id) &&
          (!Object.prototype.hasOwnProperty.call(left, id) || !!right[id] || !left[id]));
        var source = useRight ? right : left;
        var at = useRight ? rightAt : leftAt;
        if (deletedAt && at <= deletedAt) return;
        if (Object.prototype.hasOwnProperty.call(source, id)) merged[kind][id] = source[id];
        if (at) merged.changedAt[key] = at;
      });
    });
    return merged;
  }
  function mergeDrafts(a, b) {
    var out = {};
    Object.keys(a || {}).concat(Object.keys(b || {})).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = mergeDraft((a || {})[key], (b || {})[key]);
    });
    return out;
  }
  function deleteDraft(key) {
    var old = drafts[key] || {};
    var stamps = Object.values(old.changedAt || {}).map(Number).filter(Number.isFinite);
    var deletedAt = Math.max(Date.now(), Number(old.deletedAt) || 0, ...stamps) + 1;
    drafts[key] = { pick: {}, text: {}, paper: {}, changedAt: {}, deletedAt: deletedAt };
  }
  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
    return JSON.stringify(value);
  }
  function mergeData(remote) {
    if (!remote || remote.app !== 'kyle-dse-quiz') return false;
    function mergeSessions(a, b) {
      var seen = {}, out = [];
      (a || []).concat(b || []).forEach(function (s) {
        if (!s || typeof s.t !== 'number') return;
        var key = [s.t, s.subj, s.topic, JSON.stringify(s.results || {})].join('|');
        if (!seen[key]) { seen[key] = true; out.push(s); }
      });
      return out.sort(function (x, y) { return x.t - y.t; });
    }
    sessions = mergeSessions(sessions, remote.sessions);
    archive = mergeSessions(archive, remote.archive);
    var localCycle = Number(localStorage.getItem(LS_CYCLE) || 0);
    var remoteCycle = Number(remote.cycle || 0);
    var cycle = Math.max(localCycle, remoteCycle);
    drafts = mergeDrafts(remoteCycle === cycle ? remote.drafts : {}, localCycle === cycle ? drafts : {});
    var plans = Object.assign({}, remote.reviewPlan || {});
    Object.keys(reviewPlan).forEach(function (id) {
      if (!plans[id] || (reviewPlan[id].lastAt || 0) >= (plans[id].lastAt || 0)) plans[id] = reviewPlan[id];
    });
    reviewPlan = plans;
    localStorage.setItem(LS_SESS, JSON.stringify(sessions));
    localStorage.setItem(LS_ARCHIVE, JSON.stringify(archive));
    localStorage.setItem(LS_DRAFT, JSON.stringify(drafts));
    localStorage.setItem(LS_REVIEW, JSON.stringify(reviewPlan));
    if (cycle) localStorage.setItem(LS_CYCLE, String(cycle));
    return true;
  }
  function syncRequest(method, body) {
    var session = localStorage.getItem(LS_SYNC_SESSION);
    if (!SYNC_API || !session) return Promise.reject(new Error('未設定同步服務或尚未連接 GitHub'));
    return syncFetch('/sync', {
      method: method,
      headers: { 'Authorization': 'Bearer ' + session, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }).then(readSyncResponse);
  }
  function readSyncResponse(r) {
    return Promise.resolve().then(function () { return r.json(); }).catch(function () { return {}; }).then(function (data) {
      if (r.ok) return data;
      var detail = data.error || '服務未回傳有效回應';
      var message = detail;
      if (detail === 'invalid_password') message = '密碼不正確，請再試一次';
      else if (r.status === 401) message = PASSWORD_AUTH ? '登入連接已失效，請重新輸入密碼；本機記錄已保留' : 'GitHub 連接已失效，請重新連接；本機記錄已保留';
      else if (r.status === 403) message = 'GitHub 授權或存取被拒絕，請重新連接並檢查授權（' + detail + '）';
      else if (detail === 'service_not_configured') message = '同步服務設定不完整';
      else if (detail === 'service_unavailable') message = '同步服務暫時無法使用，請稍後重試';
      else if (detail === 'storage_timeout') message = '資料儲存回應逾時，請稍後重試；本機記錄已保留';
      else if (detail === 'storage_unavailable') message = '資料儲存暫時無法連線，請稍後重試；不需要重設記錄';
      else if (detail === 'owner_connection_required') message = '資料儲存需要重新連接，請開啟儲存設定';
      else if (detail === 'too_many_attempts') message = '密碼嘗試次數過多，請於 15 分鐘後再試';
      else if (detail === 'book_not_accessible') message = '錯題集頁面圖片未能讀取，請檢查私人資料倉庫或重新生成圖片';
      else if (detail === 'book_unavailable') message = '錯題集頁面暫時無法讀取，請稍後重試';
      else if (detail === 'paper_not_accessible') message = '批改卷未能讀取，請檢查是否已發布此年份的批改版本';
      else if (detail === 'paper_unavailable') message = '批改卷暫時無法讀取，請稍後重試';
      throw Object.assign(new Error(message + ' [HTTP ' + r.status + ']'), { status: r.status, code: detail });
    });
  }
  function expireConnection(err, session) {
    if (err.status !== 401 || localStorage.getItem(LS_SYNC_SESSION) !== session) return;
    localStorage.removeItem(LS_SYNC_SESSION);
    forgetBank();
    bankMessage = err.message;
    route();
  }
  function syncFetch(path, options) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    return fetch(SYNC_API + path, Object.assign({}, options, { signal: controller.signal }))
      .catch(function (err) {
        if (err.name === 'AbortError') throw Object.assign(new Error(path === '/auth/password'
          ? '登入服務連線逾時，請重試；若持續發生，請檢查目前網絡能否連上同步服務'
          : '同步連線逾時，請稍後重試'), { code: 'connection_timeout', path: path });
        throw err;
      }).finally(function () { clearTimeout(timer); });
  }
  function syncNow(mergeRemote) {
    if (syncBusy) { syncAgain = true; return Promise.resolve(false); }
    if (!localStorage.getItem(LS_SYNC_SESSION) || !SYNC_API) return Promise.resolve(false);
    syncBusy = true;
    var session = localStorage.getItem(LS_SYNC_SESSION);
    setSyncStatus('同步中…');
    function state(data) {
      return stableStringify([data.sessions || [], data.archive || [], data.drafts || {}, data.reviewPlan || {}, String(data.cycle || '')]);
    }
    var before = state(backupData());
    var sentRevision = syncRevision;
    return syncRequest('GET').then(function (remote) {
      if (localStorage.getItem(LS_SYNC_SESSION) !== session) return null;
      if (remote.data) mergeData(remote.data);
      var backup = backupData();
      sentRevision = syncRevision;
      if (remote.data && state(remote.data) === state(backup)) {
        return { savedAt: new Date().toISOString(), kind: before === state(backup) ? 'checked' : 'downloaded' };
      }
      return syncRequest('PUT', { data: backup, sha: remote.sha || null }).then(function (result) {
        result.kind = 'uploaded'; return result;
      });
    }).then(function (result) {
      if (!result || localStorage.getItem(LS_SYNC_SESSION) !== session) return false;
      var checkedAt = new Date().toISOString();
      localStorage.setItem(LS_SYNCED_AT, checkedAt);
      var label = result.kind === 'uploaded' ? '已上傳至雲端' : result.kind === 'downloaded' ? '已更新本機記錄' : '雲端已核對，無新記錄';
      setSyncStatus(syncRevision === sentRevision
        ? label + ' · 練習 ' + (sessions.length + archive.length) + ' 次 · ' + fmtDateTime(result.savedAt || checkedAt)
        : '本機有新變更，等待自動同步…');
      if (syncRevision !== sentRevision) scheduleSync();
      if ((location.hash.replace(/^#/, '').split('?')[0] || '/') === '/' && before !== state(backupData())) renderHome();
      else if (location.hash.indexOf('/records') >= 0) renderRecords();
      else if (location.hash.indexOf('/library/books') >= 0 && before !== state(backupData())) route();
      return true;
    }).catch(function (err) {
      if (localStorage.getItem(LS_SYNC_SESSION) !== session) return false;
      expireConnection(err, session);
      setSyncStatus('同步失敗：' + err.message);
      return false;
    }).finally(function () {
      syncBusy = false;
      if (syncAgain) { syncAgain = false; scheduleSync(); }
    });
  }
  function scheduleSync() {
    if (!localStorage.getItem(LS_SYNC_SESSION) || !SYNC_API) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(true); }, 1400);
  }
  function setSyncStatus(message) {
    syncMessage = message;
    var el = $('#syncStatus');
    if (el) { el.textContent = message; el.hidden = false; }
  }
  function forgetBank() {
    bankRequest++;
    bankPromise = null; bankMessage = ''; bankFailed = false;
    releasePaper();
    if (imageObserver) { imageObserver.disconnect(); imageObserver = null; }
    window.DSELibrary.reset();
    imageReads.clear();
    paperCatalogSnapshot = null;
    imageUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    imageUrls.clear();
    if (PRIVATE_BANK) { DATA = emptyBank(); bankLoaded = false; }
  }
  function passwordForm() {
    return '<form id="passwordLoginForm" class="sync-login"><label for="syncPassword">網站密碼</label>' +
      '<input id="syncPassword" type="password" autocomplete="current-password" maxlength="256" required placeholder="輸入密碼" aria-describedby="syncStatus">' +
      '<button id="passwordLoginBtn" class="btn btn-primary" type="submit">登入並自動同步</button></form>' +
      '<p class="review-note">登入後，做題記錄會自動同步；本機記錄會保留。</p>' +
      '<details class="sync-storage"><summary>儲存設定</summary><p class="review-note">首次設定或儲存授權失效時，由帳戶擁有人連接一次。日常使用只需輸入密碼。</p>' +
      '<a class="btn btn-ghost" href="' + esc(SYNC_API + '/auth/start') + '" target="_blank" rel="noopener">連接資料儲存</a></details>';
  }
  function bindPasswordForm() {
    var form = $('#passwordLoginForm');
    if (!form || !PASSWORD_AUTH) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (passwordLoginBusy) return;
      var input = $('#syncPassword'), button = $('#passwordLoginBtn');
      var password = input.value;
      if (!password) { setSyncStatus('請輸入密碼'); return; }
      input.value = ''; button.disabled = true; passwordLoginBusy = true;
      setSyncStatus('正在驗證密碼…');
      var headers = { 'Content-Type': 'application/json' };
      var existing = localStorage.getItem(LS_SYNC_SESSION);
      var authenticated = false;
      if (existing) headers.Authorization = 'Bearer ' + existing;
      syncFetch('/auth/password', { method: 'POST', headers: headers, body: JSON.stringify({ password: password }), cache: 'no-store' })
        .then(readSyncResponse).then(function (data) {
          if (!data || !/^[A-Za-z0-9_-]{40,80}$/.test(data.sessionId || '')) throw new Error('登入服務未回傳有效連接');
          localStorage.setItem(LS_AUTH_MODE, 'password');
          localStorage.setItem(LS_SYNC_SESSION, data.sessionId);
          authenticated = true;
          setSyncStatus('已登入，正在背景同步…');
          forgetBank(); bankMessage = '';
          location.hash = '#/';
          route();
          return Promise.all([loadBank(), syncNow(true)]);
        }).catch(function (err) {
          setSyncStatus((authenticated ? '已登入，但資料載入未完成：' : '登入失敗：') + err.message);
        }).finally(function () { passwordLoginBusy = false; button.disabled = false; });
    });
  }
  function loadBank() {
    if (!PRIVATE_BANK || bankLoaded) return Promise.resolve(true);
    if (bankPromise) return bankPromise;
    var session = localStorage.getItem(LS_SYNC_SESSION);
    if (!session || !SYNC_API) return Promise.resolve(false);
    var requestId = ++bankRequest;
    bankFailed = false;
    bankMessage = PASSWORD_AUTH ? '已登入，正在載入你的錯題庫…' : '正在載入你的錯題庫…';
    bankPromise = syncFetch('/bank', {
      method: 'GET', headers: { Authorization: 'Bearer ' + session }, cache: 'no-store'
    }).then(readSyncResponse).then(function (bank) {
      if (requestId !== bankRequest || localStorage.getItem(LS_SYNC_SESSION) !== session) return false;
      ['chem', 'bio'].forEach(function (code) {
        if (!bank.subjects || !bank.subjects[code] || !Array.isArray(bank.subjects[code].items) || !Array.isArray(bank.subjects[code].topics)) {
          throw new Error('錯題庫格式有誤');
        }
        bank.subjects[code].items.forEach(function (it) {
          if (it.img && !/^images\/(?:chem|bio)-\d{4}-(?:mc-\d+|fig-[a-z0-9-]+)\.jpg$/.test(it.img)) throw new Error('原題圖片路徑有誤');
        if (it.figures && (!Array.isArray(it.figures) || !it.figures.every(function (f) {
          return f && /^images\/(?:chem|bio)-\d{4}-fig-[a-z0-9-]+\.jpg$/.test(f.path);
        }))) throw new Error('原題圖表路徑有誤');
        });
      });
      DATA = bank; bankLoaded = true; bankMessage = '';
      seedReviewPlan(); normalizeReviewPlan(); refreshBankView();
      return true;
    }).catch(function (err) {
      if (requestId !== bankRequest || localStorage.getItem(LS_SYNC_SESSION) !== session) return false;
      expireConnection(err, session);
      bankFailed = true;
      bankMessage = '未能讀取錯題庫：' + err.message; refreshBankView(); return false;
    }).finally(function () { if (requestId === bankRequest) bankPromise = null; });
    refreshBankView();
    return bankPromise;
  }
  function refreshBankView() {
    // Paper browsing has its own requests and must not restart when the bank arrives.
    if (location.hash.indexOf('#/library/papers') !== 0) route(true);
  }
  function bankStatusHtml() {
    if (bankLoaded) return '';
    return '<div class="bank-status"><p class="review-note" id="bankStatus" role="status" aria-live="polite">' +
      esc(bankMessage || '正在背景載入錯題庫，本機做題記錄可先查看。') + '</p>' +
      (bankFailed ? '<button class="btn btn-ghost" id="bankRetryBtn" type="button">重試載入錯題庫</button>' : '') + '</div>';
  }
  function bindBankRetry() {
    var retry = $('#bankRetryBtn');
    if (retry) retry.addEventListener('click', function () { loadBank(); });
  }
  function renderBankLoading() {
    $('#app').innerHTML = '<section class="page"><header class="page-head"><h1 class="page-title">錯題庫</h1></header>' +
      bankStatusHtml() + '<p class="review-note">題庫載入後會自動顯示，你也可以先查看做題記錄或批改卷。</p>' +
      '<a class="btn btn-ghost" href="#/">返回主頁</a> <a class="btn btn-ghost" href="#/records">做題記錄</a> ' +
      '<a class="btn btn-ghost" href="#/library/papers">紅筆批改卷</a></section>';
    bindBankRetry();
  }
  function renderBankGate() {
    $('#app').innerHTML = '<section class="home"><div class="hero">' +
      '<div class="hero-kicker">DSE · 化學 / 生物</div><h1 class="hero-title">Kyle 嘅錯題本</h1>' +
      '<p class="hero-sub">' + (PASSWORD_AUTH ? '輸入密碼即可讀取你的錯題庫、原題圖片和做題記錄。' : '連接 GitHub 後即可讀取你的錯題庫和原題圖片。') + '</p>' +
      '<p class="review-note" id="syncStatus" role="status" aria-live="polite">' + esc(bankMessage || syncMessage || '你的做題記錄會保留。') + '</p>' +
      (SYNC_API ? (PASSWORD_AUTH ? passwordForm() : '<a class="btn btn-primary" href="' + esc(SYNC_API + '/auth/start') + '" target="_blank" rel="noopener">連接 GitHub</a>') : '') +
      (localStorage.getItem(LS_SYNC_SESSION) ? '<button class="btn btn-ghost" id="bankRetryBtn" type="button">重新載入</button>' : '') +
      '<a class="btn btn-ghost" href="#/records">做題記錄</a></div></section>';
    bindPasswordForm();
    var retry = $('#bankRetryBtn');
    if (retry) retry.addEventListener('click', function () { loadBank(); });
  }
  function hydratePrivateImages(root) {
    if (!PRIVATE_BANK || !bankLoaded) return;
    var session = localStorage.getItem(LS_SYNC_SESSION);
    function loadImage(img) {
      var path = img.getAttribute('data-bank-image');
      if (!path || !session) return;
      if (imageUrls.has(path)) { img.src = imageUrls.get(path); return; }
      var key = session + ':' + path, pending = imageReads.get(key);
      if (!pending) {
        pending = syncFetch('/bank/' + path, { method: 'GET', headers: { Authorization: 'Bearer ' + session }, cache: 'no-store' })
          .then(function (r) { return r.ok ? r.blob() : readSyncResponse(r); })
          .then(function (blob) {
            if (!bankLoaded || localStorage.getItem(LS_SYNC_SESSION) !== session) return null;
            if (!imageUrls.has(path)) imageUrls.set(path, URL.createObjectURL(blob));
            while (imageUrls.size > 24) {
              var oldest = imageUrls.keys().next().value;
              URL.revokeObjectURL(imageUrls.get(oldest)); imageUrls.delete(oldest);
            }
            return imageUrls.get(path);
          }).finally(function () { if (imageReads.get(key) === pending) imageReads.delete(key); });
        imageReads.set(key, pending);
      }
      pending.then(function (url) {
        if (url && img.isConnected !== false && localStorage.getItem(LS_SYNC_SESSION) === session) img.src = url;
      }).catch(function (err) {
        expireConnection(err, session);
        if (img.isConnected !== false) img.alt = '原題圖片未能載入：' + err.message;
      });
    }
    if ('IntersectionObserver' in window && !imageObserver) imageObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { if (entry.isIntersecting) { imageObserver.unobserve(entry.target); loadImage(entry.target); } });
    }, { rootMargin: '240px' });
    $all('img[data-bank-image]', root).forEach(function (img) {
      if (imageObserver) imageObserver.observe(img); else loadImage(img);
    });
  }
  function initSync(hash) {
    var handoff = (hash.match(/[?&]handoff=([^&]+)/) || [])[1];
    if (handoff && SYNC_API) {
      setSyncStatus('正在完成 GitHub 連接…');
      syncFetch('/auth/exchange', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoff: handoff })
      }).then(function (r) { if (!r.ok) throw new Error('授权会话已失效'); return r.json(); })
        .then(function (data) {
          if (PASSWORD_AUTH) localStorage.setItem(LS_AUTH_MODE, 'password');
          localStorage.setItem(LS_SYNC_SESSION, data.sessionId);
          return Promise.all([loadBank(), syncNow(true)]);
        }).catch(function (err) { setSyncStatus('连接失败：' + err.message); });
    } else if (hash.indexOf('sync=cancelled') >= 0) {
      setSyncStatus('已取消 GitHub 授权');
    } else if (localStorage.getItem(LS_SYNC_SESSION)) {
      if (PASSWORD_AUTH && localStorage.getItem(LS_AUTH_MODE) !== 'password') {
        var existing = localStorage.getItem(LS_SYNC_SESSION);
        syncFetch('/auth/upgrade', { method: 'POST', headers: { Authorization: 'Bearer ' + existing }, cache: 'no-store' })
          .then(readSyncResponse).then(function (data) {
            if (!/^[A-Za-z0-9_-]{40,80}$/.test(data.sessionId || '')) throw new Error('登入服務未回傳有效連接');
            if (localStorage.getItem(LS_SYNC_SESSION) !== existing) return;
            localStorage.setItem(LS_AUTH_MODE, 'password');
            localStorage.setItem(LS_SYNC_SESSION, data.sessionId);
          }).catch(function (err) { expireConnection(err, existing); setSyncStatus('連接更新失敗：' + err.message); })
          .then(function () { return Promise.all([loadBank(), syncNow(true)]); });
      } else {
        loadBank();
        setTimeout(function () { syncNow(true); }, 0);
      }
    }
  }
  window.addEventListener('online', function () { loadBank(); syncNow(true); });
  window.addEventListener('focus', function () {
    if (localStorage.getItem(LS_SYNC_SESSION)) { loadBank(); syncNow(true); }
  });
  window.addEventListener('storage', function (event) {
    if (event.key === LS_SYNC_SESSION) {
      forgetBank(); route();
      if (event.newValue) Promise.all([loadBank(), syncNow(true)]);
    }
  });
  // Also fetch updates made on another computer while this tab remains open.
  setInterval(function () { if (PASSWORD_AUTH) syncNow(true); }, 60000);

  function cycleStartOf(ts) {
    return CYCLE_ANCHOR + Math.floor((ts - CYCLE_ANCHOR) / CYCLE_MS) * CYCLE_MS;
  }
  function cycleEndOf(ts) { return cycleStartOf(ts) + CYCLE_MS; }
  function allSessions() { return archive.concat(sessions); }

  // 雙週換輪：舊 session 歸檔（熱力圖保留），當前進度與草稿清零（題庫保留）
  function ensureCycle() {
    var cur = cycleStartOf(Date.now());
    var saved = parseInt(localStorage.getItem(LS_CYCLE) || '0', 10);
    if (!saved) {
      localStorage.setItem(LS_CYCLE, String(cur));
      return false;
    }
    if (saved < cur) {
      if (sessions.length) {
        archive = archive.concat(sessions);
        localStorage.setItem(LS_ARCHIVE, JSON.stringify(archive));
      }
      sessions = [];
      drafts = {};
      localStorage.setItem(LS_SESS, JSON.stringify([]));
      localStorage.removeItem(LS_DRAFT);
      localStorage.setItem(LS_CYCLE, String(cur));
      syncRevision++;
      scheduleSync();
      return true;
    }
    return false;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- 數據派生 ---------------- */
  function subjOf(code) { return DATA.subjects[code]; }
  function itemsOf(code) { return subjOf(code).items; }
  function topicName(code, t) {
    var x = subjOf(code).topics.filter(function (q) { return q.code === t; })[0];
    return x ? x.name : t;
  }
  function marksOf(it) {
    if (it.kind === 'mc') return 1;
    var m = (it.qref || '').match(/（\s*([0-9]+(?:\.[0-9]+)?)\s*分/);
    return m ? parseFloat(m[1]) : (it.checks ? it.checks.length : 1);
  }
  function letterOf(s) { var m = (s || '').match(/[A-D]/); return m ? m[0] : null; }

  // 原卷失分與練習滿分分開；缺少已核實失分時不由題目滿分推算。
  function topicStats(code) {
    var out = {};
    itemsOf(code).forEach(function (it) {
      if (!out[it.topic]) out[it.topic] = { topic: it.topic, marks: 0, n: 0 };
      out[it.topic].marks += Number.isFinite(it.lost) ? it.lost : 0;
      out[it.topic].n += 1;
    });
    return out;
  }

  // 最近一次各題表現：id → {ok, ratio, date, subj, topic}
  function latestMap() {
    var map = {};
    sessions.slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (s) {
      Object.keys(s.results).forEach(function (id) {
        var r = s.results[id];
        map[id] = {
          ok: r.ok, ratio: r.tot ? r.marks / r.tot : (r.ok ? 1 : 0),
          date: s.t, subj: s.subj, topic: s.topic
        };
      });
    });
    return map;
  }
  function isWrong(latest) {
    if (!latest) return true;            // 從未刷過＝待處理
    if (latest.ok === true) {
      // 大題全對才算 ok；MC ok=true 即對
      return latest.ratio < 1;
    }
    return true;
  }
  function dueCount(code, topic, latest) {
    return itemsOf(code).filter(function (it) {
      return it.topic === topic && isWrong(latest[it.id]);
    }).length;
  }

  // 間隔複習：配合雙週週期，最早在 15 日後提醒。
  var REVIEW_DAYS = [15, 21, 30, 45, 60];
  function updateReviewPlan(id, result, at) {
    var previous = reviewPlan[id];
    var ratio = result.tot ? result.marks / result.tot : (result.ok ? 1 : 0);
    var passed = result.ok === true && ratio >= 1;
    var level = passed ? Math.min(previous ? previous.level + 1 : 0, REVIEW_DAYS.length - 1) : 0;
    var days = REVIEW_DAYS[level];
    reviewPlan[id] = {
      level: level, interval: days, lastAt: at, dueAt: at + days * 864e5,
      ratio: ratio, streak: passed ? ((previous && previous.streak) || 0) + 1 : 0
    };
  }
  function reviewDue(id, now) {
    var p = reviewPlan[id];
    return !!(p && p.dueAt <= (now || Date.now()));
  }
  function seedReviewPlan() {
    var history = allSessions().slice().sort(function (a, b) { return a.t - b.t; });
    var needsSeed = {};
    history.forEach(function (s) {
      Object.keys(s.results || {}).forEach(function (id) {
        if (!reviewPlan[id]) needsSeed[id] = true;
      });
    });
    history.forEach(function (s) {
      Object.keys(s.results || {}).forEach(function (id) {
        if (needsSeed[id]) updateReviewPlan(id, s.results[id], s.t);
      });
    });
  }
  function normalizeReviewPlan() {
    var minInterval = REVIEW_DAYS[0], changed = false;
    Object.keys(reviewPlan).forEach(function (id) {
      var p = reviewPlan[id];
      if (!p || typeof p.lastAt !== 'number' || typeof p.dueAt !== 'number') return;
      var earliest = p.lastAt + minInterval * 864e5;
      if (p.dueAt < earliest) {
        p.level = 0;
        p.interval = minInterval;
        p.dueAt = earliest;
        changed = true;
      }
    });
    if (changed) localStorage.setItem(LS_REVIEW, JSON.stringify(reviewPlan));
  }

  // 簡體→繁體（數據裡少量簡體術語，學生默寫多為繁體；只收斂到繁體）
  var S2T_CHARS = '细质线双补转录应达尔体肠运输长营养纤维粪传杂种叶绿矿气压脏脑岛门静脉韧卫饱缩横肾茎腾浓';
  var S2T_MAP = {
    '细':'細','质':'質','线':'線','双':'雙','补':'補','转':'轉','录':'錄','应':'應',
    '达':'達','尔':'爾','体':'體','肠':'腸','运':'運','输':'輸','长':'長','营':'營',
    '养':'養','纤':'纖','维':'維','粪':'糞','遗':'遺','传':'傳','杂':'雜','种':'種',
    '态':'態','叶':'葉','绿':'綠','矿':'礦','气':'氣','压':'壓','脏':'臟','脑':'腦',
    '岛':'島','门':'門','静':'靜','脉':'脈','韧':'韌','卫':'衛','饱':'飽','缩':'縮',
    '横':'橫','肾':'腎','茎':'莖','腾':'騰','浓':'濃'
  };
  function norm(s) {
    return String(s).replace(new RegExp('[' + S2T_CHARS + ']', 'g'),
      function (ch) { return S2T_MAP[ch] || ch; });
  }

  var KW_ALIAS = { '蛋白合成': ['蛋白質合成'], '蛋白': ['蛋白質'] };
  function keywordsOf(it) {
    var kws = [];
    function add(w) {
      w = norm(w.trim());
      [w].concat(KW_ALIAS[w] || []).forEach(function (v) {
        if (v.length >= 2 && kws.indexOf(v) < 0) kws.push(v);
      });
    }
    (it.checks || []).forEach(function (c) {
      var m, re = /「([^」]+)」/g;
      while ((m = re.exec(c))) {
        add(m[1]);
        m[1].split(/[（）()／\/、，,；;：:]/).forEach(add);
      }
    });
    return kws;
  }
  function highlight(text, kws) {
    var html = esc(norm(text));
    kws.slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (kw) {
      var re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      html = html.replace(re, '<mark class="kw-hit">$&</mark>');
    });
    return html.split('\n').join('<br>');
  }

  /* ---------------- 路由 ---------------- */
  function route(preserveScroll) {
    window.DSELibrary.remember();
    if (imageObserver) imageObserver.disconnect();
    var h = location.hash.replace(/^#/, '').split('?')[0] || '/';
    var parts = h.split('/').filter(Boolean);
    var view = parts[0] || 'home';
    if (view !== 'library') releasePaper();
    $all('.rail-item,.tab-item').forEach(function (a) {
      a.classList.toggle('active', a.dataset.route === (view === 'library' && parts[1] === 'papers' ? 'papers' : view));
    });
    if (preserveScroll !== true) window.scrollTo(0, 0);
    if (PRIVATE_BANK && !bankLoaded && view !== 'records') {
      if (!localStorage.getItem(LS_SYNC_SESSION)) return renderBankGate();
      if (view !== 'home' && !(view === 'library' && parts[1] === 'papers')) return renderBankLoading();
    }
    if (view === 'home') return renderHome();
    if (view === 'practice') return renderPractice(parts[1] || 'chem');
    if (view === 'library') return renderLibrary(parts.slice(1));
    if (view === 'random') return renderRandomPicker();
    if (view === 'session') {
      renderSession(parts[1], decodeURIComponent(parts[2] || ''));
      return;
    }
    if (view === 'records') return renderRecords();
    renderHome();
  }
  window.addEventListener('hashchange', route);

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._tm);
    toast._tm = setTimeout(function () { t.hidden = true; }, 2200);
  }

  /* ---------------- 主頁 ---------------- */
  function renderHome() {
    var latest = latestMap();
    var totalItems = SUBJECT_ORDER.reduce(function (n, c) { return n + itemsOf(c).length; }, 0);
    var doneIds = {}; sessions.forEach(function (s) {
      Object.keys(s.results).forEach(function (id) { doneIds[id] = s.results[id]; });
    });
    var conquered = Object.keys(doneIds).filter(function (id) {
      var r = doneIds[id];
      return r.ok === true && (r.tot ? r.marks / r.tot >= 1 : true);
    }).length;
    var due = Math.max(0, totalItems - conquered);

    // 推薦課題：全部科目合併，按失分排序，取仍有未清錯題的前三
    var recs = [];
    SUBJECT_ORDER.forEach(function (code) {
      var st = topicStats(code);
      Object.keys(st).forEach(function (t) {
        recs.push({
          code: code, topic: t, marks: st[t].marks, n: st[t].n,
          due: dueCount(code, t, latest)
        });
      });
    });
    recs.sort(function (a, b) { return (b.due > 0 ? b.marks : -1) - (a.due > 0 ? a.marks : -1) || b.marks - a.marks; });
    var top = recs.slice(0, 3);

    $('#app').innerHTML =
      '<section class="home">' +
        '<div class="hero">' +
          '<div class="hero-kicker">DSE · 化學 / 生物</div>' +
          '<h1 class="hero-title">Kyle 嘅錯題本</h1>' +
          '<p class="hero-sub">錯過嘅唔可以再錯 —— 逐課題清，每個踩分點都執返。</p>' +
          '<p class="review-note" id="syncStatus" role="status" aria-live="polite"' + (syncMessage ? '' : ' hidden') + '>' + esc(syncMessage) + '</p>' +
          bankStatusHtml() +
          '<div class="hero-stat">' +
            '<span><b>' + (bankLoaded ? totalItems : '—') + '</b> 題在庫</span>' +
            '<span><b class="c-green">' + conquered + '</b> 已征服</span>' +
            '<span><b class="c-red">' + (bankLoaded ? due : '—') + '</b> 待清</span>' +
          '</div>' +
          '<div class="hero-cycle" id="heroCycle">' +
            '<span class="cycle-ico">🔄</span>' +
            '<span>雙週重置：<b id="cycleTimer">—</b></span>' +
            '<span class="cycle-note">到時進度歸零、重新征服（題庫同記錄圖保留）</span>' +
          '</div>' +
        '</div>' +

        '<div class="tile-grid">' +
          tile('#/practice/chem', '✏️', '開始練習', '按課題失分由高到低排，逐個擊破', 'tile-blue') +
          tile('#/library/books', '📚', '錯題庫', '按課題查答案、扣分點與掌握情況', 'tile-gold') +
          tile('#/library/papers', '🖊️', '紅筆批改卷', '按年份回顧原答，快捷跳轉各分部', 'tile-green') +
          tile('#/records', '📈', '做題記錄', '刷題熱力圖＋分數走勢', 'tile-gold') +
          tile('#/random', '🎲', '隨機十題', '化學／生物隨機抽 10 題速測', 'tile-green') +
        '</div>' +

        '<div class="home-sec">' +
          '<div class="home-sec-h"><h2>🔥 建議優先複習</h2><a class="link" href="#/practice/chem">全部課題 →</a></div>' +
          '<div class="rec-grid">' +
            (bankLoaded ? top.map(function (r) {
              var pct = pctOf(r.code, r.marks);
              return '<a class="rec-card" href="#/session/' + r.code + '/' + encodeURIComponent(r.topic) + '">' +
                '<div class="rec-top"><span class="rec-subj">' + SUBJECT_META[r.code].icon + ' ' +
                  esc(SUBJECT_META[r.code].name) + '</span>' +
                  (r.due ? '<span class="rec-due">待清 ' + r.due + '</span>' : '<span class="rec-ok">已清 ✔</span>') +
                '</div>' +
                '<div class="rec-name">' + esc(r.topic + ' ' + topicName(r.code, r.topic)) + '</div>' +
                '<div class="rec-bar"><i style="width:' + pct + '"></i></div>' +
                '<div class="rec-meta">' + r.n + ' 題錯 · 失分 ' + r.marks + ' 分 · 佔該科 ' + pct + '</div>' +
              '</a>';
            }).join('') : '<p class="review-note">錯題庫載入後顯示推薦課題。</p>') +
          '</div>' +
        '</div>' +
      '</section>';
    bindBankRetry();
    startCycleTimer();
  }

  /* ---------------- 私人錯題集與批改卷閱讀器 ---------------- */
  function clearReaderPages() {
    readerPages.forEach(function (entry) { if (entry.controller) entry.controller.abort(); });
    readerPages.clear();
  }
  function readerPage(path, session) {
    var key = session + ':' + path;
    var entry = readerPages.get(key);
    if (entry) {
      readerPages.delete(key);
      readerPages.set(key, entry);
      return entry.promise;
    }
    var controller = new AbortController();
    entry = { controller: controller, promise: null };
    var timeout = setTimeout(function () { controller.abort(); }, 30000);
    entry.promise = fetch(SYNC_API + path, {
      method: 'GET', headers: { Authorization: 'Bearer ' + session },
      cache: 'no-store', signal: controller.signal,
    }).then(function (response) {
      return response.ok ? response.blob() : readSyncResponse(response);
    }).then(function (blob) {
      entry.controller = null;
      if (localStorage.getItem(LS_SYNC_SESSION) !== session && readerPages.get(key) === entry) {
        readerPages.delete(key);
      }
      return blob;
    }).catch(function (err) {
      if (readerPages.get(key) === entry) readerPages.delete(key);
      throw err;
    }).finally(function () { clearTimeout(timeout); });
    readerPages.set(key, entry);
    while (readerPages.size > 6) {
      var oldest = readerPages.keys().next().value;
      var evicted = readerPages.get(oldest);
      readerPages.delete(oldest);
      if (evicted.controller) evicted.controller.abort();
    }
    return entry.promise;
  }
  function prefetchReaderPage(path, session) {
    if (localStorage.getItem(LS_SYNC_SESSION) === session) readerPage(path, session).catch(function () {});
  }
  function renderLibrary(parts) {
    releasePaper();
    parts = parts || [];
    if (parts[0] === 'books') return window.DSELibrary.render(parts.slice(1), {
      root: $('#app'), data: DATA, history: allSessions(), cycleStart: cycleStartOf(Date.now()),
      normalize: norm, formatDate: fmtDateTime, hydrate: hydratePrivateImages
    });
    if (parts[0] === 'papers') {
      if (parts.length === 1) return renderPaperSubjects();
      if (SUBJECT_ORDER.indexOf(parts[1]) >= 0) {
        if (parts.length === 2) return renderPaperYears(parts[1]);
        if (parts.length === 3 && /^\d{4}$/.test(parts[2])) return renderPaperReader(parts[1], parts[2]);
      }
    }
    var latest = latestMap(), total = 0, pending = 0;
    SUBJECT_ORDER.forEach(function (code) {
      itemsOf(code).forEach(function (item) {
        total++;
        var result = latest[item.id];
        if (!result || result.ok !== true || result.ratio < 1) pending++;
      });
    });
    $('#app').innerHTML = '<section class="page library-page library-hub">' +
      '<header class="page-head"><div><h1 class="page-title">📚 複習資料</h1>' +
      '<p class="page-sub">從錯因複習到整卷回顧，選擇今天的閱讀方向。</p></div>' +
      '<a class="btn btn-ghost" href="#/">← 主頁</a></header>' +
      '<div class="library-hub-grid">' +
        '<a class="library-hub-card library-hub-books" href="#/library/books">' +
          '<span class="library-hub-icon" aria-hidden="true">📚</span><span class="library-hub-kicker">按課題複習</span>' +
          '<h2>錯題庫</h2><p class="library-hub-description">把做錯的題、錯因與得分要點放在一起，逐個知識點讀懂。</p>' +
          '<div class="library-hub-stats"><span><b>' + total + '</b><small>收錄題目</small></span>' +
            '<span><b>' + pending + '</b><small>本輪待複習</small></span>' +
            '<span><b>' + (total - pending) + '</b><small>本輪已全對</small></span></div>' +
          '<div class="library-hub-tags">' + SUBJECT_ORDER.map(function (code) {
            return '<span>' + SUBJECT_META[code].icon + ' ' + SUBJECT_META[code].name + ' · ' + itemsOf(code).length + ' 題</span>';
          }).join('') + '</div><p class="library-hub-note">未練過或最新未全對的題目列為待複習。</p>' +
          '<span class="library-hub-action">按課題查看錯題 <span aria-hidden="true">↗</span></span></a>' +
        '<a class="library-hub-card library-hub-papers" href="#/library/papers">' +
          '<span class="library-hub-icon" aria-hidden="true">🖊️</span><span class="library-hub-kicker">按年份回顧</span>' +
          '<h2>紅筆批改卷</h2><p class="library-hub-description">回到原卷看批注，再用成績與等級差距找到下一步的目標。</p>' +
          '<div class="library-hub-stats"><span><b id="libraryPaperCount">—</b><small>已發布批改卷</small></span>' +
            '<span><b id="libraryPaperSubjects">—</b><small>收錄科目</small></span>' +
            '<span><b id="libraryNewestYear">—</b><small>最新試題年份</small></span></div>' +
          '<div class="library-hub-tags"><span>原卷紅筆批注</span><span>成績與參考等級</span><span>升級／保級差距</span></div>' +
          '<p class="library-hub-note" id="libraryPaperMeta" role="status" aria-live="polite">正在核對卷庫…</p>' +
          '<span class="library-hub-action">按科目與年份選卷 <span aria-hidden="true">↗</span></span></a>' +
      '</div></section>';
    loadLibraryOverview();
  }
  function fetchPaperCatalog(session, signal) {
    if (paperCatalogSnapshot && paperCatalogSnapshot.session === session && Date.now() - paperCatalogSnapshot.at < 30000) {
      return Promise.resolve(paperCatalogSnapshot.data);
    }
    return fetch(SYNC_API + '/papers/catalog', {
      method: 'GET', headers: { Authorization: 'Bearer ' + session }, cache: 'no-store', signal: signal,
    }).then(readSyncResponse).then(function (catalog) {
      if (!catalog || !catalog.subjects || !SUBJECT_ORDER.every(function (code) {
        return Array.isArray(catalog.subjects[code]) && catalog.subjects[code].every(function (year) { return /^20\d{2}$/.test(year); });
      })) throw new Error('批改卷年份清單無效');
      if (localStorage.getItem(LS_SYNC_SESSION) === session) paperCatalogSnapshot = { session: session, at: Date.now(), data: catalog };
      return catalog;
    });
  }
  function loadLibraryOverview() {
    var session = localStorage.getItem(LS_SYNC_SESSION), requestId = ++paperRequest;
    var status = $('#libraryPaperMeta');
    if (!session || !SYNC_API) { status.textContent = '登入後可查看卷庫數量與年份。'; return; }
    var controller = new AbortController();
    paperController = controller;
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    fetchPaperCatalog(session, controller.signal).then(function (catalog) {
      if (requestId !== paperRequest || localStorage.getItem(LS_SYNC_SESSION) !== session) return;
      var years = [], count = 0, subjects = 0;
      SUBJECT_ORDER.forEach(function (code) {
        count += catalog.subjects[code].length;
        if (catalog.subjects[code].length) subjects++;
        years = years.concat(catalog.subjects[code]);
      });
      $('#libraryPaperCount').textContent = String(count);
      $('#libraryPaperSubjects').textContent = String(subjects);
      $('#libraryNewestYear').textContent = years.sort().reverse()[0] || '—';
      status.textContent = count ? '先選科目，再比較各年份的得分與升級空間。' : '批改完成並發布後，卷子會出現在這裡。';
    }).catch(function (err) {
      if (requestId !== paperRequest) return;
      expireConnection(err, session);
      status.textContent = '卷庫數量暫未能核對，可進入選卷頁重試。';
    }).finally(function () {
      clearTimeout(timeout);
      if (requestId === paperRequest) paperController = null;
    });
  }
  function paperGradeMetrics(assessment) {
    var levels = ['U', '1', '2', '3', '4', '5', '5*', '5**'];
    if (!assessment || !Number.isInteger(assessment.earned) || !Number.isInteger(assessment.total) ||
      assessment.total <= 0 || assessment.earned < 0 || assessment.earned > assessment.total) return null;
    var score = assessment.earned / assessment.total * 100;
    var boundaries = Array.isArray(assessment.boundaries) ? assessment.boundaries.filter(function (b) {
      return b && levels.indexOf(b.level) >= 0 && Number.isFinite(b.minimumPercent) && b.minimumPercent >= 0 && b.minimumPercent <= 100;
    }).sort(function (a, b) { return a.minimumPercent - b.minimumPercent; }) : [];
    var currentIndex = -1;
    boundaries.forEach(function (b, index) { if (score + 1e-9 >= b.minimumPercent) currentIndex = index; });
    var current = boundaries[currentIndex], next = boundaries[currentIndex + 1], previous = boundaries[currentIndex - 1];
    var floor = current ? Math.ceil(assessment.total * current.minimumPercent / 100 - 1e-9) : null;
    return { score: score, current: current, next: next, previous: previous,
      upMarks: next ? Math.ceil(assessment.total * next.minimumPercent / 100 - 1e-9) - assessment.earned : null,
      dropMarks: current ? assessment.earned - floor + 1 : null };
  }
  function renderPaperYear(subject, year, detail) {
    detail = detail || {};
    var assessment = detail.assessment, metrics = paperGradeMetrics(assessment);
    var tone = metrics && metrics.current ? ({ U: 'red', 1: 'red', 2: 'red', 3: 'amber', 4: 'blue', 5: 'green', '5*': 'gold', '5**': 'purple' })[metrics.current.level] : 'neutral';
    var score = '<span class="paper-score-empty">成績待補</span>', gaps = '<span class="paper-gap-empty">發布成績與參考分界後，顯示升級及保級差距。</span>';
    if (metrics) {
      score = '<span class="paper-grade grade-' + tone + '">' + (metrics.current ? esc(metrics.current.level) + ' · 估算' : '等級待確認') + '</span>' +
        '<b class="paper-score-value grade-text-' + tone + '">' + assessment.earned + ' <small>/ ' + assessment.total + ' 分</small></b>' +
        '<span class="paper-score-percent">' + metrics.score.toFixed(1) + '%</span>';
      var up = metrics.next ? '<b>升至 ' + esc(metrics.next.level) + ' 尚欠 ' + metrics.upMarks + ' 分</b><small>距 ' +
        metrics.next.minimumPercent + '% 分界 ' + (metrics.next.minimumPercent - metrics.score).toFixed(1) + ' 個百分點</small>' :
        '<b>' + (metrics.current && metrics.current.level === '5**' ? '已達最高參考等級' : '上級分界待補') + '</b>';
      var down = metrics.current && metrics.dropMarks <= assessment.earned ? '<b>再失 ' + metrics.dropMarks + ' 分' +
        (metrics.previous ? '跌至 ' + esc(metrics.previous.level) : '跌出 ' + esc(metrics.current.level)) + '</b><small>保級餘量 ' + (metrics.dropMarks - 1) +
        ' 分 · ' + metrics.current.minimumPercent + '% 分界</small>' : '<b>下級分界待補</b>';
      gaps = '<span class="paper-gap paper-gap-up">' + up + '</span><span class="paper-gap paper-gap-down">' + down + '</span>';
    }
    var components = metrics && Array.isArray(assessment.components) ? assessment.components.map(function (c) {
      return esc(c.label) + ' ' + c.earned + '/' + c.total;
    }).join(' · ') : '';
    return '<a class="paper-year" href="#/library/papers/' + subject + '/' + year + '">' +
      '<span class="paper-year-heading"><strong>' + year + '</strong><small>' + esc(metrics ? assessment.scope : '紅筆批改卷') + '</small></span>' +
      '<span class="paper-year-score">' + score + '</span><span class="paper-grade-gaps">' + gaps + '</span>' +
      '<span class="paper-year-arrow" aria-hidden="true">→</span>' +
      '<span class="paper-year-foot">' + (components ? components + ' · ' : '') + (Number.isInteger(detail.pages) ? detail.pages + ' 頁 · ' : '') +
        (metrics ? '等級按原批改總結的民間參考分界估算' : '可先閱讀完整批改卷') + '</span></a>';
  }
  function releasePaper() {
    paperRequest++;
    if (paperController) { paperController.abort(); paperController = null; }
    if (paperUrl) { URL.revokeObjectURL(paperUrl); paperUrl = null; }
    paperManifest = null;
    clearReaderPages();
  }
  function paperError(err, session, requestId, status, pageRequest) {
    if (requestId !== paperRequest) return;
    expireConnection(err, session);
    if (err.status === 401) return;
    if (err.name === 'AbortError') status.textContent = '載入逾時，請稍後重試。';
    else if (err.code === 'paper_not_accessible') status.textContent = pageRequest
      ? '批改卷可能已更新，請按「重新載入」取得新版頁面。'
      : '此年份的批改卷暫未發布，或私人資料倉庫內沒有對應圖片。';
    else status.textContent = '讀取失敗：' + err.message;
  }
  function renderPaperSubjects() {
    $('#app').innerHTML = '<section class="page library-page">' +
      '<header class="page-head"><div><h1 class="page-title">🖊️ 紅筆批改卷</h1>' +
      '<p class="page-sub">先選科目，再選年份；只會列出已發布的批改版本。</p></div>' +
      '<a class="btn btn-ghost" href="#/library">← 返回資料入口</a></header>' +
      '<div class="library-choices">' + SUBJECT_ORDER.map(function (code) {
        return '<a class="library-choice" href="#/library/papers/' + code + '"><span class="library-choice-icon">' +
          SUBJECT_META[code].icon + '</span><span><strong>' + SUBJECT_META[code].name +
          '</strong><small>選擇批改卷年份</small></span><span aria-hidden="true">→</span></a>';
      }).join('') + '</div></section>';
  }
  function renderPaperYears(subject) {
    paperSubject = subject;
    paperYear = '';
    $('#app').innerHTML = '<section class="page library-page">' +
      '<header class="page-head"><div><h1 class="page-title">' + SUBJECT_META[subject].icon + ' ' +
        SUBJECT_META[subject].name + '紅筆批改卷</h1>' +
      '<p class="page-sub">比較各年得分、參考等級與升級空間，再打開批改卷。</p></div>' +
      '<a class="btn btn-ghost" href="#/library/papers">← 返回科目</a></header>' +
      '<div class="panel"><p class="review-note" id="paperYearsStatus" role="status" aria-live="polite">正在載入年份…</p>' +
        '<div class="paper-years" id="paperYears"></div><p class="library-note">參考等級不是官方成績；分差按整數卷面分計算，百分點表示與分界的距離。僅卷一的成績不代表全科。</p></div></section>';
    var session = localStorage.getItem(LS_SYNC_SESSION), requestId = ++paperRequest;
    var status = $('#paperYearsStatus');
    if (!session || !SYNC_API) { status.textContent = '請先登入網站，再閱讀私人批改卷。'; return; }
    var controller = new AbortController();
    paperController = controller;
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    fetchPaperCatalog(session, controller.signal).then(function (catalog) {
      if (requestId !== paperRequest || localStorage.getItem(LS_SYNC_SESSION) !== session) return;
      if (!catalog || !catalog.subjects || !Array.isArray(catalog.subjects[subject])) {
        throw new Error('批改卷年份清單無效');
      }
      var years = catalog.subjects[subject].filter(function (year) { return /^20\d{2}$/.test(year); }).sort().reverse();
      if (!years.length) { status.textContent = '此科目尚無已發布的批改卷。'; return; }
      status.textContent = '已發布 ' + years.length + ' 個年份的批改卷。';
      $('#paperYears').innerHTML = years.map(function (year) {
        return renderPaperYear(subject, year, catalog.papers && catalog.papers[subject] && catalog.papers[subject][year]);
      }).join('');
    }).catch(function (err) {
      paperError(err, session, requestId, status, false);
    }).finally(function () {
      clearTimeout(timeout);
      if (requestId === paperRequest) paperController = null;
    });
  }
  function updatePaperControls() {
    if (!paperManifest) return;
    $('#paperPageSelect').innerHTML = Array.from({ length: paperManifest.pages }, function (_, index) {
      return '<option value="' + (index + 1) + '">' + (index + 1) + '</option>';
    }).join('');
    $('#paperPageSelect').value = String(paperPage);
    var sections = Array.isArray(paperManifest.sections) ? paperManifest.sections : [];
    var current = sections.filter(function (s) { return s.page <= paperPage; }).pop();
    var navigation = $('#paperSections');
    if (navigation._manifest !== paperManifest) {
      navigation.innerHTML = sections.map(function (s) {
        return '<button type="button" data-page="' + s.page + '" aria-current="' + (s === current) + '">' + esc(s.label) + '</button>';
      }).join('');
      navigation._manifest = paperManifest;
    }
    $all('[data-page]', navigation).forEach(function (button) {
      button.setAttribute('aria-current', String(!!current && Number(button.dataset.page) === current.page));
    });
    $('#paperSections').hidden = !sections.length;
    $('#paperPageCount').textContent = String(paperManifest.pages);
    $('#paperPrev').disabled = paperPage <= 1;
    $('#paperNext').disabled = paperPage >= paperManifest.pages;
  }
  function loadPaperPage() {
    if (!paperManifest) return;
    if (paperController) { paperController.abort(); paperController = null; }
    if (paperUrl) { URL.revokeObjectURL(paperUrl); paperUrl = null; }
    var session = localStorage.getItem(LS_SYNC_SESSION), requestId = ++paperRequest;
    var subject = paperSubject, year = paperYear, manifest = paperManifest, page = paperPage;
    var status = $('#paperStatus'), image = $('#paperImage'), open = $('#paperOpen');
    image.hidden = true;
    image.src = '';
    open.hidden = true;
    open.href = '';
    updatePaperControls();
    if (!session) { status.textContent = '請先登入網站，再閱讀批改卷。'; return; }
    status.textContent = '正在載入' + SUBJECT_META[subject].name + ' ' + year + ' 年批改卷第 ' + page + ' 頁…';
    readerPage('/papers/' + subject + '/' + year + '/pages/' + manifest.version + '/' + page, session).then(function (blob) {
      if (requestId !== paperRequest || localStorage.getItem(LS_SYNC_SESSION) !== session ||
        paperSubject !== subject || paperYear !== year) return;
      paperUrl = URL.createObjectURL(blob);
      image.alt = SUBJECT_META[subject].name + ' ' + year + ' 年紅筆批改卷第 ' + page + ' 頁';
      image.onerror = function () {
        if (requestId === paperRequest) status.textContent = '頁面圖片未能顯示，請按「重新載入」再試。';
      };
      image.src = paperUrl;
      image.hidden = false;
      open.href = paperUrl;
      open.hidden = false;
      status.textContent = '第 ' + page + ' / ' + manifest.pages + ' 頁，可用上方按鈕翻頁。';
      if (page < manifest.pages) setTimeout(function () {
        if (requestId === paperRequest && paperManifest === manifest && paperSubject === subject && paperYear === year) {
          prefetchReaderPage('/papers/' + subject + '/' + year + '/pages/' + manifest.version + '/' + (page + 1), session);
        }
      }, 200);
    }).catch(function (err) {
      paperError(err, session, requestId, status, true);
    });
  }
  function goPaperPage(page) {
    if (!paperManifest || !Number.isInteger(page) || page < 1 || page > paperManifest.pages || page === paperPage) return;
    paperPage = page;
    loadPaperPage();
  }
  function loadPaper(fresh) {
    var session = localStorage.getItem(LS_SYNC_SESSION), requestId = ++paperRequest;
    var status = $('#paperStatus');
    if (!session || !SYNC_API) { status.textContent = '請先登入網站，再閱讀私人批改卷。'; return; }
    var controller = new AbortController();
    paperController = controller;
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    status.textContent = '正在查看' + SUBJECT_META[paperSubject].name + ' ' + paperYear + ' 年批改卷頁數…';
    fetch(SYNC_API + '/papers/' + paperSubject + '/' + paperYear + '/manifest' + (fresh ? '?refresh=' + Date.now() : ''), {
      method: 'GET', headers: { Authorization: 'Bearer ' + session },
      cache: 'no-store', signal: controller.signal,
    }).then(readSyncResponse).then(function (manifest) {
      if (requestId !== paperRequest || localStorage.getItem(LS_SYNC_SESSION) !== session) return;
      if (!manifest || !/^[a-f0-9]{16}$/.test(manifest.version) ||
        !Number.isInteger(manifest.pages) || manifest.pages < 1) throw new Error('批改卷頁面清單無效');
      paperManifest = manifest;
      if (paperPage > manifest.pages) paperPage = 1;
      $('#paperReader').hidden = false;
      loadPaperPage();
    }).catch(function (err) {
      paperError(err, session, requestId, status, false);
    }).finally(function () {
      clearTimeout(timeout);
      if (requestId === paperRequest) paperController = null;
    });
  }
  function renderPaperReader(subject, year, fresh) {
    if (paperSubject !== subject || paperYear !== year) paperPage = 1;
    paperSubject = subject;
    paperYear = year;
    $('#app').innerHTML = '<section class="page library-page">' +
      '<header class="page-head"><div><h1 class="page-title">🖊️ ' + SUBJECT_META[subject].name + ' ' + year + ' 年批改卷</h1>' +
      '<p class="page-sub">保留原答與紅筆批注，使用分部導航直接跳到需要的位置。</p></div>' +
      '<a class="btn btn-ghost" href="#/library/papers/' + subject + '">← 返回年份</a></header>' +
      '<div class="panel"><div class="library-toolbar"><div class="record-tools">' +
        '<button class="btn btn-ghost" id="paperReload" type="button">重新載入</button>' +
        '<a class="btn btn-ghost" id="paperOpen" target="_blank" rel="noopener" hidden>在新分頁開啟</a>' +
      '</div></div><p class="review-note" id="paperStatus" role="status" aria-live="polite"></p>' +
      '<nav class="paper-sections" id="paperSections" aria-label="批改卷分部跳轉" hidden></nav>' +
      '<div class="book-reader" id="paperReader" hidden><div class="book-page-controls">' +
        '<button class="btn btn-ghost" id="paperPrev" type="button">← 上一頁</button>' +
        '<label>第 <select id="paperPageSelect" aria-label="選擇批改卷頁碼"></select> / ' +
        '<span id="paperPageCount">—</span> 頁</label>' +
        '<button class="btn btn-ghost" id="paperNext" type="button">下一頁 →</button></div>' +
        '<img class="book-image" id="paperImage" alt="紅筆批改卷頁面" hidden></div>' +
      '<p class="library-note">閱讀時預先載入下一頁，已看過的頁面暫存在此分頁；更新批改卷後按「重新載入」可取得新版。</p></div></section>';
    $('#paperReader').hidden = true;
    $('#paperImage').hidden = true;
    $('#paperImage').src = '';
    $('#paperOpen').hidden = true;
    $('#paperOpen').href = '';
    $('#paperReload').addEventListener('click', function () { releasePaper(); renderPaperReader(subject, year, true); });
    $('#paperSections').addEventListener('click', function (event) {
      var button = event.target.closest('[data-page]');
      if (button) goPaperPage(Number(button.dataset.page));
    });
    $('#paperPrev').addEventListener('click', function () { goPaperPage(paperPage - 1); });
    $('#paperNext').addEventListener('click', function () { goPaperPage(paperPage + 1); });
    $('#paperPageSelect').addEventListener('change', function (event) { goPaperPage(Number(event.target.value)); });
    loadPaper(fresh);
  }

  /* ---------------- 雙週倒計時 ---------------- */
  var cycleTimerId = null;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function cycleText(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var wk = Math.floor(s / 604800); s -= wk * 604800;
    var dy = Math.floor(s / 86400); s -= dy * 86400;
    var hr = Math.floor(s / 3600); s -= hr * 3600;
    var mn = Math.floor(s / 60), sc = s % 60;
    return wk + ' 週 ' + dy + ' 日 ' + pad2(hr) + ' 時 ' + pad2(mn) + ' 分 ' + pad2(sc) + ' 秒後刷新';
  }
  function startCycleTimer() {
    clearInterval(cycleTimerId);
    var el = $('#cycleTimer');
    function tick() {
      var remain = cycleEndOf(Date.now()) - Date.now();
      if (remain <= 0) {
        clearInterval(cycleTimerId);
        if (ensureCycle()) {
          toast('🔄 新嘅雙週開始，進度已重置！');
          route();
        }
        return;
      }
      if (el) el.textContent = cycleText(remain);
    }
    tick();
    cycleTimerId = setInterval(tick, 1000);
  }
  function tile(href, ico, title, desc, cls) {
    return '<a class="tile ' + cls + '" href="' + href + '">' +
      '<div class="tile-ico">' + ico + '</div>' +
      '<div class="tile-body"><div class="tile-title">' + title + '</div>' +
      '<div class="tile-desc">' + desc + '</div></div>' +
      '<div class="tile-arrow">→</div></a>';
  }
  function pctOf(code, marks) {
    var st = topicStats(code);
    var all = Object.keys(st).reduce(function (s, t) { return s + st[t].marks; }, 0);
    return (all ? Math.round(marks / all * 100) : 0) + '%';
  }

  /* ---------------- 練習頁：科目切換＋課題排序 ---------------- */
  function renderPractice(code) {
    if (SUBJECT_META[code] && SUBJECT_META[code].soon) {
      $('#app').innerHTML = '<section class="page"><div class="soon-banner">📐 ' +
        esc(SUBJECT_META[code].name) + ' 錯題庫即將推出，考完好試卷就會自動出現。</div>' +
        '<a class="btn btn-primary" href="#/practice/chem">← 返化學</a></section>';
      return;
    }
    if (!subjOf(code)) code = 'chem';
    var st = topicStats(code), latest = latestMap();
    var totalMarks = Object.keys(st).reduce(function (s, t) { return s + st[t].marks; }, 0);
    var rows = Object.keys(st).map(function (t) {
      return { topic: t, marks: st[t].marks, n: st[t].n, due: dueCount(code, t, latest) };
    }).sort(function (a, b) {
      // 有待清的先排，其內按失分降序
      if ((a.due > 0) !== (b.due > 0)) return a.due > 0 ? -1 : 1;
      return b.marks - a.marks;
    });

    var tabs = ['chem', 'bio', 'math'].map(function (c) {
      var m = SUBJECT_META[c];
      if (m.soon) {
        return '<button class="subj-tab is-soon" type="button" disabled>' +
          m.icon + ' ' + m.name + '<small>即將</small></button>';
      }
      return '<a class="subj-tab' + (c === code ? ' on' : '') + '" href="#/practice/' + c + '">' +
        m.icon + ' ' + m.name + '</a>';
    }).join('');

    $('#app').innerHTML =
      '<section class="page">' +
        '<header class="page-head">' +
          '<div><h1 class="page-title">' + SUBJECT_META[code].icon + ' ' + esc(subjOf(code).name) + '練習</h1>' +
          '<p class="page-sub">按每個課題嘅失分同佔比排序，失分越多排越前。</p></div>' +
          '<a class="btn btn-ghost" href="#/">← 主頁</a>' +
        '</header>' +
        '<div class="subj-tabs">' + tabs + '</div>' +
        '<div class="topic-list">' +
          rows.map(function (r, i) {
            var pct = (totalMarks ? Math.round(r.marks / totalMarks * 100) : 0);
            return '<a class="topic-card' + (r.due ? '' : ' is-clear') + '" ' +
              'href="#/session/' + code + '/' + encodeURIComponent(r.topic) + '">' +
              '<div class="topic-rank rank-' + Math.min(i + 1, 4) + '">' + (i + 1) + '</div>' +
              '<div class="topic-main">' +
                '<div class="topic-name">' + esc(r.topic + ' ' + topicName(code, r.topic)) + '</div>' +
                '<div class="topic-bar"><i style="width:' + pct + '%"></i></div>' +
                '<div class="topic-meta">' + r.n + ' 道錯題 · 失分 <b>' + r.marks + '</b> 分 · 佔比 ' + pct + '%</div>' +
              '</div>' +
              '<div class="topic-side">' +
                (r.due ? '<span class="pill pill-red">待清 ' + r.due + '</span>'
                       : '<span class="pill pill-green">已清 ✔</span>') +
                '<span class="topic-go">開始 →</span>' +
              '</div>' +
            '</a>';
          }).join('') +
        '</div>' +
        '<a class="btn btn-random" href="#/session/' + code + '/' + encodeURIComponent('__random__') +
          '">🎲 隨機抽 10 題速測</a>' +
      '</section>';
  }

  /* ---------------- 隨機十題科目選擇 ---------------- */
  function renderRandomPicker() {
    var cards = SUBJECT_ORDER.concat(['math']).map(function (code) {
      var m = SUBJECT_META[code];
      var n = subjOf(code) ? itemsOf(code).length : 0;
      if (code === 'math' || !n) {
        return '<div class="rand-card is-soon">' +
          '<div class="rand-ico">' + m.icon + '</div>' +
          '<div class="rand-name">' + esc(m.name) + '</div>' +
          '<div class="rand-note">題庫暫時未有題</div></div>';
      }
      return '<a class="rand-card" href="#/session/' + code + '/' + encodeURIComponent('__random__') + '">' +
        '<div class="rand-ico">' + m.icon + '</div>' +
        '<div class="rand-name">' + esc(m.name) + '</div>' +
        '<div class="rand-note">' + n + ' 題錯題中隨機抽 10 題 →</div></a>';
    }).join('');
    $('#app').innerHTML =
      '<section class="page">' +
        '<header class="page-head"><div><h1 class="page-title">🎲 隨機十題</h1>' +
        '<p class="page-sub">揀一科，由全部錯題隨機抽 10 題出嚟，入面仲可以隨時「換一組」。</p></div>' +
        '<a class="btn btn-ghost" href="#/">← 主頁</a></header>' +
        '<div class="rand-grid">' + cards + '</div>' +
      '</section>';
  }

  /* ---------------- 做題會話 ---------------- */
  var reviewState = null;   // 提交後的批改結果
  var sessState = { code: null, topic: null, mcOnly: false };

  function sessionItems(code, topic, mcOnly) {
    var pool = itemsOf(code).filter(function (it) {
      return it.topic === topic && (!mcOnly || it.kind === 'mc');
    });
    if (topic === '__random__') {
      pool = itemsOf(code).filter(function (it) { return !mcOnly || it.kind === 'mc'; });
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1)), t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
      pool = pool.slice(0, 10);
    }
    return pool;
  }

  function renderSession(code, topic, mcOnly) {
    if (!topic) { location.hash = '#/practice'; return; }
    if (code === 'math' || !subjOf(code)) {
      $('#app').innerHTML =
        '<section class="page"><div class="soon-banner">📐 ' + esc(SUBJECT_META[code] ? SUBJECT_META[code].name : code) +
        ' 嘅錯題庫暫時未有題，改完好試卷就會自動出現。</div>' +
        '<a class="btn btn-primary" href="#/random">← 返隨機十題</a></section>';
      return;
    }
    if (mcOnly === undefined) mcOnly = false;
    sessState = { code: code, topic: topic, mcOnly: mcOnly };
    var items = sessionItems(code, topic, mcOnly);
    if (!items.length) { location.hash = '#/practice/' + code; return; }
    // 課題模式仍渲染全部題（大題靠 CSS 動畫收起）；隨機模式只渲染抽出的題
    var renderItems = (topic === '__random__') ? items :
      itemsOf(code).filter(function (it) { return it.topic === topic; });
    var activeIds = {};
    items.forEach(function (it) { activeIds[it.id] = true; });

    var dkey = code + ':' + topic +
      (topic === '__random__' ? ':' + (mcOnly ? 'mc:' : '') +
        items.map(function (i) { return i.id; }).join(',') : '');
    var draft = drafts[dkey] || { pick: {}, text: {}, paper: {} };
    reviewState = null;

    var title = topic === '__random__'
      ? (mcOnly ? '🎲 隨機十題（選擇題）' : '🎲 隨機十題')
      : esc(topic + ' ' + topicName(code, topic));
    var nMc = renderItems.filter(function (it) { return it.kind === 'mc'; }).length;
    var nSub = renderItems.length - nMc;
    $('#app').innerHTML =
      '<section class="page session' + (mcOnly ? ' mc-only' : '') +
        '" data-key="' + esc(dkey) + '" data-code="' + code + '" data-topic="' + esc(topic) + '">' +
        '<header class="page-head">' +
          '<div><h1 class="page-title">' + SUBJECT_META[code].icon + ' ' + title + '</h1>' +
          '<p class="page-sub"><span id="answeredCount">0</span> / <span id="totalCount">' +
            items.length + '</span> 題已作答 · MC 自動批改，大題照踩分點自己勾分</p></div>' +
          '<div class="head-actions">' +
            (topic === '__random__'
              ? '<button class="btn btn-gold" id="rerollBtn" type="button">🔄 換一組十題</button>' : '') +
            '<label class="mc-toggle" title="時間唔夠就只刷選擇題，大題會收起、唔計分、唔入記錄">' +
              '<input type="checkbox" id="mcOnlyChk"' + (mcOnly ? ' checked' : '') +
                (nMc ? '' : ' disabled') + '><span class="mc-switch"></span>' +
              '<span class="mc-toggle-lbl">⚡ 只做選擇題' +
                (nSub ? '<small>' + nMc + ' MC / ' + nSub + ' 大題</small>' : '') + '</span>' +
            '</label>' +
            '<a class="btn btn-ghost" href="' +
              (topic === '__random__' ? '#/random' : '#/practice/' + code) + '">← 離開</a>' +
          '</div>' +
        '</header>' +
        (topic === '__random__'
          ? '<div class="subj-tabs rand-tabs">' +
              ['chem', 'bio', 'math'].map(function (c) {
                var m = SUBJECT_META[c];
                var n = subjOf(c) ? itemsOf(c).length : 0;
                if (!n) return '<span class="subj-tab is-soon">' + m.icon + ' ' + m.name +
                  '<small>未有題</small></span>';
                return '<a class="subj-tab' + (c === code ? ' on' : '') +
                  '" href="#/session/' + c + '/' + encodeURIComponent('__random__') + '">' +
                  m.icon + ' ' + m.name + '</a>';
              }).join('') +
            '</div>' : '') +
        (mcOnly && nSub ? '<div class="mc-only-note">⚡ 已切為只做選擇題：' + nSub +
          ' 道大題已收起，今次唔使答、唔計分、唔入記錄。</div>' : '') +
        '<div class="q-paper" id="qPaper">' +
          renderItems.map(function (it, idx) { return questionHtml(it, idx, draft); }).join('') +
        '</div>' +
        '<div class="submit-bar" id="submitBar">' +
          '<button class="btn btn-primary btn-lg" id="submitBtn" type="button">' +
            (mcOnly ? '✅ 提交 ' + nMc + ' 道選擇題' : '✅ 全部做完，一次過提交') + '</button>' +
        '</div>' +
        '<div class="result-panel" id="resultPanel" hidden></div>' +
      '</section>';

    bindSession(code, topic, dkey, renderItems, items, mcOnly);
    hydratePrivateImages();
  }

  function questionHtml(it, idx, draft) {
    var head =
      '<div class="sq-head">' +
        '<span class="sq-no">' + (idx + 1) + '</span>' +
        '<span class="sq-badge">' + esc(it.year + ' ' + it.paper + ' · ' + it.qref) + '</span>' +
        '<span class="sq-kind ' + (it.kind === 'mc' ? 'k-mc' : 'k-sub') + '">' +
          (it.kind === 'mc' ? '選擇 ' + marksOf(it) + ' 分' : '大題 ' + marksOf(it) + ' 分') + '</span>' +
      '</div>';

    var body = '';
    if (it.kind === 'mc') {
      var picked = draft.pick[it.id] || '';
      body =
        (it.img ? '<img class="q-img" ' + (PRIVATE_BANK ? 'data-bank-image="' + esc(it.img) + '"' : 'src="' + esc(it.img) + '"') + ' alt="原題裁圖">' :
                  '<div class="q-stem">' + esc(it.stem) + '</div>') +
        '<div class="opts" data-id="' + esc(it.id) + '">' +
          ['A', 'B', 'C', 'D'].map(function (l) {
            return '<button type="button" class="opt' + (picked === l ? ' picked' : '') +
              '" data-l="' + l + '">' + l + '</button>';
          }).join('') +
        '</div>';
    } else {
      var v = draft.text[it.id] || '';
      body =
        '<div class="q-stem">' + esc(it.stem) + '</div>' +
        '<textarea class="ans-box" data-id="' + esc(it.id) + '" rows="4" ' +
          'placeholder="默寫答案（可留白，改用紙寫就剔下面格仔）……">' + esc(v) + '</textarea>' +
        '<label class="paper-lbl"><input type="checkbox" class="paper-chk" data-id="' + esc(it.id) + '"' +
          (draft.paper[it.id] ? ' checked' : '') + '> 我已喺紙上寫完</label>';
    }
    return '<article class="sq" data-id="' + esc(it.id) + '" data-kind="' + it.kind + '">' + head + body + '</article>';
  }

  function bindSession(code, topic, dkey, renderItems, initialActive, mcOnly) {
    var activeItems = initialActive;
    var draft = drafts[dkey] || { pick: {}, text: {}, paper: {}, changedAt: {}, deletedAt: 0 };
    function persist(kind, id) {
      var value = draft[kind][id];
      draft = mergeDraft(drafts[dkey], draft);
      draft[kind][id] = value;
      draft.changedAt = draft.changedAt || {};
      var key = kind + ':' + id;
      draft.changedAt[key] = Math.max(Date.now(), Number(draft.changedAt[key]) + 1 || 0, Number(draft.deletedAt) + 1 || 0);
      drafts[dkey] = draft; save(); updateAnswered();
    }
    function answeredCount() {
      return activeItems.filter(function (it) {
        if (it.kind === 'mc') return !!draft.pick[it.id];
        return (draft.text[it.id] && draft.text[it.id].trim()) || draft.paper[it.id];
      }).length;
    }
    function updateAnswered() {
      $('#answeredCount').textContent = answeredCount();
      $('#totalCount').textContent = activeItems.length;
    }
    function submitLabel() {
      var nMc = activeItems.filter(function (it) { return it.kind === 'mc'; }).length;
      $('#submitBtn').textContent = sessState.mcOnly
        ? '✅ 提交 ' + nMc + ' 道選擇題'
        : '✅ 全部做完，一次過提交';
    }
    updateAnswered(); submitLabel();

    // 隨機十題「換一組」：清走之前未提交嘅隨機草稿，重新抽題打亂
    var rerollBtn = $('#rerollBtn');
    if (rerollBtn) {
      rerollBtn.addEventListener('click', function () {
        var pfx = code + ':__random__';
        Object.keys(drafts).forEach(function (k) {
          if (k.indexOf(pfx) === 0) deleteDraft(k);
        });
        save();
        renderSession(code, topic, sessState.mcOnly);
        toast('🎲 已換一組新題');
      });
    }

    // 「只做選擇題」開關：課題頁就地動畫收起/展開；隨機頁重新抽 MC
    $('#mcOnlyChk').addEventListener('change', function () {
      var mc = this.checked;
      sessState.mcOnly = mc;
      if (topic === '__random__') { renderSession(code, topic, mc); return; }
      activeItems = sessionItems(code, topic, mc);
      var sec = $('.session');
      sec.classList.toggle('mc-only', mc);
      var qPaper = $('#qPaper');
      var oldNote = $('.mc-only-note', sec);
      var nSub = renderItems.filter(function (it) { return it.kind === 'sub'; }).length;
      if (mc && nSub && !oldNote) {
        var note = document.createElement('div');
        note.className = 'mc-only-note';
        note.textContent = '⚡ 已切為只做選擇題：' + nSub +
          ' 道大題已收起，今次唔使答、唔計分、唔入記錄。';
        sec.insertBefore(note, qPaper);
      } else if (!mc && oldNote) {
        oldNote.remove();
      }
      updateAnswered(); submitLabel();
    });

    $all('.opts', $('#app')).forEach(function (box) {
      box.addEventListener('click', function (e) {
        if (reviewState) return;
        var b = e.target.closest('.opt'); if (!b) return;
        var id = box.dataset.id, l = b.dataset.l;
        draft.pick[id] = (draft.pick[id] === l) ? '' : l;
        $all('.opt', box).forEach(function (x) {
          x.classList.toggle('picked', x.dataset.l === draft.pick[id]);
        });
        persist('pick', id);
      });
    });
    $all('.ans-box', $('#app')).forEach(function (ta) {
      ta.addEventListener('input', function () { draft.text[ta.dataset.id] = ta.value; persist('text', ta.dataset.id); });
    });
    $all('.paper-chk', $('#app')).forEach(function (cb) {
      cb.addEventListener('change', function () { draft.paper[cb.dataset.id] = cb.checked; persist('paper', cb.dataset.id); });
    });

    $('#submitBtn').addEventListener('click', function () {
      var miss = activeItems.filter(function (it) {
        if (it.kind === 'mc') return !draft.pick[it.id];
        return !((draft.text[it.id] && draft.text[it.id].trim()) || draft.paper[it.id]);
      });
      if (miss.length) {
        toast(sessState.mcOnly
          ? '仲有 ' + miss.length + ' 題 MC 未揀'
          : '仲有 ' + miss.length + ' 題未作答（MC 要揀，大題要默寫或剔紙上寫完）');
        var el = $('.sq[data-id="' + miss[0].id + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      submitSession(code, topic, dkey, activeItems, draft, sessState.mcOnly);
    });
  }

  /* ---------- 提交批改 ---------- */
  function submitSession(code, topic, dkey, items, draft, mcOnly) {
    reviewState = { results: {} };
    var mcFull = 0, mcMarks = 0, subFull = 0;

    items.forEach(function (it) {
      if (it.kind === 'mc') {
        var correctL = letterOf(it.correctOpt);
        var picked = draft.pick[it.id] || '';
        var ok = picked === correctL;
        mcFull += 1; mcMarks += ok ? 1 : 0;
        reviewState.results[it.id] = { kind: 'mc', picked: picked, ok: ok, marks: ok ? 1 : 0, tot: 1 };
      } else {
        subFull += marksOf(it);
      }
    });

    // 渲染批改面板（MC 直接出結果；大題出踩分點表單）
    var html = '<div class="rp-head">' +
      '<h2>📋 批改結果' + (mcOnly ? '（只做選擇題，已自動批改）' : '（MC 已自動改，大題自己照踩分點剔分）') + '</h2>' +
      '<div class="rp-score">MC <b id="mcScore">' + mcMarks + ' / ' + mcFull + '</b> 分' +
      (mcOnly ? '' : '　·　大題 <b id="subScore">0 / ' + subFull + '</b> 分') +
      '　·　總分 <b id="allScore">' + mcMarks + ' / ' + (mcFull + subFull) + '</b></div></div>';

    items.forEach(function (it, idx) {
      html += '<article class="rq ' + (it.kind === 'mc' ? 'rq-mc' : 'rq-sub') + '" data-id="' + esc(it.id) + '">';
      html += '<div class="sq-head"><span class="sq-no">' + (idx + 1) + '</span>' +
        '<span class="sq-badge">' + esc(it.qref) + '</span></div>';

      if (it.kind === 'mc') {
        var correctL = letterOf(it.correctOpt), picked = draft.pick[it.id];
        var ok = picked === correctL;
        html += '<div class="judge ' + (ok ? 'j-ok' : 'j-bad') + '">' +
          (ok ? '✅ 答對（' + picked + '）' : '❌ 你揀 ' + picked + ' · 正解 ' + correctL) + '</div>' +
          answerBlocks(it, false, '');
      } else {
        var draftText = draft.text[it.id] || '';
        if (draftText.trim()) {
          html += '<div class="ans-block ans-type"><div class="ans-title">✍️ 你今次默寫</div>' +
            '<div class="ans-body">' + highlight(draftText, keywordsOf(it)) + '</div></div>';
        }
        html += answerBlocks(it, true, '');
        var checks = it.checks || [];
        var wList = checks.map(function (c) { return /^✗/.test(c) ? 0 : 1; });
        var wTot = wList.reduce(function (a, b) { return a + b; }, 0);
        html += '<div class="chk-form" data-id="' + esc(it.id) + '" data-marks="' + marksOf(it) +
          '" data-wtot="' + wTot + '">' +
          '<div class="chk-form-h">🎯 你寫到邊個踩分點？（剔中 ' +
            '<span class="chk-got">0</span>/<span class="chk-tot">' + wTot + '</span>' +
            '　→　<b class="chk-score">0</b>/' + marksOf(it) + ' 分；⚠️ 項只係防錯提醒，唔計分）</div>' +
          checks.map(function (c, i) {
            return '<label class="chk-line' + (wList[i] ? '' : ' is-warn') + '">' +
              '<input type="checkbox" data-i="' + i + '" data-w="' + wList[i] + '">' +
              '<span class="chk-text">' + checkText(c) + '</span></label>';
          }).join('') + '</div>';
      }
      html += '</article>';
    });

    html += '<div class="rp-actions">' +
      '<button class="btn btn-primary btn-lg" id="saveSessionBtn" type="button">💾 儲存做題記錄</button>' +
      '<a class="btn btn-ghost" href="#/practice/' + code + '">返課題列表</a></div>';

    var panel = $('#resultPanel');
    panel.hidden = false;
    panel.innerHTML = html;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    function recalcSub() {
      var got = 0;
      $all('.chk-form', panel).forEach(function (f) {
        var n = $all('input:checked', f).reduce(function (s, cb) {
          return s + parseInt(cb.dataset.w, 10);
        }, 0);
        var tot = parseInt(f.dataset.wtot, 10);
        var sc = tot ? Math.round(parseFloat(f.dataset.marks) * n / tot) : 0;
        $('.chk-got', f).textContent = n;
        $('.chk-score', f).textContent = sc;
        reviewState.results[f.dataset.id] = {
          kind: 'sub', marks: sc, tot: parseFloat(f.dataset.marks),
          ok: sc >= parseFloat(f.dataset.marks), got: n, checks: tot
        };
        got += sc;
      });
      $('#subScore').innerHTML = '';
      $('#subScore').appendChild(document.createElement('b')).textContent = got + ' / ' + subFull;
      $('#allScore').innerHTML = '';
      $('#allScore').appendChild(document.createElement('b')).textContent =
        (mcMarks + got) + ' / ' + (mcFull + subFull);
    }
    $all('.chk-form input', panel).forEach(function (cb) {
      cb.addEventListener('change', recalcSub);
    });

    $('#saveSessionBtn').addEventListener('click', function () {
      // 落齊大題結果（未剔任何項也要存 0 分）
      items.forEach(function (it) {
        if (it.kind !== 'sub' || mcOnly) return;
        var f = $('.chk-form[data-id="' + it.id + '"]', panel);
        var n = $all('input:checked', f).reduce(function (s, cb) {
          return s + parseInt(cb.dataset.w, 10);
        }, 0);
        var tot = parseInt(f.dataset.wtot, 10);
        var sc = tot ? Math.round(marksOf(it) * n / tot) : 0;
        reviewState.results[it.id] = {
          kind: 'sub', marks: sc, tot: marksOf(it), ok: sc >= marksOf(it),
          got: n, checks: tot
        };
      });
      var subGotFinal = Object.keys(reviewState.results).reduce(function (s, id) {
        var r = reviewState.results[id];
        return s + (r.kind === 'sub' ? r.marks : 0);
      }, 0);
      var savedAt = Date.now();
      Object.keys(reviewState.results).forEach(function (id) {
        updateReviewPlan(id, reviewState.results[id], savedAt);
      });
      sessions.push({
        t: savedAt, subj: code, topic: topic, mcOnly: !!mcOnly,
        results: reviewState.results,
        mc: mcMarks + '/' + mcFull, sub: mcOnly ? null : (subGotFinal + '/' + subFull)
      });
      if (mcOnly && topic !== '__random__') {
        // 只清今次提交嘅 MC 揀答，保留大題默寫草稿
        items.forEach(function (it) {
          draft.pick[it.id] = '';
          draft.changedAt = draft.changedAt || {};
          var key = 'pick:' + it.id;
          draft.changedAt[key] = Math.max(Date.now(), Number(draft.changedAt[key]) + 1 || 0);
        });
        if (!Object.values(draft.pick).some(Boolean) &&
            !Object.values(draft.text).some(Boolean) && !Object.values(draft.paper).some(Boolean)) deleteDraft(dkey);
        else drafts[dkey] = draft;
      } else {
        deleteDraft(dkey);
      }
      save();
      var totalGot = mcMarks + (mcOnly ? 0 : subGotFinal);
      var totalFull = mcFull + (mcOnly ? 0 : subFull);
      var pct = Math.round(totalGot / totalFull * 100);
      panel.innerHTML =
        '<div class="saved-card">' +
          '<div class="saved-emoji">🎉</div>' +
          '<h2>已存入做題記錄</h2>' +
          '<div class="saved-score">' + totalGot + ' / ' + totalFull +
            ' 分（' + pct + '%）</div>' +
          '<div class="saved-sub">' + (mcOnly
            ? '⚡ 只做選擇題 · MC ' + mcMarks + '/' + mcFull
            : 'MC ' + mcMarks + '/' + mcFull + '　大題 ' + subGotFinal + '/' + subFull) + '</div>' +
          '<div class="rp-actions"><a class="btn btn-primary" href="#/records">📈 睇記錄</a>' +
          '<a class="btn btn-ghost" href="#/practice/' + code + '">繼續練習 →</a></div>' +
        '</div>';
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('記錄已儲存 ✔');
    });
  }

  function checkText(text) {
    var warn = /^✗/.test(text);
    var body = warn ? text.slice(1).trim() : text;
    var html = '';
    body.split(/「([^」]+)」/).forEach(function (p, i) {
      html += (i % 2 === 1) ? '<b class="kw">' + esc(p) + '</b>' : esc(p);
    });
    return (warn ? '<span class="chk-warn">⚠️ 防錯：</span>' : '') + html;
  }
  function answerBlocks(it, withMine, draftHtml) {
    var h = '';
    if (withMine && it.my && it.my.length) {
      h += '<div class="ans-block ans-mine"><div class="ans-title">📝 你當年嘅答案</div><div class="ans-body">' +
        it.my.map(function (s) {
          return s[1] ? '<span class="bad-seg">' + esc(s[0]) + '</span>' : esc(s[0]);
        }).join('<br>') + '</div></div>';
    }
    if (it.kind === 'mc') {
      h += '<div class="ans-block ans-mine"><div class="ans-title">📝 當年你揀</div>' +
        '<div class="ans-body">' + esc(it.option || '—') + '</div></div>';
    }
    h += '<div class="ans-block ans-deduct"><div class="ans-title">❌ 錯因分析</div>' +
      '<div class="ans-body">' + esc(it.deduct || '—') + '</div></div>';
    h += '<div class="ans-block ans-correct"><div class="ans-title">✅ 正解詳解</div>' +
      '<div class="ans-body">' + esc(it.kind === 'mc' ? (it.correctOpt || '—') : (it.correct || '—')) + '</div></div>';
    if (it.points) {
      h += '<div class="ans-block ans-points"><div class="ans-title">📌 評分備註</div>' +
        '<div class="ans-body">' + esc(it.points) + '</div></div>';
    }
    return h;
  }

  /* ---------------- 記錄頁 ---------------- */
  var selectedReportCycle = null;
  function reportPeriodStarts(now) {
    var current = cycleStartOf(now), periods = new Set([current]);
    allSessions().forEach(function (s) {
      if (s && Number.isFinite(s.t) && s.t <= now) periods.add(cycleStartOf(s.t));
    });
    return Array.from(periods).sort(function (a, b) { return b - a; });
  }
  function buildCycleReport(start, now) {
    var bankItems = new Map();
    SUBJECT_ORDER.forEach(function (code) {
      itemsOf(code).forEach(function (it) { bankItems.set(it.id, { code: code, it: it }); });
    });
    var state = new Map(), seenSessions = new Set(), end = Math.min(start + CYCLE_MS, now + 1);
    allSessions().filter(function (s) { return s && Number.isFinite(s.t) && s.t < end && s.results; })
      .sort(function (a, b) { return a.t - b.t; }).forEach(function (s) {
        var sessionKey = [s.t, s.subj, s.topic, JSON.stringify(s.results)].join('|');
        if (seenSessions.has(sessionKey)) return;
        seenSessions.add(sessionKey);
        Object.keys(s.results).forEach(function (id) {
          var item = bankItems.get(id), result = s.results[id];
          if (!item || !result) return;
          var row = state.get(id) || { code: item.code, it: item.it, everCorrect: false,
            firstCorrectHere: false, latest: null };
          var ratio = result.tot ? result.marks / result.tot : (result.ok ? 1 : 0);
          var correct = fullRight({ ok: result.ok, ratio: ratio });
          if (s.t >= start) {
            if (correct && !row.everCorrect) row.firstCorrectHere = true;
            row.latest = { correct: correct, hadCorrectBefore: row.everCorrect,
              ratio: ratio, date: s.t };
          }
          if (correct) row.everCorrect = true;
          state.set(id, row);
        });
      });
    var attempted = [], correct = [], newSolved = [], regressed = [];
    state.forEach(function (row) {
      if (!row.latest) return;
      attempted.push(row);
      if (row.latest.correct) {
        correct.push(row);
        if (row.firstCorrectHere) newSolved.push(row);
      } else if (row.latest.hadCorrectBefore) regressed.push(row);
    });
    [newSolved, regressed].forEach(function (rows) {
      rows.sort(function (a, b) { return b.latest.date - a.latest.date; });
    });
    return { total: bankItems.size, attempted: attempted.length, correct: correct.length,
      newSolved: newSolved, regressed: regressed };
  }
  function reportRowsHtml(rows, empty, regressed) {
    if (!rows.length) return '<p class="cycle-report-empty">' + empty + '</p>';
    return '<div class="cycle-report-items">' + rows.map(function (row) {
      var it = row.it;
      return '<a class="cycle-report-item" href="#/session/' + row.code + '/' + encodeURIComponent(it.topic) + '">' +
        '<span><b>' + SUBJECT_META[row.code].icon + ' ' + esc(it.year + ' ' + it.qref) + '</b>' +
        '<small>' + esc(topicName(row.code, it.topic)) + ' · ' + fmtDate(row.latest.date) +
        (regressed ? ' · 最近得分率 ' + Math.round(row.latest.ratio * 100) + '%' : ' · 最新作答滿分') +
        '</small></span><span aria-hidden="true">→</span></a>';
    }).join('') + '</div>';
  }
  function cycleReportHtml() {
    if (PRIVATE_BANK && !bankLoaded) return '<div class="panel cycle-report"><h2 class="panel-h">📋 雙週復習報告</h2>' +
      '<p class="review-note">登入並載入私人題庫後，即可查看本期與往期報告。</p></div>';
    var now = Date.now(), current = cycleStartOf(now), periods = reportPeriodStarts(now);
    if (selectedReportCycle == null || periods.indexOf(selectedReportCycle) < 0) selectedReportCycle = current;
    var start = selectedReportCycle, report = buildCycleReport(start, now);
    var pct = report.total ? Math.round(report.correct / report.total * 1000) / 10 : 0;
    var pctText = String(pct).replace(/\.0$/, '');
    var label = start === current ? '本期' : '該期';
    return '<div class="panel cycle-report"><div class="panel-h-row"><div><h2 class="panel-h">📋 雙週復習報告</h2>' +
      '<p class="cycle-report-period">' + (start === current ? '進行中' : '已結束') + ' · ' +
      fmtDate(start) + '—' + fmtDate(start + CYCLE_MS - 1) + '（北京時間）</p></div>' +
      '<label class="cycle-report-picker">選擇週期 <select id="cycleReportPeriod">' + periods.map(function (period) {
        return '<option value="' + period + '"' + (period === start ? ' selected' : '') + '>' +
          fmtDate(period) + '—' + fmtDate(period + CYCLE_MS - 1) +
          (period === current ? '（本期）' : '') + '</option>';
      }).join('') + '</select></label></div>' +
      '<div class="cycle-report-stats">' +
        '<div><b>' + report.attempted + '</b><span>' + label + '做過的不同題目</span></div>' +
        '<div><b>' + report.correct + ' / ' + report.total + '</b><span>' + label + '最後一次答對</span></div>' +
        '<div><b>' + pctText + '%</b><span>佔目前題庫</span></div>' +
        '<div><b>' + report.newSolved.length + '</b><span>首次解決</span></div>' +
        '<div><b>' + report.regressed.length + '</b><span>答對後再錯</span></div></div>' +
      '<div class="cycle-report-progress" role="img" aria-label="答對題目佔目前題庫 ' + pctText + '%">' +
        '<span style="width:' + Math.min(100, pct) + '%"></span></div>' +
      '<p class="cycle-report-note">以每題在這個週期最後一次已儲存的批改為準；大題滿分才算答對。' +
        '「首次解決」指歷來第一次答對且最新仍答對；「答對後再錯」指最新答錯、之前曾答對。' +
        '刷新後可在此切換回看；往期比例按目前題庫計算。</p>' +
      '<div class="cycle-report-lists"><div><h3>✨ ' + label + '首次解決（' + report.newSolved.length + '）</h3>' +
        reportRowsHtml(report.newSolved, '還沒有首次解決的題目。', false) + '</div>' +
        '<div><h3>↩️ ' + label + '答對後再錯（' + report.regressed.length + '）</h3>' +
        reportRowsHtml(report.regressed, '目前沒有答對後再錯的題目。', true) + '</div></div></div>';
  }
  function renderRecords() {
    var connected = !!localStorage.getItem(LS_SYNC_SESSION);
    var passwordTools = connected
      ? '<button class="btn btn-ghost" id="syncNowBtn" type="button">立即同步</button><button class="btn btn-ghost" id="syncDisconnectBtn" type="button">退出登入</button>'
      : '';
    var latest = latestMap();
    var totalQ = SUBJECT_ORDER.reduce(function (n, c) { return n + itemsOf(c).length; }, 0);
    var totalDone = allSessions().reduce(function (n, s) {
      return n + Object.keys(s.results).length;
    }, 0);

    // 仍錯清單
    var wrongRows = [];
    SUBJECT_ORDER.forEach(function (code) {
      itemsOf(code).forEach(function (it) {
        var l = latest[it.id];
        if (isWrong(l)) wrongRows.push({ code: code, it: it, l: l });
      });
    });
    wrongRows.sort(function (a, b) {
      // 最近錯過嘅排前，未刷過在後
      var ta = a.l ? a.l.date : 0, tb = b.l ? b.l.date : 0;
      return tb - ta;
    });

    $('#app').innerHTML =
      '<section class="page">' +
        '<header class="page-head"><div><h1 class="page-title">📈 做題記錄</h1>' +
        '<p class="page-sub">每完成一次課題練習就留一個印；滑鼠移上去睇詳情。</p></div>' +
          '<div class="record-tools"><button class="btn btn-ghost" id="exportDataBtn" type="button">⬇️ 匯出記錄</button>' +
          '<button class="btn btn-ghost" id="importDataBtn" type="button">⬆️ 匯入備份</button>' +
          '<input id="importDataFile" type="file" accept="application/json,.json" hidden></div>' +
          '<a class="btn btn-ghost" href="#/">← 主頁</a></header>' +

        '<div class="panel sync-panel"><div class="panel-h-row"><h2 class="panel-h">☁️ ' + (PASSWORD_AUTH ? '做題記錄自動同步' : 'GitHub 私有仓库自动同步') + '</h2>' +
          '<div class="record-tools">' +
            (!SYNC_API ? '<button class="btn btn-ghost" id="syncConnectBtn" type="button" disabled>同步服务待部署</button>' : (PASSWORD_AUTH ? passwordTools :
              (localStorage.getItem(LS_SYNC_SESSION)
                ? '<button class="btn btn-ghost" id="syncNowBtn" type="button">立即同步</button><a class="btn btn-ghost" id="syncConnectBtn" href="' + esc(SYNC_API + '/auth/start') + '" target="_blank" rel="noopener">重新连接 GitHub</a><button class="btn btn-ghost" id="syncDisconnectBtn" type="button">断开连接</button>'
                : '<a class="btn btn-primary" id="syncConnectBtn" href="' + esc(SYNC_API + '/auth/start') + '" target="_blank" rel="noopener">连接 GitHub</a>'))) +
          '</div></div>' +
          '<p class="review-note" id="syncStatus" role="status" aria-live="polite">' + esc(syncMessage || (!SYNC_API ? '同步服务尚未部署。部署完成后，练习记录会自动备份到你的私有仓库。' :
            (connected ? ('已連接 · 上次雲端核對：' + (localStorage.getItem(LS_SYNCED_AT) ? fmtDateTime(localStorage.getItem(LS_SYNCED_AT)) : '尚未同步')) : (PASSWORD_AUTH ? '輸入密碼後，會合併本機與雲端記錄並自動同步。' : '在新分頁連接 GitHub，原頁面會保留。完成後會合併記錄並自動同步。')))) + '</p>' +
          (PASSWORD_AUTH && SYNC_API && !connected ? passwordForm() : '') + '</div>' +

        '<div class="stat-cards">' +
          statCard('✍️', '累計作答', totalDone + ' 題') +
          statCard('🗓️', '練習次數', sessions.length + ' 次') +
          statCard('🔁', '上次仍錯', wrongRows.length + ' 題', wrongRows.length ? 'c-red' : 'c-green') +
        '</div>' +

        cycleReportHtml() +

        '<div class="panel"><h2 class="panel-h">刷題活躍圖（近 6 個月，按答題數）</h2><div id="heat"></div>' +
        '<div class="heat-legend">少 <span class="lv lv0"></span><span class="lv lv1"></span>' +
        '<span class="lv lv2"></span><span class="lv lv3"></span><span class="lv lv4"></span> 多（佔題庫比例）</div></div>' +

        '<div class="panel"><div class="panel-h-row"><h2 class="panel-h">⏰ 間隔複習（到期優先）</h2></div>' +
          '<p class="review-note">答對後依次隔 15、21、30、45、60 日重練；未滿分亦至少隔 15 日再試。複習進度會跨雙週保留。</p>' +
          '<div class="wrong-list" id="reviewDueList"></div></div>' +

        '<div class="panel"><div class="panel-h-row"><h2 class="panel-h">🔍 錯題複習狀態（仍錯在上、已通過嘅沉底）</h2>' +
          '<div class="filter-seg" id="wrongFilter">' +
            ['ALL', 'chem', 'bio'].map(function (c) {
              var lbl = c === 'ALL' ? '全部' : SUBJECT_META[c].name;
              return '<button class="seg' + (c === 'ALL' ? ' on' : '') + '" data-f="' + c + '" type="button">' + lbl + '</button>';
            }).join('') +
          '</div></div>' +
          '<div class="wrong-list" id="wrongList"></div>' +
        '</div>' +
      '</section>';

    renderHeat();
    renderReviewDue();
    renderWrongList('ALL');
    var reportPicker = $('#cycleReportPeriod');
    if (!PRIVATE_BANK || bankLoaded) reportPicker.addEventListener('change', function (event) {
      selectedReportCycle = Number(event.target.value);
      renderRecords();
    });
    $('#wrongFilter').addEventListener('click', function (e) {
      var b = e.target.closest('.seg'); if (!b) return;
      $all('.seg', this).forEach(function (x) { x.classList.toggle('on', x === b); });
      renderWrongList(b.dataset.f);
    });
    $('#exportDataBtn').addEventListener('click', exportData);
    $('#importDataBtn').addEventListener('click', function () { $('#importDataFile').click(); });
    $('#importDataFile').addEventListener('change', importData);
    bindPasswordForm();
    var connectBtn = $('#syncConnectBtn');
    if (connectBtn && SYNC_API) connectBtn.addEventListener('click', function () {
      setSyncStatus('已開啟 GitHub 連接分頁；授權完成後會自動返回主頁並同步。');
    });
    var nowBtn = $('#syncNowBtn');
    if (nowBtn) nowBtn.addEventListener('click', function () { syncNow(true); });
    var disconnectBtn = $('#syncDisconnectBtn');
    if (disconnectBtn) disconnectBtn.addEventListener('click', function () {
      if (PASSWORD_AUTH || confirm('断开 GitHub 自动同步？本机及私有仓库的记录不会被删除。')) {
        var session = localStorage.getItem(LS_SYNC_SESSION);
        if (PASSWORD_AUTH && session) syncFetch('/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + session }, cache: 'no-store' }).catch(function () {});
        localStorage.removeItem(LS_SYNC_SESSION);
        localStorage.removeItem(LS_AUTH_MODE);
        forgetBank();
        syncMessage = ''; bankMessage = '';
        renderRecords();
      }
    });
  }

  function exportData() {
    var backup = backupData();
    var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'kyle-dse-quiz-backup-' + fmtDate(Date.now()).replace(/\//g, '-') + '.json';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast('備份檔已下載 ✔');
  }
  function importData(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (err) { toast('檔案不是有效 JSON'); return; }
      var validSessions = function (v) { return Array.isArray(v) && v.every(function (s) {
        return s && typeof s.t === 'number' && s.results && typeof s.results === 'object';
      }); };
      if (!data || data.app !== 'kyle-dse-quiz' || !validSessions(data.sessions) ||
          !validSessions(data.archive || []) || !data.drafts || typeof data.drafts !== 'object' ||
          !data.reviewPlan || typeof data.reviewPlan !== 'object') {
        toast('備份格式不符，沒有匯入'); return;
      }
      if (!confirm('匯入會以備份內容取代這個瀏覽器目前的練習記錄、草稿與複習進度。確定繼續？')) return;
      sessions = data.sessions; archive = data.archive || []; drafts = data.drafts; reviewPlan = data.reviewPlan;
      localStorage.setItem(LS_SESS, JSON.stringify(sessions));
      localStorage.setItem(LS_ARCHIVE, JSON.stringify(archive));
      localStorage.setItem(LS_DRAFT, JSON.stringify(drafts));
      localStorage.setItem(LS_REVIEW, JSON.stringify(reviewPlan));
      if (data.cycle) localStorage.setItem(LS_CYCLE, String(data.cycle));
      syncRevision++;
      scheduleSync();
      e.target.value = '';
      toast('備份已還原 ✔');
      renderRecords();
    };
    reader.onerror = function () { toast('讀取備份失敗'); };
    reader.readAsText(file);
  }

  function statCard(ico, label, val, cls) {
    return '<div class="stat-card"><div class="stat-ico">' + ico + '</div>' +
      '<div><div class="stat-val ' + (cls || '') + '">' + val + '</div>' +
      '<div class="stat-lbl">' + label + '</div></div></div>';
  }

  var MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ordinal(d) {
    if (d >= 11 && d <= 13) return d + 'th';
    return d + (['th', 'st', 'nd', 'rd'][d % 10] || 'th');
  }

  var HEAT_CELL = 13, HEAT_GAP = 3, HEAT_STEP = HEAT_CELL + HEAT_GAP;

  function renderHeat() {
    // 近 6 個月（183 日），GitHub 式：月份軸＋Mon/Wed/Fri 標籤；
    // 顏色深淺＝當日作答題數佔題庫總題數百分比
    var days = 183, totalQ = SUBJECT_ORDER.reduce(function (n, c) { return n + itemsOf(c).length; }, 0);
    var byDay = {};
    allSessions().forEach(function (s) {
      var key = beijingDayIndex(s.t);
      if (!byDay[key]) byDay[key] = { q: 0, n: 0 };
      byDay[key].n += 1;
      byDay[key].q += Object.keys(s.results).length;
    });
    function lvlOf(q) {
      if (!q) return 0;
      var p = q / totalQ;
      return p >= 0.5 ? 4 : p >= 0.25 ? 3 : p >= 0.1 ? 2 : 1;
    }
    var today = beijingDayIndex(Date.now());
    var start = today - (days - 1);
    start -= new Date(start * DAY_MS).getUTCDay(); // 對齊北京時間週日

    var nCol = Math.ceil((today - start + 1) / 7);

    // 月份標籤：該列週三（index 3）所在月與上一個標籤不同即標
    var monthHtml = '';
    var lastMonth = -1;
    for (var col = 0; col < nCol; col++) {
      var mid = start + col * 7 + 3;
      if (mid > today) {
        mid = start + col * 7 + 6;
      }
      var mo = new Date(mid * DAY_MS).getUTCMonth();
      if (mo !== lastMonth) {
        monthHtml += '<span class="hm-label" style="left:' + (col * HEAT_STEP) + 'px">' +
          MONTHS_EN[mo] + '</span>';
        lastMonth = mo;
      }
    }

    // 星期軸：Sun..Sat，只顯示 Mon/Wed/Fri
    var dowHtml = ['', 'Mon', '', 'Wed', '', 'Fri', ''].map(function (t) {
      return '<span class="hdow' + (t ? '' : ' hdow-empty') + '">' + t + '</span>';
    }).join('');

    var colsHtml = '';
    for (var c2 = 0; c2 < nCol; c2++) {
      colsHtml += '<div class="heat-col">';
      for (var dow = 0; dow < 7; dow++) {
        var t = start + c2 * 7 + dow;
        var future = t > today;
        var info = byDay[t];
        var lvl = (!future && info) ? lvlOf(info.q) : 0;
        var dt = new Date(t * DAY_MS);
        var dateLabel = MONTHS_EN[dt.getUTCMonth()] + ' ' + ordinal(dt.getUTCDate());
        var detail;
        if (future) {
          detail = '';
        } else if (info) {
          detail = dateLabel + '｜刷了 <b>' + info.q + '</b> 題（' + info.n + ' 次練習）';
        } else {
          detail = dateLabel + '｜未刷題';
        }
        colsHtml += '<span class="cell lv' + lvl + (future ? ' is-future' : '') + '"' +
          (detail ? ' data-tip="' + esc(detail) + '"' : '') + '></span>';
      }
      colsHtml += '</div>';
    }

    $('#heat').innerHTML =
      '<div class="heat-wrap">' +
        '<div class="heat-months" style="width:' + (nCol * HEAT_STEP - HEAT_GAP) + 'px">' +
          monthHtml + '</div>' +
        '<div class="heat-body">' +
          '<div class="heat-dow">' + dowHtml + '</div>' +
          '<div class="heat-cols" id="heatCols" style="width:' + (nCol * HEAT_STEP - HEAT_GAP) + 'px">' +
            colsHtml + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="heat-tip" id="heatTip" hidden></div>';
    bindHeatTip();
  }

  function bindHeatTip() {
    var tip = $('#heatTip');
    var hideT = null;
    $('#heatCols').addEventListener('mouseover', function (e) {
      var cell = e.target.closest('.cell[data-tip]');
      if (!cell) return;
      clearTimeout(hideT);
      tip.innerHTML = cell.dataset.tip;
      tip.hidden = false;
      requestAnimationFrame(function () { tip.classList.add('show'); });
      moveTip(cell);
    });
    $('#heatCols').addEventListener('mousemove', function (e) {
      var cell = e.target.closest('.cell[data-tip]');
      if (cell) moveTip(cell);
    });
    $('#heatCols').addEventListener('mouseout', function (e) {
      if (!e.target.closest || !e.target.closest('.cell')) return;
      tip.classList.remove('show');
      hideT = setTimeout(function () { tip.hidden = true; }, 130);
    });
    function moveTip(cell) {
      var r = cell.getBoundingClientRect();
      var tw = tip.offsetWidth || 150;
      var x = r.left + r.width / 2 - tw / 2;
      x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
      tip.style.left = x + 'px';
      tip.style.top = (r.top - 10) + 'px'; // CSS 用 transform: translate(0,-100%)
    }
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 每題喺當前週期嘅完整答題序列（時間序）
  function historyMap() {
    var index = window.DSELibrary.indexHistory(allSessions()), map = {};
    Object.keys(index).forEach(function (id) {
      map[id] = index[id].history.map(function (h) {
        return { ok: h.correct, ratio: h.tot ? h.marks / h.tot : (h.correct ? 1 : 0),
          marks: h.marks, tot: h.tot, date: h.t };
      });
    });
    return map;
  }
  function fullRight(r) { return r.ok === true && r.ratio >= 1; }

  function renderReviewDue() {
    var now = Date.now(), dueRows = [];
    SUBJECT_ORDER.forEach(function (code) {
      itemsOf(code).forEach(function (it) {
        var p = reviewPlan[it.id];
        if (reviewDue(it.id, now)) dueRows.push({ code: code, it: it, plan: p });
      });
    });
    dueRows.sort(function (a, b) { return a.plan.dueAt - b.plan.dueAt; });
    var el = $('#reviewDueList');
    if (!el) return;
    if (!dueRows.length) {
      el.innerHTML = '<div class="empty-ok">✅ 暫時沒有到期複習；新作答會自動排入複習。</div>';
      return;
    }
    el.innerHTML = dueRows.map(function (r) {
      var overdue = Math.max(0, Math.floor((now - r.plan.dueAt) / 864e5));
      return '<a class="wrong-row due" href="#/session/' + r.code + '/' + encodeURIComponent(r.it.topic) + '">' +
        '<span class="wrong-subj">' + SUBJECT_META[r.code].icon + '</span>' +
        '<span class="wrong-main"><b>' + esc(r.it.qref) + '</b> ' + esc(r.it.stem) +
          '<small>' + esc(r.it.topic + ' ' + topicName(r.code, r.it.topic)) + ' · 已逾期 ' + overdue + ' 日' +
          ' · 上次 ' + Math.round(r.plan.ratio * 100) + '%</small></span>' +
        '<span class="wb wb-bad">複習到期</span><span class="wrong-go">再練 →</span></a>';
    }).join('');
  }

  function renderWrongList(filter) {
    var hist = historyMap(), latest = {};
    Object.keys(hist).forEach(function (id) { latest[id] = hist[id][hist[id].length - 1]; });
    var due = [], passOnce = [], passStrong = [];
    SUBJECT_ORDER.forEach(function (code) {
      if (filter !== 'ALL' && filter !== code) return;
      itemsOf(code).forEach(function (it) {
        var l = latest[it.id];
        var row = { code: code, it: it, l: l, seq: hist[it.id] || [] };
        if (isWrong(l)) {
          due.push(row);
        } else if (l) {
          // 最近一次全對：連續全對 ≥2 次＝反複通過；否則只算最近答對
          var n = row.seq.length, streak = 0;
          for (var i = n - 1; i >= 0 && fullRight(row.seq[i]); i--) streak++;
          (streak >= 2 ? passStrong : passOnce).push(row);
        }
      });
    });
    var byRecent = function (a, b) { return (b.l.date || 0) - (a.l.date || 0); };
    // 待處理：已刷仍錯嘅按得分率由低到高（最差優先）、同分近期優先；未刷過沉底
    due.sort(function (a, b) {
      if (a.l && b.l) return (a.l.ratio - b.l.ratio) || (b.l.date - a.l.date);
      if (a.l) return -1;
      if (b.l) return 1;
      return 0;
    });
    passOnce.sort(byRecent);
    passStrong.sort(byRecent);
    var el = $('#wrongList');
    if (!due.length && !passOnce.length && !passStrong.length) {
      el.innerHTML = '<div class="empty-ok">🎉 呢科嘅錯題全部征服咗！</div>';
      return;
    }

    function rowHtml(r, cls, badge) {
      var when = r.l ? fmtDate(r.l.date) : '從未刷過';
      var ratioTxt = r.l && r.l.ratio < 1 ? Math.round(r.l.ratio * 100) + '%' : (r.l ? '滿分' : '—');
      var seq = r.seq.slice(-5).reverse();
      var details = seq.length ? '<details class="item-history"><summary>作答軌跡 · 最近 ' + seq.length + ' 次</summary>' +
        '<ol>' + seq.map(function (a) {
          var ratio = Math.round(a.ratio * 100);
          return '<li><time>' + fmtDate(a.date) + '</time><b class="' + (ratio >= 99 ? 'c-green' : 'c-red') + '">' +
            esc(String(a.marks == null ? '—' : a.marks) + '/' + String(a.tot == null ? '—' : a.tot)) +
            ' 分 · ' + ratio + '%</b></li>';
        }).join('') + '</ol></details>' : '<div class="item-history-empty">尚無作答紀錄</div>';
      return '<div class="wrong-entry"><a class="wrong-row ' + cls + '" href="#/session/' + r.code + '/' +
        encodeURIComponent(r.it.topic) + '">' +
        '<span class="wrong-subj">' + SUBJECT_META[r.code].icon + '</span>' +
        '<span class="wrong-main"><b>' + esc(r.it.qref) + '</b> ' + esc(r.it.stem) +
          '<small>' + esc(r.it.topic + ' ' + topicName(r.code, r.it.topic)) +
          ' · ' + when + (r.l ? ' · 上次得分率 ' + ratioTxt : '') + '</small></span>' +
        badge +
        '<span class="wrong-go">再練 →</span></a>' + details + '</div>';
    }
    function group(title, rows, cls, badge, empty) {
      if (!rows.length) return '';
      return '<div class="wrong-group-h ' + cls + '">' + title + '（' + rows.length + '）</div>' +
        rows.map(function (r) {
          if (cls === 'due') {
            var b = !r.l ? '<span class="wb wb-new">未刷</span>'
              : '<span class="wb wb-bad">仍錯 ' + (r.l.ratio < 1 ? Math.round(r.l.ratio * 100) + '%' : '✘') + '</span>';
            return rowHtml(r, 'due', b);
          }
          var bb = cls === 'strong'
            ? '<span class="wb wb-strong">反複通過 ✔✔</span>'
            : '<span class="wb wb-ok">最近答對 ✔</span>';
          return rowHtml(r, cls, bb);
        }).join('');
    }
    el.innerHTML =
      group('🔴 待處理', due, 'due', null) +
      group('🟢 已答對（再刷可鞏固）', passOnce, 'once', null) +
      group('🌟 反複測試通過', passStrong, 'strong', null);
  }
  function beijingDayIndex(t) { return Math.floor((new Date(t).getTime() + BEIJING_OFFSET_MS) / DAY_MS); }
  function beijingClock(t) { return new Date(new Date(t).getTime() + BEIJING_OFFSET_MS); }
  function fmtDate(t) {
    var d = beijingClock(t);
    return d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate());
  }
  function fmtDateTime(t) {
    var d = beijingClock(t);
    return fmtDate(t) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '（北京時間）';
  }

  /* ---------------- 重設 ---------------- */
  document.addEventListener('click', function (e) {
    if (e.target.closest('#railReset')) {
      if (confirm('確定清除所有做題記錄、雙週歸檔及未提交作答？如已登入同步，雲端備份亦會一併清除。（題庫本身唔會刪）')) {
        localStorage.removeItem(LS_SESS);
        localStorage.removeItem(LS_ARCHIVE);
        localStorage.removeItem(LS_DRAFT);
        localStorage.removeItem(LS_REVIEW);
        sessions = []; archive = []; drafts = {}; reviewPlan = {};
        if (localStorage.getItem(LS_SYNC_SESSION) && SYNC_API) {
          syncRequest('DELETE').catch(function (err) { toast('本機已清除；雲端清除失敗：' + err.message); });
        }
        location.hash = '#/';
        route();
        toast('已清除');
      }
    }
  });

  history.replaceState(null, '', location.pathname + location.search + '#/');
  seedReviewPlan();
  normalizeReviewPlan();
  if (ensureCycle()) {
    setTimeout(function () { toast('🔄 新嘅雙週開始，進度已重置！'); }, 300);
  }
  route();
  initSync(startupHash);
})();

