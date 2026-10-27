/* Kyle 錯題本 —— 純靜態 SPA（hash 路由，localStorage 儲存，無依賴）
 * 視圖：主頁 / 練習（課題排序）/ 做題會話（一次提交、MC 自動批改、大題踩分點自改）/ 記錄（熱力圖＋仍錯查詢）
 */
(function () {
  'use strict';
  var activeUser = localStorage.getItem('dse_quiz_user_v1') || 'kyle';
  var subjectConfig = window.DSESubjects;
  function emptyBank() { return subjectConfig.emptyBank(activeUser); }
  var PRIVATE_BANK = window.QUIZ_PRIVATE_BANK === true;
  var DATA = PRIVATE_BANK ? emptyBank() : window.QUIZ_DATA;
  if (DATA && DATA.subjects) DATA.subjects = subjectConfig.bankFor(activeUser, DATA).subjects;
  var bankLoaded = !PRIVATE_BANK, bankPromise = null, bankMessage = '', bankFailed = false, bankRequest = 0, bankAutoRetry = false;
  var imageUrls = new Map(), imageReads = new Map(), imageObserver = null;
  var LS_SESS = 'dse_quiz_sessions_v2';
  var LS_DRAFT = 'dse_quiz_draft_v2';
  var LS_ARCHIVE = 'dse_quiz_archive_v1';
  var LS_CYCLE = 'dse_quiz_cycle_v1';
  var LS_REVIEW = 'dse_quiz_review_v1';
  var LS_TODAY = 'dse_quiz_today_v1';
  var LS_AI = 'dse_quiz_ai_reviews_v1';
  // Preserve legacy Kyle keys. Other accounts never load or migrate those keys.
  function userKey(key) { return activeUser === 'kyle' ? key : key + ':' + activeUser; }
  LS_SESS = userKey(LS_SESS); LS_DRAFT = userKey(LS_DRAFT);
  LS_ARCHIVE = userKey(LS_ARCHIVE); LS_CYCLE = userKey(LS_CYCLE);
  LS_REVIEW = userKey(LS_REVIEW); LS_TODAY = userKey(LS_TODAY); LS_AI = userKey(LS_AI);
  var aiReviews = load(LS_AI, {});
  var todaySelection = null;
  var LS_SYNC_SESSION = 'dse_quiz_sync_session_v1';
  var LS_SYNCED_AT = userKey('dse_quiz_sync_at_v1');
  var LS_AUTH_MODE = 'dse_quiz_auth_mode_v1';
  var SYNC_API = String(window.QUIZ_SYNC_API || '').replace(/\/+$/, '');
  var PASSWORD_AUTH = window.QUIZ_PASSWORD_AUTH === true;
  var passwordLoginBusy = false;
  var syncTimer = null, syncBusy = false, syncAgain = false, syncRevision = 0;
  var syncMessage = '';
  var paperSubject = '', paperYear = '', paperIdentifier = '', paperPage = 1, paperManifest = null;
  var paperReader = null, paperController = null, paperRequest = 0;
  var paperToolsOpen = false, paperHeaderVisible = false;
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
  var SUBJECT_ORDER = subjectConfig.codes(activeUser);
  var SUBJECT_META = { all: { name: '全部科目', icon: '<span class="persona-icon persona-icon-practice" aria-hidden="true"></span>' } };
  Object.keys(subjectConfig.names).forEach(function (code) {
    SUBJECT_META[code] = { name: subjectConfig.names[code], icon: subjectConfig.icon(code), soon: false };
  });

  function load(k, d) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; }
    catch (e) { return d; }
  }
  function save() {
    localStorage.setItem(LS_SESS, JSON.stringify(sessions));
    localStorage.setItem(LS_DRAFT, JSON.stringify(drafts));
    localStorage.setItem(LS_REVIEW, JSON.stringify(reviewPlan));
    localStorage.setItem(LS_AI, JSON.stringify(aiReviews));
    syncRevision++;
    scheduleSync();
  }

  function backupData() {
    return {
      app: 'kyle-dse-quiz', version: 1, exportedAt: new Date().toISOString(),
      sessions: sessions, archive: archive, drafts: drafts, reviewPlan: reviewPlan, aiReviews: aiReviews,
      cycle: localStorage.getItem(LS_CYCLE) || null
    };
  }
  function mergeDraft(a, b) {
    a = a || {}; b = b || {};
    var deletedAt = Math.max(Number(a.deletedAt) || 0, Number(b.deletedAt) || 0);
    var merged = { pick: {}, text: {}, paper: {}, steps: {}, changedAt: {}, deletedAt: deletedAt };
    ['pick', 'text', 'paper', 'steps'].forEach(function (kind) {
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
    aiReviews = Object.assign({}, remote.aiReviews || {}, aiReviews);
    localStorage.setItem(LS_SESS, JSON.stringify(sessions));
    localStorage.setItem(LS_ARCHIVE, JSON.stringify(archive));
    localStorage.setItem(LS_DRAFT, JSON.stringify(drafts));
    localStorage.setItem(LS_REVIEW, JSON.stringify(reviewPlan));
    localStorage.setItem(LS_AI, JSON.stringify(aiReviews));
    if (cycle) localStorage.setItem(LS_CYCLE, String(cycle));
    return true;
  }
  function syncRequest(method, body, session) {
    session = session || localStorage.getItem(LS_SYNC_SESSION);
    if (!SYNC_API || !session) return Promise.reject(new Error('未設定同步服務或尚未連接 GitHub'));
    return syncFetch('/sync', {
      method: method,
      headers: { 'Authorization': 'Bearer ' + session, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }, readSyncResponse);
  }
  function readSyncResponse(r) {
    return Promise.resolve().then(function () { return r.json(); }).catch(function (err) {
      if (err.name === 'AbortError' || err.name === 'TypeError') throw err;
      if (r.ok) throw Object.assign(new Error('同步服務回應格式有誤；本機記錄已保留'), { code: 'invalid_response' });
      return {};
    }).then(function (data) {
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
  function syncFetch(path, options, readResponse) {
    var controller = new AbortController();
    // 同步可能先續期授權，再因多裝置衝突重讀及寫入；每次上游請求最多 8 秒。
    // 期限同時涵蓋回應正文，避免只收到 headers 就取消計時後一直卡住。
    var timer = setTimeout(function () { controller.abort(); }, path === '/sync' ? 60000 : path === '/bank' ? 30000 : path.indexOf('/ai/') === 0 && path !== '/ai/status' ? 120000 : 15000);
    return fetch(SYNC_API + path, Object.assign({}, options, { signal: controller.signal }))
      .then(function (response) { return readResponse ? readResponse(response) : response; })
      .catch(function (err) {
        if (controller.signal.aborted || err.name === 'AbortError') throw Object.assign(new Error(path === '/auth/password'
          ? '登入服務連線逾時，請重試；若持續發生，請檢查目前網絡能否連上同步服務'
          : path === '/bank' ? '錯題庫連線逾時，請稍後重試' : path.indexOf('/ai/') === 0 ? 'AI 回應逾時，請重試' : '同步連線逾時，請稍後重試'), { code: path.indexOf('/ai/') === 0 ? 'ai_timeout' : 'connection_timeout', path: path });
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
      return stableStringify([data.sessions || [], data.archive || [], data.drafts || {}, data.reviewPlan || {}, data.aiReviews || {}, String(data.cycle || '')]);
    }
    var before = state(backupData());
    var sentRevision = syncRevision;
    function current() { return localStorage.getItem(LS_SYNC_SESSION) === session && (localStorage.getItem('dse_quiz_user_v1') || 'kyle') === activeUser; }
    function attemptSync(attempt) {
      if (!current()) return Promise.resolve(null);
      // 寫入可能已成功而回應途中斷線；每次重試必須重讀及合併，不能重送舊 sha。
      return syncRequest('GET', null, session).then(function (remote) {
        if (!current()) return null;
        if (!remote || !Object.prototype.hasOwnProperty.call(remote, 'data') ||
            (remote.data !== null && (!remote.data || remote.data.app !== 'kyle-dse-quiz'))) {
          throw Object.assign(new Error('雲端記錄回應格式有誤；本機記錄已保留'), { code: 'invalid_response' });
        }
        if (remote.data) mergeData(remote.data);
        var backup = backupData();
        sentRevision = syncRevision;
        if (remote.data && state(remote.data) === state(backup)) {
          return { savedAt: new Date().toISOString(), kind: before === state(backup) ? 'checked' : 'downloaded' };
        }
        return syncRequest('PUT', { data: backup, sha: remote.sha || null }, session).then(function (result) {
          result.kind = 'uploaded'; return result;
        });
      }).catch(function (err) {
        if (!current()) return null;
        if (attempt >= 2 || (!transientDataError(err) && err.status !== 409)) throw err;
        setSyncStatus('同步暫時未完成，正在自動重試（' + (attempt + 1) + '/2）；本機記錄已保留' +
          (err.status ? ' [HTTP ' + err.status + ']' : '') + '…');
        return new Promise(function (resolve) { setTimeout(resolve, attempt === 0 ? 1000 : 3000); })
          .then(function () { return attemptSync(attempt + 1); });
      });
    }
    return attemptSync(0).then(function (result) {
      if (!result || localStorage.getItem(LS_SYNC_SESSION) !== session) return false;
      var checkedAt = new Date().toISOString();
      localStorage.setItem(LS_SYNCED_AT, checkedAt);
      var label = result.kind === 'uploaded' ? '已上傳至雲端' : result.kind === 'downloaded' ? '已更新本機記錄' : '雲端已核對，無新記錄';
      setSyncStatus(syncRevision === sentRevision
        ? label + ' · ' + fmtDateTime(result.savedAt || checkedAt)
        : '本機有新變更，等待自動同步…');
      if (syncRevision !== sentRevision) scheduleSync();
      if ((location.hash.replace(/^#/, '').split('?')[0] || '/') === '/' && before !== state(backupData())) renderHome();
      else if (location.hash.indexOf('/records') >= 0) renderRecords();
      else if (location.hash.indexOf('/library/books') >= 0 && before !== state(backupData())) route();
      return true;
    }).catch(function (err) {
      if (localStorage.getItem(LS_SYNC_SESSION) !== session) return false;
      expireConnection(err, session);
      var detail = err.name === 'TypeError' ? '網絡未能連接同步服務，請檢查目前網絡' : err.message;
      setSyncStatus((transientDataError(err) || err.status === 409
        ? '同步暫未完成，稍後會自動重試；本機記錄已保留：' : '同步失敗：') + detail);
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
    bankPromise = null; bankMessage = ''; bankFailed = false; bankAutoRetry = false;
    releasePaper();
    if (imageObserver) { imageObserver.disconnect(); imageObserver = null; }
    window.DSELibrary.reset();
    clearArchiveBackdrop();
    imageReads.clear();
    paperCatalogSnapshot = null;
    aiStatusSnapshot = null; aiReplyHistories = Object.create(null); todaySelection = null;
    imageUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    imageUrls.clear();
    if (PRIVATE_BANK) { DATA = emptyBank(); bankLoaded = false; }
  }
  function passwordForm() {
    return '<form id="passwordLoginForm" class="sync-login"><label for="syncUsername">使用者名稱</label>' +
      '<input id="syncUsername" type="text" autocomplete="username" maxlength="32" value="' + (activeUser === 'yeelam' ? 'Yeelam' : 'Kyle') + '" required>' +
      '<label for="syncPassword">網站密碼</label>' +
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
      syncFetch('/auth/password', { method: 'POST', headers: headers, body: JSON.stringify({ username: ($('#syncUsername').value || 'Kyle').trim(), password: password }), cache: 'no-store' })
        .then(readSyncResponse).then(function (data) {
          if (!data || !/^[A-Za-z0-9_-]{40,80}$/.test(data.sessionId || '')) throw new Error('登入服務未回傳有效連接');
          var nextUser = data.userId || 'kyle';
          localStorage.setItem('dse_quiz_user_v1', nextUser);
          if (PASSWORD_AUTH) localStorage.setItem(LS_AUTH_MODE, 'password');
          localStorage.setItem(LS_SYNC_SESSION, data.sessionId);
          if (nextUser !== activeUser) { location.reload(); return; }
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
  function transientDataError(err) {
    if (err.code === 'service_not_configured' || err.code === 'owner_connection_required') return false;
    return err.code === 'connection_timeout' || err.name === 'TypeError' ||
      [408, 429, 500, 502, 503, 504].indexOf(err.status) >= 0;
  }
  function loadBank() {
    if (!PRIVATE_BANK || bankLoaded) return Promise.resolve(true);
    if (bankPromise) return bankPromise;
    var session = localStorage.getItem(LS_SYNC_SESSION);
    if (!session || !SYNC_API) return Promise.resolve(false);
    var requestId = ++bankRequest;
    bankFailed = false; bankAutoRetry = false;
    bankMessage = PASSWORD_AUTH ? '已登入，正在載入你的錯題庫…' : '正在載入你的錯題庫…';
    function current() { return requestId === bankRequest && localStorage.getItem(LS_SYNC_SESSION) === session; }
    function readBank(attempt) {
      if (!current()) return Promise.resolve(null);
      return syncFetch('/bank', {
        method: 'GET', headers: { Authorization: 'Bearer ' + session }, cache: 'no-store'
      }, readSyncResponse).catch(function (err) {
        if (!current()) return null;
        var retryable = transientDataError(err);
        if (!retryable || attempt >= 2) { bankAutoRetry = retryable; throw err; }
        bankMessage = '錯題庫暫時未有回應，正在自動重試（' + (attempt + 1) + '/2）…';
        var status = $('#bankStatus');
        if (status) status.textContent = bankMessage;
        return new Promise(function (resolve) { setTimeout(resolve, attempt === 0 ? 1000 : 3000); })
          .then(function () { return readBank(attempt + 1); });
      });
    }
    bankPromise = readBank(0).then(function (bank) {
      if (requestId !== bankRequest || localStorage.getItem(LS_SYNC_SESSION) !== session) return false;
      bank = subjectConfig.bankFor(activeUser, bank);
      SUBJECT_ORDER.forEach(function (code) {
        if (!bank.subjects || !bank.subjects[code] || !Array.isArray(bank.subjects[code].items) || !Array.isArray(bank.subjects[code].topics)) {
          throw new Error('錯題庫格式有誤');
        }
        bank.subjects[code].items.forEach(function (it) {
          if (it.img && !/^images\/(?:chem|bio|math|m2|physics)-\d{4}-(?:mc-\d+|fig-[a-z0-9-]+)\.jpg$/.test(it.img)) throw new Error('原題圖片路徑有誤');
        if (it.figures && (!Array.isArray(it.figures) || !it.figures.every(function (f) {
          return f && /^images\/(?:chem|bio|math|m2|physics)-\d{4}-fig-[a-z0-9-]+\.jpg$/.test(f.path);
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
      '<div class="hero-kicker">DSE · ' + SUBJECT_ORDER.map(function (code) { return SUBJECT_META[code].name; }).join(' / ') + '</div><h1 class="hero-title">' + (activeUser === 'yeelam' ? 'Yeelam' : 'Kyle') + ' 嘅錯題本</h1>' +
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
          var nextUser = data.userId || 'kyle';
          localStorage.setItem('dse_quiz_user_v1', nextUser);
          if (PASSWORD_AUTH) localStorage.setItem(LS_AUTH_MODE, 'password');
          localStorage.setItem(LS_SYNC_SESSION, data.sessionId);
          if (nextUser !== activeUser) { history.replaceState(null, '', '#/'); location.reload(); return; }
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
    if (event.key === 'dse_quiz_user_v1' || event.key === LS_SYNC_SESSION) {
      if ((localStorage.getItem('dse_quiz_user_v1') || 'kyle') !== activeUser) { location.reload(); return; }
      forgetBank(); route();
      if (event.newValue) Promise.all([loadBank(), syncNow(true)]);
    }
  });
  // Also fetch updates made on another computer while this tab remains open.
  setInterval(function () {
    if (PASSWORD_AUTH) { if (bankAutoRetry) loadBank(); syncNow(true); }
  }, 60000);

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
  function subjOf(code) { return code === 'all' ? { topics: [], items: SUBJECT_ORDER.reduce(function (all, c) { return all.concat(DATA.subjects[c].items); }, []) } : DATA.subjects[code]; }
  function itemsOf(code) { return subjOf(code).items; }
  function topicName(code, t) {
    if (t === '__today__') return '今日複習';
    var x = subjOf(code).topics.filter(function (q) { return q.code === t; })[0];
    return x ? x.name : t;
  }
  function marksOf(it) {
    if (it.kind === 'mc') return 1;
    if (Number.isFinite(it.marks) && it.marks > 0) return it.marks;
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
    var passed = result.ok === true && ratio >= 1 && !result.assisted && !(result.attempt && result.attempt.assisted);
    // Early drills and assisted answers do not postpone an already scheduled review.
    if (previous && ((passed && at < previous.dueAt) || result.assisted || (result.attempt && result.attempt.assisted))) return;
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
    var history = window.DSELibrary.independentHistory(allSessions());
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
  var S2T_MAP = {
    '细':'細','质':'質','线':'線','双':'雙','补':'補','转':'轉','录':'錄','应':'應',
    '达':'達','尔':'爾','体':'體','肠':'腸','运':'運','输':'輸','长':'長','营':'營',
    '养':'養','纤':'纖','维':'維','粪':'糞','遗':'遺','传':'傳','杂':'雜','种':'種',
    '态':'態','叶':'葉','绿':'綠','矿':'礦','气':'氣','压':'壓','脏':'臟','脑':'腦',
    '岛':'島','门':'門','静':'靜','脉':'脈','韧':'韌','卫':'衛','饱':'飽','缩':'縮',
    '横':'橫','肾':'腎','茎':'莖','腾':'騰','浓':'濃'
  };
  function norm(s) {
    return String(s).replace(new RegExp('[' + Object.keys(S2T_MAP).join('') + ']', 'g'),
      function (ch) { return S2T_MAP[ch] || ch; });
  }
  '扩擴 题題 学學 识識 点點 误誤 错錯 因因 审審 漏漏 计計 算算 实實 验驗 电電 离離 阳陽 阴陰 极極 酸酸 碱鹼 盐鹽 铜銅 铁鐵 锌鋅 铝鋁 镁鎂 钠鈉 钾鉀 钙鈣 氢氫 氧氧 氯氯 还還 复復 习習 状狀 态態 过過 滤濾 温溫 热熱 冷冷 度度 溶溶 液液 变變 化化 产產 物物 结結 构構 均均 衡衡 见見 植植 动動 样樣 本本 红紅 血血 浆漿 渗滲 透透 蒸蒸 发發 胆膽 胰胰 肺肺 历歷 细細 胞胞 膜膜 质質 线線 粒粒 筛篩 选選 择擇 进進 概概 念念 混混 淆淆 达達 测測 试試 图圖 表表 数數 据據 说說 明明 条條 件件 减減 增增 关關 键鍵 无無 为為 于於 与與 从從 时時 间間 这這 个個 后後 体體 内內 对對 组組 合合 认認 维維 持持 资資 料料 导導 致致 率率 连連 续續 独獨 立立 掌掌 握握 传傳 遗遺 码碼 核核 调調 节節 生生 长長 几幾 何何 圆圓 轴軸 斜斜 线線 负負 正正 函函 数數 术術 语語 开開 释釋 适適 应應'.split(' ').forEach(function (pair) { if(pair.length===2) S2T_MAP[pair[0]]=pair[1]; });

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
    renderArchiveBackdrop(view === 'library' && parts[1] === 'books');
    if (view !== 'library') releasePaper();
    $all('.rail-item,.tab-item').forEach(function (a) {
      a.classList.toggle('active', a.dataset.route === (view === 'library' && parts[1] === 'papers' ? 'papers' : view));
    });
    if (preserveScroll !== true) {
      var scrollRoot = $('#contentScroll');
      if (scrollRoot) scrollRoot.scrollTop = 0;
      else window.scrollTo(0, 0);
    }
    if (PRIVATE_BANK && !bankLoaded && view !== 'records') {
      if (!localStorage.getItem(LS_SYNC_SESSION)) return renderBankGate();
      if (view !== 'home' && !(view === 'library' && parts[1] === 'papers')) return renderBankLoading();
    }
    if (view === 'home') return renderHome();
    if (view === 'practice') return renderPractice(SUBJECT_ORDER.indexOf(parts[1]) >= 0 ? parts[1] : SUBJECT_ORDER[0], parts[2]);
    if (view === 'library') return renderLibrary(parts.slice(1));
    if (view === 'random') return renderRandomPicker();
    if (view === 'today') return renderToday(parts[1], parts[2]);
    if (view === 'session') {
      if (parts[2] === '__today__') return renderToday(parts[1], 5);
      renderSession(parts[1], decodeURIComponent(parts[2] || ''), undefined, parts[3]);
      return;
    }
    if (view === 'records') return renderRecords();
    renderHome();
  }
  window.addEventListener('hashchange', route);

  function motionBehavior() {
    return (document.documentElement && document.documentElement.dataset.appearance === 'simple') ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth';
  }

  function toast(msg) {
    var t = $('#toast');
    t.innerHTML = '<span class="persona-icon persona-icon-warning" aria-hidden="true"></span> ' + esc(msg); t.hidden = false;
    clearTimeout(toast._tm);
    toast._tm = setTimeout(function () { t.hidden = true; }, 2200);
  }

  /* ---------------- 主頁 ---------------- */
  function homeMarkup() {
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

    var historyIndex = window.DSELibrary.indexHistory(allSessions());
    var mastered = SUBJECT_ORDER.reduce(function (n, code) {
      return n + itemsOf(code).filter(function (item) { return historyIndex[item.id] && historyIndex[item.id].state === 'mastered'; }).length;
    }, 0);
    var remainingDays = Math.ceil((cycleEndOf(Date.now()) - Date.now()) / DAY_MS);
    var todayDue = todayRows('all').filter(function (r) { return r.due; }).length;
    return (
      '<section class="home"><div class="home-stage">' +
        '<div class="hero">' +
          '<div class="hero-kicker">' + (activeUser === 'yeelam' ? 'Yeelam' : 'Kyle') + ' 嘅錯題本 / DSE</div>' +
          '<h1 class="hero-title">從上次的<br>錯題繼續。</h1>' +
          '<a class="continue-command" href="#/today/all/5"><b aria-hidden="true">TODAY</b><span>開始今日複習 ↗ · 到期 ' + (bankLoaded ? todayDue : '—') + ' 題</span></a>' +
          '<div class="home-info" role="group" aria-label="學習與同步資訊">' +
          '<p class="hero-sub hero-bubble bubble-intro">錯過嘅唔可以再錯 —— 逐課題清，每個踩分點都執返。</p>' +
          '<p class="review-note hero-bubble bubble-sync" id="syncStatus" role="status" aria-live="polite"' + (syncMessage ? '' : ' hidden') + '>' + esc(syncMessage) + '</p>' +
          bankStatusHtml() +
          '<p class="home-bank-total hero-bubble bubble-bank"><b>' + (bankLoaded ? totalItems : '—') + '</b> 題在庫<span class="bank-privacy">題庫及原卷僅供登入後讀取</span></p>' +
          '</div>' +
        '</div>' +
        '<div class="tile-grid">' +
          tile('#/practice/' + SUBJECT_ORDER[0], '<span class="persona-icon persona-icon-practice" aria-hidden="true"></span>', '開始練習', '按課題逐個擊破', 'tile-blue') +
          tile('#/library/books', '<span class="persona-icon persona-icon-library" aria-hidden="true"></span>', '錯題庫', '歸納原答案、錯因與正解', 'tile-gold') +
          tile('#/library/papers', '<span class="persona-icon persona-icon-papers" aria-hidden="true"></span>', '紅筆批改卷', '按年份回顧原答與批注', 'tile-green') +
          tile('#/records', '<span class="persona-icon persona-icon-records" aria-hidden="true"></span>', '做題記錄', '查看歷次練習與雙周進度', 'tile-gold') +
          tile('#/random', '<span class="persona-icon persona-icon-random" aria-hidden="true"></span>', '隨機十題', SUBJECT_ORDER.map(function (code) { return SUBJECT_META[code].name; }).join('／') + '十題速測', 'tile-green') +
        '</div></div>' +
        todayMarkup() + '<div class="home-stat-strip">' +
          '<div>本輪待複習<strong class="c-red">' + (bankLoaded ? due : '—') + '<small>題</small></strong></div>' +
          '<div>本輪已全對<strong class="c-green">' + conquered + '<small>題</small></strong></div>' +
          '<div>長期已掌握<strong>' + (bankLoaded ? mastered : '—') + '<small>題</small></strong></div>' +
          '<div>距離下一輪<strong>' + remainingDays + '<small>天</small></strong></div>' +
        '</div>' +
        '<div class="hero-cycle" id="heroCycle">' +
          '<span>下輪開始：<b id="cycleTimer">—</b></span>' +
          '<span class="cycle-note">本輪進度重新計算；歷史、草稿與長期掌握狀態保留。北京時間。</span>' +
        '</div>' +

        '<div class="home-sec">' +
          '<div class="home-sec-h"><h2><span class="persona-icon persona-icon-practice" aria-hidden="true"></span> 建議優先複習</h2><a class="link" href="#/practice/' + SUBJECT_ORDER[0] + '">全部課題 →</a></div>' +
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
      '</section>');
  }
  function clearArchiveBackdrop() {
    var backdrop = $('#archiveBackdrop');
    if (backdrop) { backdrop.hidden = true; backdrop.innerHTML = ''; }
  }
  function renderArchiveBackdrop(active) {
    if (!active || (PRIVATE_BANK && !localStorage.getItem(LS_SYNC_SESSION))) return clearArchiveBackdrop();
    var backdrop = $('#archiveBackdrop');
    if (!backdrop) return;
    // Reuse the current home view without duplicate IDs, live regions or handlers.
    // The inert, aria-hidden layer is memory-only and is cleared on exit/logout.
    backdrop.innerHTML = '<div class="app archive-home-content">' + homeMarkup()
      .replace(/\sid="[^"]*"/g, '').replace(/\saria-live="[^"]*"/g, '')
      .replace(/\srole="status"/g, '') + '</div>';
    backdrop.hidden = false;
  }
  function renderHome() {
    $('#app').innerHTML = homeMarkup();
    bindBankRetry();
    startCycleTimer();
    var subject = $('#todaySubject'), count = $('#todayCount');
    function updateToday() {
      var rows = todayRows(subject.value || 'all'), n = Math.min(Number(count.value) || 5, rows.length);
      $('#todayStart').href = '#/today/' + (subject.value || 'all') + '/' + (count.value || '5');
      $('#todaySummary').textContent = bankLoaded ? rows.filter(function (r) { return r.due; }).length + ' 題到期 · 本次 ' + n + ' 題（北京時間）' : '題庫尚未載入';
    }
    subject.addEventListener('change', updateToday); count.addEventListener('change', updateToday);
  }
  function todayRows(code) { return window.DSELibrary.dailyCandidates(DATA, allSessions(), reviewPlan, code, Date.now()); }
  function todayMarkup() {
    var rows = todayRows('all'), due = rows.filter(function (r) { return r.due; }).length;
    return '<section class="panel today-review" aria-label="今日複習"><h2>今日複習</h2>' +
      '<p id="todaySummary" role="status">' + (bankLoaded ? due + ' 題到期 · 本次 ' + Math.min(5, rows.length) + ' 題（北京時間）' : '題庫尚未載入') + '</p>' +
      '<p class="review-note">優先安排到期、答對後回退和連續答錯的題目，再參考已核實原卷失分。</p>' +
      '<div class="today-controls"><label>科目 <select id="todaySubject"><option value="all">全部科目</option>' + SUBJECT_ORDER.map(function (c) { return '<option value="' + c + '">' + SUBJECT_META[c].name + '</option>'; }).join('') + '</select></label>' +
      '<label>短練習 <select id="todayCount"><option value="5">5 題</option><option value="10">10 題</option><option value="15">15 題</option></select></label>' +
      '<a class="btn btn-primary" id="todayStart" href="#/today/all/5">開始今日複習</a></div></section>';
  }
  function renderToday(code, limit) {
    code = SUBJECT_ORDER.indexOf(code) >= 0 ? code : 'all';
    limit = [5, 10, 15].indexOf(Number(limit)) >= 0 ? Number(limit) : 5;
    var rows = todayRows(code), saved = load(LS_TODAY, null), day = beijingDayIndex(Date.now());
    if (saved && saved.day === day && saved.code === code && saved.limit === limit && Array.isArray(saved.ids)) {
      var ids = new Set(saved.ids); rows = rows.filter(function (r) { return ids.has(r.item.id); });
      rows.sort(function (a, b) { return saved.ids.indexOf(a.item.id) - saved.ids.indexOf(b.item.id); });
    } else rows = rows.slice(0, limit);
    todaySelection = { day: day, code: code, limit: limit, ids: rows.map(function (r) { return r.item.id; }), rows: rows };
    localStorage.setItem(LS_TODAY, JSON.stringify({ day: day, code: code, limit: limit, ids: todaySelection.ids }));
    if (!rows.length) {
      $('#app').innerHTML = '<section class="page"><h1 class="page-title">今日複習</h1><p>目前沒有可練習的題目。</p><a class="btn btn-primary" href="#/">返回主頁</a></section>'; return;
    }
    renderSession(code, '__today__');
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
  function renderLibrary(parts) {
    releasePaper();
    parts = parts || [];
    if (parts[0] === 'books') return window.DSELibrary.render(parts.slice(1), {
      root: $('#app'), scrollRoot: $('#contentScroll'), data: DATA, history: allSessions(), cycleStart: cycleStartOf(Date.now()), loaded: bankLoaded,
      normalize: norm, formatDate: fmtDateTime, hydrate: hydratePrivateImages, gradeMetrics: paperGradeMetrics, tags: confirmedTags,
      aiHtml: function (id) { var row=latestAI(id);return row ? '<details class="ai-saved"><summary>已確認 AI 輔評 · '+esc(fmtDateTime(row.confirmedAt))+'</summary><p>與原卷判分分開保存 · 標籤：'+esc((row.tags||[]).join('、')||'未選擇')+'</p>'+aiFeedbackHtml(row.feedback)+'</details>' : ''; },
      catalog: function () {
        var session = localStorage.getItem(LS_SYNC_SESSION);
        if (!session || !SYNC_API) return Promise.resolve(null);
        var controller = new AbortController();
        paperController = controller;
        var timeout = setTimeout(function () { controller.abort(); }, 15000);
        return fetchPaperCatalog(session, controller.signal).then(function (catalog) {
          return localStorage.getItem(LS_SYNC_SESSION) === session ? catalog : null;
        }).catch(function (error) {
          expireConnection(error, session);
          throw error;
        }).finally(function () { clearTimeout(timeout); });
      }
    });
    if (parts[0] === 'papers') {
      if (parts.length === 1) return renderPaperSubjects();
      if (SUBJECT_ORDER.indexOf(parts[1]) >= 0) {
        if (parts.length === 2) return renderPaperYears(parts[1]);
        if (parts.length === 3 && /^\d{4}$/.test(parts[2])) return renderPaperReader(parts[1], parts[2]);
        if (parts.length === 4 && /^20\d{2}$/.test(parts[2]) && /^[a-z0-9][a-z0-9-]{0,79}$/.test(parts[3])) return renderPaperReader(parts[1], parts[2], false, parts[3]);
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
      '<header class="page-head"><div><h1 class="page-title"><span class="persona-icon persona-icon-library" aria-hidden="true"></span> 複習資料</h1>' +
      '<p class="page-sub">從錯因複習到整卷回顧，選擇今天的閱讀方向。</p></div>' +
      '<a class="btn btn-ghost" href="#/">← 主頁</a></header>' +
      '<div class="library-hub-grid">' +
        '<a class="library-hub-card library-hub-books" href="#/library/books">' +
          '<span class="library-hub-icon" aria-hidden="true"><span class="persona-icon persona-icon-library" aria-hidden="true"></span></span><span class="library-hub-kicker">按課題複習</span>' +
          '<h2>錯題庫</h2><p class="library-hub-description">把做錯的題、錯因與得分要點放在一起，逐個知識點讀懂。</p>' +
          '<div class="library-hub-stats"><span><b>' + total + '</b><small>收錄題目</small></span>' +
            '<span><b>' + pending + '</b><small>本輪待複習</small></span>' +
            '<span><b>' + (total - pending) + '</b><small>本輪已全對</small></span></div>' +
          '<div class="library-hub-tags">' + SUBJECT_ORDER.map(function (code) {
            return '<span>' + SUBJECT_META[code].icon + ' ' + SUBJECT_META[code].name + ' · ' + itemsOf(code).length + ' 題</span>';
          }).join('') + '</div><p class="library-hub-note">未練過或最新未全對的題目列為待複習。</p>' +
          '<span class="library-hub-action">按課題查看錯題 <span aria-hidden="true">↗</span></span></a>' +
        '<a class="library-hub-card library-hub-papers" href="#/library/papers">' +
          '<span class="library-hub-icon" aria-hidden="true"><span class="persona-icon persona-icon-papers" aria-hidden="true"></span></span><span class="library-hub-kicker">按年份回顧</span>' +
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
      if (catalog && catalog.subjects) SUBJECT_ORDER.forEach(function (code) { if (['math','m2','physics'].indexOf(code) >= 0 && !Object.prototype.hasOwnProperty.call(catalog.subjects, code)) catalog.subjects[code] = []; });
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
        count += Array.isArray(catalog.entries) ? catalog.entries.filter(function (entry) { return entry.subject === code; }).length : catalog.subjects[code].length;
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
    var info = window.DSELibrary.sourceInfo(year, detail, itemsOf(subject));
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
    return '<a class="paper-year" href="#/library/papers/' + subject + '/' + year + (detail.paper_id ? '/' + detail.paper_id : '') + '">' +
      '<span class="paper-year-heading"><strong>' + esc(info.label) + '</strong><small>' + esc(info.mock ? '紅筆批改卷' : detail.title || (metrics ? assessment.scope : '紅筆批改卷')) + '</small></span>' +
      '<span class="paper-year-score">' + score + '</span><span class="paper-grade-gaps">' + gaps + '</span>' +
      '<span class="paper-year-arrow" aria-hidden="true">→</span>' +
      '<span class="paper-year-foot">' + (components ? components + ' · ' : '') + (Number.isInteger(detail.pages) ? detail.pages + ' 頁 · ' : '') +
        (metrics ? '等級按原批改總結的民間參考分界估算' : '可先閱讀完整批改卷') + '</span></a>';
  }
  function releasePaper() {
    paperRequest++;
    paperToolsOpen = false; paperHeaderVisible = false;
    if (paperController) { paperController.abort(); paperController = null; }
    if (paperReader) { paperReader.destroy(); paperReader = null; }
    paperManifest = null;
    clearReaderPages();
  }
  function paperError(err, session, requestId, status, pageRequest) {
    if (requestId !== paperRequest) return;
    status.classList.remove('is-reading');
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
      '<header class="page-head"><div><h1 class="page-title"><span class="persona-icon persona-icon-papers" aria-hidden="true"></span> 紅筆批改卷</h1>' +
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
      var entries = Array.isArray(catalog.entries) ? catalog.entries.filter(function (entry) { return entry.subject === subject; }) : years.map(function (year) { return Object.assign({ year: year }, catalog.papers && catalog.papers[subject] && catalog.papers[subject][year]); });
      entries.sort(function (a, b) { return window.DSELibrary.compareSources(window.DSELibrary.sourceInfo(a.year, a, itemsOf(subject)), window.DSELibrary.sourceInfo(b.year, b, itemsOf(subject))); });
      status.textContent = '已發布 ' + entries.length + ' 套批改卷，涵蓋 ' + years.length + ' 個年份。';
      $('#paperYears').innerHTML = entries.map(function (entry) {
        return renderPaperYear(subject, entry.year, entry);
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
    var hasMistakes = Array.isArray(paperManifest.mistakes) && paperManifest.mistakes.length > 0;
    $('#paperNextMistake').disabled = !hasMistakes;
    $('#paperNextMistake').title = hasMistakes ? '跳至下一處錯題批注；末尾回到第一處' :
      (Array.isArray(paperManifest.mistakes) ? '這份批改卷沒有錯題' : '這份批改卷尚未提供錯題位置');
    if ($('#paperPageSelect')._manifest !== paperManifest) {
      $('#paperPageSelect').innerHTML = Array.from({ length: paperManifest.pages }, function (_, index) {
        return '<option value="' + (index + 1) + '">' + (index + 1) + '</option>';
      }).join('');
      $('#paperPageSelect')._manifest = paperManifest;
    }
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
  function startPaperReader(session, requestId) {
    var subject = paperSubject, year = paperYear, manifest = paperManifest;
    var base = '/papers/' + subject + '/' + year + (paperIdentifier ? '/' + paperIdentifier : '');
    paperReader = window.DSEPaperReader({
      root: $('#paperReader'), scrollRoot: $('#contentScroll'), thumbs: $('#paperThumbList'),
      toolbar: $('#paperToolbar'), manifest: manifest, page: paperPage,
      title: SUBJECT_META[subject].name + ' ' + year + ' 年紅筆批改卷',
      loadPage: function (page) { return readerPage(base + '/pages/' + manifest.version + '/' + page, session); },
      loadThumbnails: function () { return readerPage(base + '/thumbnails/' + manifest.version, session); },
      onPage: function (page, url) {
        if (requestId !== paperRequest) return;
        paperPage = page; updatePaperControls();
        readerPages.forEach(function (entry, key) {
          var prefix = session + ':' + base + '/pages/' + manifest.version + '/';
          if (entry.controller && key.indexOf(prefix) === 0 && Math.abs(Number(key.slice(prefix.length)) - page) > 3) {
            readerPages.delete(key); entry.controller.abort();
          }
        });
        $('#paperOpen').hidden = !url; $('#paperOpen').href = url || '';
        $('#paperStatus').classList.add('is-reading');
        $('#paperStatus').textContent = '第 ' + page + ' / ' + manifest.pages + ' 頁 · 向下捲動連續閱讀';
      },
      onError: function (error) { paperError(error, session, requestId, $('#paperStatus'), true); },
      onThumbnailError: function () { $('#paperThumbStatus').textContent = '預覽暫未載入，仍可按頁碼跳轉。'; },
      onNavigate: function () {
        if (window.matchMedia && window.matchMedia('(max-width: 699px)').matches) {
          setPaperThumbnails(false); $('#paperThumbToggle').focus();
        }
      }
    });
  }
  function goPaperPage(page) {
    if (paperReader) paperReader.go(page);
  }
  function setPaperTools(open, restoreFocus) {
    paperToolsOpen = open;
    $('#paperTools').hidden = !open;
    $('#paperToolsToggle').setAttribute('aria-expanded', String(open));
    if (restoreFocus) $('#paperToolsToggle').focus({ preventScroll: true });
  }
  function togglePaperHeader() {
    paperHeaderVisible = !paperHeaderVisible;
    var change = function () {
      $('#paperReadingPage').classList.toggle('paper-show-header', paperHeaderVisible);
      $('#paperHeaderToggle').setAttribute('aria-pressed', String(paperHeaderVisible));
      $('#paperHeaderToggle').textContent = paperHeaderVisible ? '隱藏網站頂欄' : '顯示網站頂欄';
    };
    if (paperReader) paperReader.layoutChange(change); else change();
    setPaperTools(false, true);
  }
  function setPaperThumbnails(open) {
    var change = function () {
      $('#paperWorkspace').classList.toggle('is-thumbs-hidden', !open);
      $('#paperThumbnails').hidden = !open;
      $('#paperThumbToggle').setAttribute('aria-expanded', String(open));
      $('#paperThumbToggle').textContent = '預覽';
      $('#paperThumbToggle').setAttribute('aria-label', open ? '收起頁面預覽' : '展開頁面預覽');
    };
    if (paperReader) paperReader.layoutChange(change); else change();
  }
  function loadPaper(fresh) {
    var session = localStorage.getItem(LS_SYNC_SESSION), requestId = ++paperRequest;
    var status = $('#paperStatus');
    if (!session || !SYNC_API) { status.textContent = '請先登入網站，再閱讀私人批改卷。'; return; }
    var controller = new AbortController();
    paperController = controller;
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    status.textContent = '正在查看' + SUBJECT_META[paperSubject].name + ' ' + paperYear + ' 年批改卷頁數…';
    fetch(SYNC_API + '/papers/' + paperSubject + '/' + paperYear + (paperIdentifier ? '/' + paperIdentifier : '') + '/manifest' + (fresh ? '?refresh=' + Date.now() : ''), {
      method: 'GET', headers: { Authorization: 'Bearer ' + session },
      cache: 'no-store', signal: controller.signal,
    }).then(readSyncResponse).then(function (manifest) {
      if (requestId !== paperRequest || localStorage.getItem(LS_SYNC_SESSION) !== session) return;
      if (!manifest || !/^[a-f0-9]{16}$/.test(manifest.version) ||
        !Number.isInteger(manifest.pages) || manifest.pages < 1 || manifest.pages > 9999) throw new Error('批改卷頁面清單無效');
      paperManifest = manifest;
      if (paperPage > manifest.pages) paperPage = 1;
      $('#paperReader').hidden = false;
      startPaperReader(session, requestId);
    }).catch(function (err) {
      paperError(err, session, requestId, status, false);
    }).finally(function () {
      clearTimeout(timeout);
      if (requestId === paperRequest) paperController = null;
    });
  }
  function renderPaperReader(subject, year, fresh, identifier) {
    identifier = identifier || '';
    if (paperSubject !== subject || paperYear !== year || paperIdentifier !== identifier) paperPage = 1;
    paperSubject = subject; paperYear = year; paperIdentifier = identifier;
    var catalogEntry = paperCatalogSnapshot && paperCatalogSnapshot.data && Array.isArray(paperCatalogSnapshot.data.entries) && paperCatalogSnapshot.data.entries.filter(function (entry) {
      return entry.subject === subject && entry.year === year && entry.paper_id === identifier;
    })[0];
    var readerDetail = catalogEntry || paperCatalogSnapshot && paperCatalogSnapshot.data && paperCatalogSnapshot.data.papers && paperCatalogSnapshot.data.papers[subject] && paperCatalogSnapshot.data.papers[subject][year];
    var readerInfo = window.DSELibrary.sourceInfo(year, readerDetail, itemsOf(subject));
    var readerTitle = SUBJECT_META[subject].name + ' ' + (readerInfo.mock ? readerInfo.label : catalogEntry ? catalogEntry.title : year + ' 年批改卷');
    paperToolsOpen = false; paperHeaderVisible = false;
    $('#app').innerHTML = '<section class="page library-page paper-reading-page" id="paperReadingPage" aria-labelledby="paperTitle">' +
      '<div class="paper-toolbar" id="paperToolbar">' +
        '<div class="paper-controls"><a class="btn btn-ghost paper-back" href="#/library/papers/' + subject + '" aria-label="返回批改卷年份" title="返回年份">←</a>' +
        '<button class="btn btn-ghost" id="paperThumbToggle" type="button" aria-controls="paperThumbnails" aria-expanded="true" title="頁面預覽">預覽</button>' +
        '<h1 class="paper-reader-title" id="paperTitle">' + esc(readerTitle) + '</h1>' +
        '<button class="btn btn-ghost paper-next-mistake" id="paperNextMistake" type="button" aria-label="下一錯題位置" disabled title="正在載入錯題位置"><span class="paper-mistake-long">下一錯題位置</span><span class="paper-mistake-short" aria-hidden="true">下一錯題</span></button>' +
        '<label class="paper-page-label"><select id="paperPageSelect" aria-label="選擇批改卷頁碼"></select><span> / <span id="paperPageCount">—</span></span></label>' +
        '<button class="btn btn-ghost" id="paperToolsToggle" type="button" aria-label="更多閱讀工具" title="更多閱讀工具" aria-controls="paperTools" aria-expanded="false">⋯</button></div>' +
        '<div class="paper-tools" id="paperTools" role="region" aria-label="閱讀工具" hidden>' +
          '<strong>分部跳轉</strong><nav class="paper-sections" id="paperSections" aria-label="批改卷分部跳轉" hidden></nav>' +
          '<div class="paper-tool-actions"><button class="btn btn-ghost" id="paperPrev" type="button" disabled>← 上一頁</button>' +
          '<button class="btn btn-ghost" id="paperNext" type="button" disabled>下一頁 →</button>' +
          '<button class="btn btn-ghost" id="paperReload" type="button">重新載入</button>' +
          '<a class="btn btn-ghost" id="paperOpen" target="_blank" rel="noopener" hidden>放大本頁 ↗</a>' +
          '<button class="btn btn-ghost" id="paperHeaderToggle" type="button" aria-pressed="false">顯示網站頂欄</button></div></div></div>' +
      '<p class="review-note paper-status" id="paperStatus" role="status" aria-live="polite"></p>' +
      '<div class="paper-workspace" id="paperWorkspace"><aside class="paper-thumbnails" id="paperThumbnails" aria-label="批改卷頁面預覽">' +
        '<div class="paper-thumb-heading"><strong>頁面預覽</strong><button class="btn btn-ghost" id="paperThumbClose" type="button">收起</button></div>' +
        '<p class="library-note" id="paperThumbStatus">點選頁面跳轉</p><div class="paper-thumb-list" id="paperThumbList"></div></aside>' +
        '<div class="paper-stream" id="paperReader" hidden></div></div></section>';
    $('#paperReader').hidden = true;
    $('#paperOpen').hidden = true; $('#paperOpen').href = '';
    $('#paperReload').addEventListener('click', function () { releasePaper(); renderPaperReader(subject, year, true, identifier); });
    $('#paperSections').addEventListener('click', function (event) {
      var button = event.target.closest('[data-page]');
      if (button) { setPaperTools(false, true); goPaperPage(Number(button.dataset.page)); }
    });
    $('#paperPrev').addEventListener('click', function () { setPaperTools(false, true); goPaperPage(paperPage - 1); });
    $('#paperNext').addEventListener('click', function () { setPaperTools(false, true); goPaperPage(paperPage + 1); });
    $('#paperNextMistake').addEventListener('click', function () {
      if (!paperReader) return;
      setPaperTools(false);
      if (window.matchMedia && window.matchMedia('(max-width: 699px)').matches) setPaperThumbnails(false);
      var target = paperReader.nextMistake();
      if (target) toast((target.wrapped ? '已回到首個錯題 · ' : '') + target.label + ' · 第 ' + target.page + ' 頁（' + target.index + '/' + target.total + '）');
    });
    $('#paperTools').hidden = true;
    $('#paperToolsToggle').addEventListener('click', function () {
      if (window.matchMedia && window.matchMedia('(max-width: 699px)').matches) setPaperThumbnails(false);
      setPaperTools(!paperToolsOpen);
    });
    $('#paperHeaderToggle').addEventListener('click', togglePaperHeader);
    $('#paperPageSelect').addEventListener('change', function (event) { goPaperPage(Number(event.target.value)); });
    $('#paperThumbToggle').addEventListener('click', function () { setPaperTools(false); setPaperThumbnails($('#paperThumbnails').hidden); });
    $('#paperThumbClose').addEventListener('click', function () { setPaperThumbnails(false); $('#paperThumbToggle').focus(); });
    setPaperThumbnails(!(window.matchMedia && window.matchMedia('(max-width: 699px)').matches));
    loadPaper(fresh);
  }

  document.addEventListener('click', function (event) {
    if (paperToolsOpen && !event.target.closest('#paperToolbar')) setPaperTools(false);
  });
  document.addEventListener('keydown', function (event) {
    if (paperToolsOpen && event.key === 'Escape') { event.preventDefault(); setPaperTools(false, true); }
  });

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
          toast('新嘅雙週開始，進度已重置！');
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
      '<div class="tile-body"><div class="tile-title"><span class="tile-en" aria-hidden="true">' + ({ '開始練習': 'TOPICS', '錯題庫': 'ARCHIVE', '紅筆批改卷': 'PAPERS', '做題記錄': 'RECORDS', '隨機十題': 'RANDOM' }[title] || '') + '</span><span class="tile-cn">' + title + '</span></div>' +
      '<div class="tile-desc">' + desc + '</div></div>' +
      '<div class="tile-arrow">→</div></a>';
  }
  function pctOf(code, marks) {
    var st = topicStats(code);
    var all = Object.keys(st).reduce(function (s, t) { return s + st[t].marks; }, 0);
    return (all ? Math.round(marks / all * 100) : 0) + '%';
  }

  function practiceHref(code, year) {
    return '#/practice/' + code + (year && year !== 'all' ? '/' + encodeURIComponent(year) : '');
  }
  function practiceSessionHref(code, topic, year) {
    return '#/session/' + code + '/' + encodeURIComponent(topic) + (year && year !== 'all' ? '/' + encodeURIComponent(year) : '');
  }

  /* ---------------- 練習頁：年份 → 課題，科目切換保留可用年份 ---------------- */
  function renderPractice(code, requestedYear) {
    if (SUBJECT_META[code] && SUBJECT_META[code].soon) {
      $('#app').innerHTML = '<section class="page"><div class="soon-banner"><span class="persona-icon persona-icon-math" aria-hidden="true"></span> ' +
        esc(SUBJECT_META[code].name) + ' 錯題庫即將推出，考完好試卷就會自動出現。</div>' +
        '<a class="btn btn-primary" href="#/practice/' + SUBJECT_ORDER[0] + '">← 返回科目</a></section>';
      return;
    }
    if (!subjOf(code)) code = SUBJECT_ORDER[0];
    var years = window.DSELibrary.sourceYears(itemsOf(code));
    var selected = requestedYear || 'all';
    if (years.indexOf(selected) < 0) selected = 'all';
    var subjectIndex = SUBJECT_ORDER.indexOf(code);
    var previous = SUBJECT_ORDER[(subjectIndex + SUBJECT_ORDER.length - 1) % SUBJECT_ORDER.length];
    var next = SUBJECT_ORDER[(subjectIndex + 1) % SUBJECT_ORDER.length];
    function switchHref(subject) {
      var year = selected === 'all' || itemsOf(subject).some(function (it) { return String(it.year) === selected; }) ? selected : 'all';
      return practiceHref(subject, year);
    }
    var filtered = itemsOf(code).filter(function (it) { return selected === 'all' || String(it.year) === selected; });
    var latest = latestMap(), st = {};
    filtered.forEach(function (it) {
      var row = st[it.topic] || (st[it.topic] = { topic: it.topic, marks: 0, known: 0, n: 0, due: 0 });
      row.n++;
      if (Number.isFinite(it.lost)) { row.marks += it.lost; row.known++; }
      if (isWrong(latest[it.id])) row.due++;
    });
    var rows = Object.keys(st).map(function (key) { return st[key]; }).sort(function (a, b) {
      if ((a.due > 0) !== (b.due > 0)) return a.due > 0 ? -1 : 1;
      return b.marks - a.marks;
    });
    var selectionInfo = window.DSELibrary.sourceInfo(selected, null, itemsOf(code));
    var yearLabel = selected === 'all' ? '全部年份' : selectionInfo.label + (selectionInfo.mock ? '' : ' 年');
    var catalog = null, requestId = paperRequest;
    $('#app').innerHTML = '<section class="page practice-inventory">' +
      '<header class="page-head"><div><h1 class="page-title">課題練習</h1><p class="page-sub">先選年份，再揀課題開始練習。</p></div>' +
      '<div class="inventory-switch" aria-label="學科切換"><a class="shoulder-link" href="' + switchHref(previous) + '" aria-label="上一個學科：' + SUBJECT_META[previous].name + '">‹ LB</a>' +
      '<strong>' + SUBJECT_META[code].icon + ' ' + SUBJECT_META[code].name + '</strong><a class="shoulder-link" href="' + switchHref(next) + '" aria-label="下一個學科：' + SUBJECT_META[next].name + '">RB ›</a></div>' +
      '<a class="btn btn-ghost" href="#/">← 主頁</a></header>' +
      '<div class="inventory-layout"><section class="inventory-years" aria-label="選擇練習年份"><h2>YEAR SELECT <span>/ 選擇年份</span></h2>' +
      '<div class="year-list" id="practiceYears"></div><p class="year-grade-note">LV＝DSE 試卷參考等級（非官方估算）；HP＝原卷分數；SP＝錯題數。缺少適用分界時顯示「—」；單卷不評全科等級。</p>' +
      '<p class="year-grade-note" id="practiceGradeStatus" role="status">正在核對原卷成績…</p></section>' +
      '<section class="inventory-topics" aria-label="所選年份的課題"><div class="practice-topic-heading"><h2>TOPIC LIST <span>/ 選擇課題</span></h2>' +
      '<span>' + String(rows.length).padStart(2, '0') + ' TOPICS</span></div><p class="practice-selection" role="status">' + yearLabel + ' · ' + SUBJECT_META[code].name + ' · ' + filtered.length + ' 道錯題</p>' +
      '<div class="topic-list" id="practiceTopics">' + rows.map(function (row) {
        return '<a class="topic-card practice-topic' + (row.due ? '' : ' is-clear') + '" data-topic="' + esc(row.topic) + '" href="' + practiceSessionHref(code, row.topic, selected) + '">' +
          '<span class="practice-topic-code">' + esc(row.topic) + '</span><span class="topic-main"><span class="topic-name">' + esc(topicName(code, row.topic)) + '</span>' +
          '<span class="topic-meta">' + (row.due ? '待複習 ' + row.due + ' 題' : '本輪已清 ✔') + '</span></span>' +
          '<span class="practice-topic-count" aria-label="' + row.n + ' 道錯題"><small>×</small> ' + String(row.n).padStart(2, '0') + '</span></a>';
      }).join('') + (rows.length ? '' : '<div class="empty-note">此科目尚未收錄錯題，加入題庫後會自動顯示年份與課題。</div>') + '</div>' +
      '<section class="topic-info" aria-label="課題資訊"><span aria-hidden="true">INFO</span><div id="practiceTopicInfo" aria-live="polite"></div></section>' +
      (filtered.length ? '<a class="btn btn-random" href="' + practiceSessionHref(code, '__random__', selected) + '"><span class="persona-icon persona-icon-random" aria-hidden="true"></span> ' + yearLabel + '隨機抽 10 題</a>' : '') +
      '</section></div></section>';
    function drawYears() {
      years = window.DSELibrary.sourceYears(itemsOf(code), catalog && catalog.papers && catalog.papers[code]);
      $('#practiceYears').innerHTML = ['all'].concat(years).map(function (year) {
        var assessment = catalog && catalog.papers && catalog.papers[code] && catalog.papers[code][year] && catalog.papers[code][year].assessment;
        var info = window.DSELibrary.sourceInfo(year, catalog && catalog.papers && catalog.papers[code] && catalog.papers[code][year], itemsOf(code));
        var metrics = paperGradeMetrics(assessment);
        var level = metrics && metrics.current ? metrics.current.level : '—';
        var count = itemsOf(code).filter(function (it) { return year === 'all' || String(it.year) === year; }).length;
        return '<button class="inventory-year" type="button" data-practice-year="' + esc(year) + '" aria-pressed="' + (year === selected) + '">' +
          '<span class="year-number" aria-hidden="true">' + (year === 'all' ? 'ALL' : esc(info.badge)) + '</span><span class="year-body"><span class="year-name">' +
          (year === 'all' ? '全部年份' : esc(info.label + ' ' + SUBJECT_META[code].name)) + '</span><span class="year-meters">' +
          (year === 'all' ? '' : '<span><abbr title="DSE 試卷等級">LV</abbr> <b>' + esc(level) + '</b></span><span><abbr title="原卷分數">HP</abbr> <b>' +
            (metrics ? assessment.earned + '<small>/' + assessment.total + '</small>' : '—') + '</b></span>') +
          '<span><abbr title="錯題數">SP</abbr> <b>' + count + '</b></span></span>' +
          (year !== 'all' && metrics ? '<span class="year-grade-note">' + esc(info.mock ? info.label + ' · ' + SUBJECT_META[code].name : assessment.scope) + (metrics.current ? ' · 等級估算' : ' · 等級未評') + '</span>' : '') + '</span></button>';
      }).join('');
      var list = $('#practiceYears'), active = $('#practiceYears [aria-pressed="true"]');
      if (active && list.scrollWidth > list.clientWidth) list.scrollLeft = active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2;
    }
    function inspect(row) {
      $('#practiceTopicInfo').innerHTML = '<h3>' + esc(row.topic + ' ' + topicName(code, row.topic)) + '</h3><p>' + yearLabel + ' · ' + row.n + ' 道錯題 · ' + row.due + ' 題待複習' +
        (row.known === row.n ? ' · 原卷失分 ' + row.marks + ' 分' : ' · 原卷失分以已核實資料為準') + '。</p><a href="' + practiceSessionHref(code, row.topic, selected) + '">開始這個課題 ↗</a>';
      $all('#practiceTopics [data-topic]').forEach(function (link) { link.classList.toggle('inspected', link.dataset.topic === row.topic); });
    }
    drawYears();
    $('#practiceYears').addEventListener('click', function (event) {
      var button = event.target.closest('[data-practice-year]');
      if (button) location.hash = practiceHref(code, button.dataset.practiceYear);
    });
    $all('#practiceTopics [data-topic]').forEach(function (link) {
      var row = st[link.dataset.topic];
      link.addEventListener('mouseenter', function () { inspect(row); });
      link.addEventListener('focus', function () { inspect(row); });
    });
    if (rows.length) inspect(rows[0]); else $('#practiceTopicInfo').textContent = '加入錯題後即可查看課題資訊。';
    var session = localStorage.getItem(LS_SYNC_SESSION);
    if (!session || !SYNC_API) { $('#practiceGradeStatus').textContent = '登入後可核對原卷成績；現有題目仍可練習。'; return; }
    var controller = new AbortController();
    paperController = controller;
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    fetchPaperCatalog(session, controller.signal).then(function (result) {
      if (requestId !== paperRequest || localStorage.getItem(LS_SYNC_SESSION) !== session) return;
      catalog = result;
      var focused = document.activeElement, year = focused && focused.dataset && focused.dataset.practiceYear;
      drawYears();
      if (year) { var replacement = $('#practiceYears [data-practice-year="' + year + '"]'); if (replacement) replacement.focus(); }
      $('#practiceGradeStatus').textContent = '已核對私人批改卷的成績與 DSE 參考分界；只列出已收錄錯題的年份。';
    }).catch(function (err) {
      if (requestId !== paperRequest) return;
      expireConnection(err, session);
      if (requestId !== paperRequest) return;
      $('#practiceGradeStatus').textContent = '原卷成績暫未能讀取，可先選年份練習。';
    }).finally(function () {
      clearTimeout(timeout);
      if (requestId === paperRequest) paperController = null;
    });
  }

  /* ---------------- 隨機十題科目選擇 ---------------- */
  function renderRandomPicker() {
    var cards = SUBJECT_ORDER.map(function (code) {
      var m = SUBJECT_META[code];
      var n = subjOf(code) ? itemsOf(code).length : 0;
      if (!n) {
        return '<div class="rand-card is-soon">' +
          '<div class="rand-ico">' + m.icon + '</div>' +
          '<div class="rand-name">' + esc(m.name) + '</div>' +
          '<div class="rand-note">題庫暫時未有題</div></div>';
      }
      return '<a class="rand-card" href="#/session/' + code + '/' + encodeURIComponent('__random__') + '">' +
        '<div class="rand-ico">' + m.icon + '</div>' +
        '<div class="rand-name">' + esc(m.name) + '</div>' +
        '<div class="rand-note">' + n + ' 題錯題中隨機抽 ' + Math.min(10, n) + ' 題 →</div></a>';
    }).join('');
    $('#app').innerHTML =
      '<section class="page">' +
        '<header class="page-head"><div><h1 class="page-title"><span class="persona-icon persona-icon-random" aria-hidden="true"></span> 隨機十題</h1>' +
        '<p class="page-sub">揀一科，由全部錯題隨機抽 10 題出嚟，入面仲可以隨時「換一組」。</p></div>' +
        '<a class="btn btn-ghost" href="#/">← 主頁</a></header>' +
        '<div class="rand-grid">' + cards + '</div>' +
      '</section>';
  }

  /* ---------------- 做題會話 ---------------- */
  var reviewState = null;   // 提交後的批改結果
  var sessState = { code: null, topic: null, mcOnly: false };

  function sessionItems(code, topic, mcOnly, year) {
    if (topic === '__today__') {
      if (!todaySelection) {
        var rows = todayRows(code).slice(0, 5);
        todaySelection = { ids: rows.map(function (r) { return r.item.id; }), rows: rows };
      }
      return todaySelection.rows.map(function (r) { return r.item; }).filter(function (it) { return !mcOnly || it.kind === 'mc'; });
    }
    var pool = itemsOf(code).filter(function (it) {
      return it.topic === topic && (!mcOnly || it.kind === 'mc') && (!year || String(it.year) === year);
    });
    if (topic === '__random__') {
      pool = itemsOf(code).filter(function (it) { return (!mcOnly || it.kind === 'mc') && (!year || String(it.year) === year); });
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1)), t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
      pool = pool.slice(0, 10);
    }
    return pool;
  }

  function renderSession(code, topic, mcOnly, year) {
    if (code !== 'all' && SUBJECT_ORDER.indexOf(code) < 0) return renderPractice(SUBJECT_ORDER[0]);
    if (!topic) { location.hash = '#/practice'; return; }
    if (!subjOf(code)) {
      $('#app').innerHTML =
        '<section class="page"><div class="soon-banner"><span class="persona-icon persona-icon-math" aria-hidden="true"></span> ' + esc(SUBJECT_META[code] ? SUBJECT_META[code].name : code) +
        ' 嘅錯題庫暫時未有題，改完好試卷就會自動出現。</div>' +
        '<a class="btn btn-primary" href="#/random">← 返隨機十題</a></section>';
      return;
    }
    if (mcOnly === undefined) mcOnly = false;
    year = /^20\d{2}$/.test(year || '') ? String(year) : '';
    sessState = { code: code, topic: topic, mcOnly: mcOnly, year: year };
    var items = sessionItems(code, topic, mcOnly, year);
    if (!items.length) { location.hash = practiceHref(code, year); return; }
    // 課題模式仍渲染全部題（大題靠 CSS 動畫收起）；隨機模式只渲染抽出的題
    var renderItems = (topic === '__random__' || topic === '__today__') ? items :
      itemsOf(code).filter(function (it) { return it.topic === topic && (!year || String(it.year) === year); });
    var activeIds = {};
    items.forEach(function (it) { activeIds[it.id] = true; });

    var dkey = code + ':' + topic +
      (topic === '__random__' || topic === '__today__' ? ':' + (mcOnly ? 'mc:' : '') +
        items.map(function (i) { return i.id; }).join(',') : '');
    var draft = drafts[dkey] || { pick: {}, text: {}, paper: {} };
    reviewState = null;

    var title = topic === '__random__'
      ? (mcOnly ? '<span class="persona-icon persona-icon-random" aria-hidden="true"></span> 隨機十題（選擇題）' : '<span class="persona-icon persona-icon-random" aria-hidden="true"></span> 隨機十題')
      : topic === '__today__' ? '今日複習' : esc(topic + ' ' + topicName(code, topic));
    var nMc = renderItems.filter(function (it) { return it.kind === 'mc'; }).length;
    var nSub = renderItems.length - nMc;
    $('#app').innerHTML =
      '<section class="page session' + (mcOnly ? ' mc-only' : '') +
        '" data-key="' + esc(dkey) + '" data-code="' + code + '" data-topic="' + esc(topic) + '">' +
        '<header class="page-head">' +
          '<div><h1 class="page-title">' + SUBJECT_META[code].icon + ' ' + title + '</h1>' +
          '<p class="page-sub">' + (year ? esc(window.DSELibrary.sourceInfo(year, null, itemsOf(code)).label) + ' · ' : '') + '<span id="answeredCount">0</span> / <span id="totalCount">' +
            items.length + '</span> 題已作答 · MC 自動批改，大題照踩分點自己勾分</p></div>' +
          '<div class="head-actions">' +
            (topic === '__random__'
              ? '<button class="btn btn-gold" id="rerollBtn" type="button"><span class="persona-icon persona-icon-random" aria-hidden="true"></span> 換一組十題</button>' : '') +
            '<label class="mc-toggle" title="時間唔夠就只刷選擇題，大題會收起、唔計分、唔入記錄">' +
              '<input type="checkbox" id="mcOnlyChk"' + (mcOnly ? ' checked' : '') +
                (nMc ? '' : ' disabled') + '><span class="mc-switch"></span>' +
              '<span class="mc-toggle-lbl"><span class="persona-icon persona-icon-fast" aria-hidden="true"></span> 只做選擇題' +
                (nSub ? '<small>' + nMc + ' MC / ' + nSub + ' 大題</small>' : '') + '</span>' +
            '</label>' +
            '<a class="btn btn-ghost" href="' +
              (topic === '__random__' && !year ? '#/random' : practiceHref(code, year)) + '">← 離開</a>' +
          '</div>' +
        '</header>' +
        (topic === '__random__'
          ? '<div class="subj-tabs rand-tabs">' +
              SUBJECT_ORDER.map(function (c) {
                var m = SUBJECT_META[c];
                var n = subjOf(c) ? itemsOf(c).length : 0;
                if (!n) return '<span class="subj-tab is-soon">' + m.icon + ' ' + m.name +
                  '<small>未有題</small></span>';
                return '<a class="subj-tab' + (c === code ? ' on' : '') +
                  '" href="' + practiceSessionHref(c, '__random__', year && itemsOf(c).some(function (it) { return String(it.year) === year; }) ? year : '') + '">' +
                  m.icon + ' ' + m.name + '</a>';
              }).join('') +
            '</div>' : '') +
        (mcOnly && nSub ? '<div class="mc-only-note"><span class="persona-icon persona-icon-fast" aria-hidden="true"></span> 已切為只做選擇題：' + nSub +
          ' 道大題已收起，今次唔使答、唔計分、唔入記錄。</div>' : '') +
        '<div class="q-paper" id="qPaper">' +
          renderItems.map(function (it, idx) { return questionHtml(it, idx, draft, mcOnly); }).join('') +
        '</div>' +
        '<div class="submit-bar" id="submitBar">' +
          '<button class="btn btn-primary btn-lg" id="submitBtn" type="button">' +
            (mcOnly ? '<span class="persona-icon persona-icon-success" aria-hidden="true"></span> 提交 ' + nMc + ' 道選擇題' : '<span class="persona-icon persona-icon-success" aria-hidden="true"></span> 全部做完，一次過提交') + '</button>' +
        '</div>' +
        '<div class="result-panel" id="resultPanel" hidden></div>' +
      '</section>';

    bindSession(code, topic, dkey, renderItems, items, mcOnly);
    hydratePrivateImages();
  }

  function questionContentHtml(it) {
    // Older MC cards carry a complete question image, including their options.
    if (it.kind === 'mc' && it.img) return '<img class="q-img" ' +
      (PRIVATE_BANK ? 'data-bank-image="' + esc(it.img) + '"' : 'src="' + esc(it.img) + '"') + ' alt="原題裁圖">';
    function text(value) { return esc(value).replace(/\n/g, '<br>'); }
    return '<div class="q-stem q-content"><p>' + text(it.stemFull || it.stem) + '</p>' +
      (Array.isArray(it.tables) ? it.tables.map(function (table) {
        return '<div class="ml-table-wrap" tabindex="0" role="region" aria-label="' + esc(table.caption) + '"><table><caption>' + text(table.caption) +
          '</caption><thead><tr>' + table.headers.map(function (h) { return '<th scope="col">' + text(h) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + table.rows.map(function (row) { return '<tr>' + row.map(function (cell) { return '<td>' + text(cell) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
      }).join('') : '') +
      (Array.isArray(it.figures) ? it.figures.map(function (f) {
        if (!f || !/^images\/(?:chem|bio|math|m2|physics)-\d{4}-fig-[a-z0-9-]+\.jpg$/.test(f.path)) return '';
        return '<figure><img class="q-img" ' + (PRIVATE_BANK ? 'data-bank-image="' + esc(f.path) + '"' : 'src="' + esc(f.path) + '"') +
          ' loading="lazy" decoding="async" alt="' + esc(f.alt || '原題圖表') + '"' +
          (f.width > 0 && f.height > 0 ? ' width="' + Number(f.width) + '" height="' + Number(f.height) + '"' : '') +
          '><figcaption>' + text(f.alt || '') + '</figcaption></figure>';
      }).join('') : '') +
      (it.kind === 'mc' && Array.isArray(it.options) ? '<ol class="q-options" type="A" aria-label="選項內容">' +
        it.options.map(function (option) { return '<li>' + text(option) + '</li>'; }).join('') + '</ol>' : '') + '</div>';
  }

  function questionAnswerFields(item) {
    var maximum=marksOf(item), fields=item.answerFields;
    if(Array.isArray(fields) && fields.length && fields.length<=6 && fields.every(function(s){return typeof s==='string' && s.trim() && s.length<=90;})) {
      return maximum<=1?fields.slice(0,1):fields.slice();
    }
    var stem=item.stemFull || item.stem || '', single='本題答案';
    if(/名稱|名称/.test(stem))single='名稱';
    else if(/顏色變化|颜色变化/.test(stem))single='顏色變化';
    else if(/方程式/.test(stem))single='方程式';
    else if(/計算|计算|求|整數|整数/.test(stem))single='結果／必要計算';
    else if(/解釋|解释|為何|为何|为什么|為什麼/.test(stem))single='原因／解釋';
    if(maximum<=1)return [single];
    var count=stem.match(/(?:寫出|写出|提出|列出).{0,18}?([兩两二三四五六2-6])(?:種|种|項|项|個|个)/), numbers={'兩':2,'两':2,'二':2,'三':3,'四':4,'五':5,'六':6};
    if(count)return Array.from({length:Math.min(maximum,numbers[count[1]] || Number(count[1]))},function(_,i){return '第 '+(i+1)+' 項';});
    if(/計算|计算|求/.test(stem))return ['列式與計算','結果（連單位／條件）'];
    return ['本題作答'];
  }
  function stepAnswerText(rows) {
    return rows.map(function(r,i){return r.answer.trim()?(rows.length===1?'':(i+1)+'. ')+r.answer.trim():'';}).filter(Boolean).join('\n');
  }
  function answerStepState(item, value, saved) {
    var fields=questionAnswerFields(item), rows=fields.map(function(prompt){return {prompt:prompt,answer:''};});
    var compatible=saved && saved.version===2 && Array.isArray(saved.rows) && saved.rows.length>=fields.length && saved.rows.length<=6 &&
      saved.rows.every(function(r){return r && typeof r.answer==='string';});
    if(compatible){
      rows=fields.map(function(prompt,i){return {prompt:prompt,answer:saved.rows[i].answer};});
      var extra=saved.rows.slice(fields.length).map(function(r){return r.answer;}).filter(function(answer){return answer.trim();});
      if(extra.length)rows[rows.length-1].answer=[rows[rows.length-1].answer].concat(extra).filter(Boolean).join('\n');
    }
    else if(value)rows[0].answer=value;
    return { version:2, mode:saved?saved.mode==='text'?'text':'steps':value?'text':'steps', assisted:!!(saved && saved.assisted), rows:rows };
  }
  function stepRowsHtml(rows) {
    return rows.map(function (row, index) {
      return '<label class="step-row"><span><b>'+(index+1)+'</b> '+esc(row.prompt)+'</span>' +
        '<textarea class="step-input" data-step="'+index+'" rows="2" maxlength="1000" placeholder="短句、關鍵詞或公式都可以">'+esc(row.answer)+'</textarea></label>';
    }).join('');
  }
  function stepAnswerHtml(item, value, saved) {
    var state = answerStepState(item, value, saved), steps = state.mode === 'steps';
    return '<section class="step-answer" data-answer-id="'+esc(item.id)+'" aria-label="輕量作答">' +
      '<div class="answer-modes" role="group" aria-label="作答方式"><button class="btn btn-ghost" type="button" data-answer-mode="steps" aria-pressed="'+steps+'">按題分欄</button>' +
      '<button class="btn btn-ghost" type="button" data-answer-mode="text" aria-pressed="'+!steps+'">自由輸入</button></div>' +
      '<p class="review-note">'+(marksOf(item)<=1?'本題 1 分，一格作答即可。':'按本題要求分欄；可用短句、關鍵詞或公式作答。')+' 提交後再核對答案。</p>' +
      '<div class="step-rows"'+(steps?'':' hidden')+'>'+stepRowsHtml(state.rows)+'</div>' +
      '<label class="answer-free"'+(steps?' hidden':'')+'>我的答案<textarea class="ans-box" maxlength="6000" aria-label="本題文字答案" data-id="'+esc(item.id)+'" rows="4" placeholder="例如：設 x → 列式 → 結論；AI 會檢查有沒有缺少必要步驟">'+esc(value)+'</textarea></label>' +
      '<p class="step-note" role="status">答案會自動保存；未使用的欄位可留空。</p></section>';
  }
  function bindStepAnswers(root, draft, items, persist) {
    $all('.step-answer', root).forEach(function (widget) {
      var id=widget.dataset.answerId, item=items.filter(function(i){return i.id===id;})[0], field=$('.ans-box',widget), state=answerStepState(item,field.value,(draft.steps || {})[id]);
      function save() {
        if(state.mode==='steps') field.value=stepAnswerText(state.rows);
        persist(id,state,field.value);
      }
      function bindRows() {
        $all('.step-input',widget).forEach(function (input) {
          input.addEventListener('input',function () {state.rows[Number(input.dataset.step)].answer=input.value;save();});
        });
      }
      function renderRows() {$('.step-rows',widget).innerHTML=stepRowsHtml(state.rows);bindRows();}
      field.addEventListener('input',function () {if(state.mode==='text')save();});
      $all('[data-answer-mode]',widget).forEach(function (button) {button.addEventListener('click',function () {
        if(reviewState)return;
        var mode=button.dataset.answerMode;
        if(mode===state.mode)return;
        if(mode==='steps' && field.value!==stepAnswerText(state.rows)) {
          state.rows=questionAnswerFields(item).map(function(prompt,i){return {prompt:prompt,answer:i===0?field.value:''};});renderRows();
        }
        state.mode=mode;
        $('.step-rows',widget).hidden=mode!=='steps';$('.answer-free',widget).hidden=mode==='steps';
        $all('[data-answer-mode]',widget).forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.answerMode===mode));});save();
      });});
      bindRows();
    });
  }

  function questionHtml(it, idx, draft, mcOnly) {
    var head =
      '<div class="sq-head">' +
        '<span class="sq-no">' + (idx + 1) + '</span>' +
        '<span class="sq-badge">' + esc(window.DSELibrary.itemSource(it) + ' · ' + it.qref) + '</span>' +
        '<span class="sq-kind ' + (it.kind === 'mc' ? 'k-mc' : 'k-sub') + '">' +
          (it.kind === 'mc' ? '選擇 ' + marksOf(it) + ' 分' : '大題 ' + marksOf(it) + ' 分') + '</span>' +
      '</div>';
    if (sessState.topic === '__today__' && todaySelection) {
      var recommendation = todaySelection.rows.filter(function (r) { return r.item.id === it.id; })[0];
      if (recommendation) head += '<p class="today-reason">' + esc(SUBJECT_META[recommendation.code].name + ' · ' + recommendation.reason) + '</p>';
    }

    var body = '';
    if (it.kind === 'mc') {
      var picked = draft.pick[it.id] || '';
      body =
        questionContentHtml(it) +
        '<div class="opts" role="group" aria-label="第 ' + (idx + 1) + ' 題，選擇答案" data-id="' + esc(it.id) + '">' +
          ['A', 'B', 'C', 'D'].map(function (l) {
            return '<button type="button" class="opt' + (picked === l ? ' picked' : '') +
              '" data-l="' + l + '" aria-pressed="' + (picked === l) + '">' + l + '</button>';
          }).join('') +
        '</div>';
    } else {
      var v = draft.text[it.id] || '';
      body =
        questionContentHtml(it) + stepAnswerHtml(it, v, (draft.steps || {})[it.id]) +
        '<label class="paper-lbl"><input type="checkbox" class="paper-chk" data-id="' + esc(it.id) + '"' +
          (draft.paper[it.id] ? ' checked' : '') + '> 我已喺紙上寫完</label>';
    }
    return '<article class="sq" data-id="' + esc(it.id) + '" data-kind="' + it.kind + '" aria-label="第 ' + (idx + 1) + ' 題"' + (mcOnly && it.kind === 'sub' ? ' hidden' : '') + '>' + head + body + '</article>';
  }

  function bindSession(code, topic, dkey, renderItems, initialActive, mcOnly) {
    var activeItems = initialActive;
    var draft = drafts[dkey] || { pick: {}, text: {}, paper: {}, steps: {}, changedAt: {}, deletedAt: 0 };
    draft.steps = draft.steps || {};
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
      $('#submitBtn').innerHTML = sessState.mcOnly
        ? '<span class="persona-icon persona-icon-success" aria-hidden="true"></span> 提交 ' + nMc + ' 道選擇題'
        : '<span class="persona-icon persona-icon-success" aria-hidden="true"></span> 全部做完，一次過提交';
    }
    updateAnswered(); submitLabel();
    bindStepAnswers($('#qPaper'), draft, renderItems, function (id, state, answer) {
      draft.steps[id] = state; draft.text[id] = answer;
      persist('text', id); persist('steps', id);
    });

    // 隨機十題「換一組」：清走之前未提交嘅隨機草稿，重新抽題打亂
    var rerollBtn = $('#rerollBtn');
    if (rerollBtn) {
      rerollBtn.addEventListener('click', function () {
        var pfx = code + ':__random__';
        Object.keys(drafts).forEach(function (k) {
          if (k.indexOf(pfx) === 0) deleteDraft(k);
        });
        save();
        renderSession(code, topic, sessState.mcOnly, sessState.year);
        toast('已換一組新題');
      });
    }

    // 「只做選擇題」開關：課題頁就地動畫收起/展開；隨機頁重新抽 MC
    $('#mcOnlyChk').addEventListener('change', function () {
      var mc = this.checked;
      sessState.mcOnly = mc;
      if (topic === '__random__') { renderSession(code, topic, mc, sessState.year); return; }
      activeItems = sessionItems(code, topic, mc, sessState.year);
      var sec = $('.session');
      sec.classList.toggle('mc-only', mc);
      $all('.sq[data-kind="sub"]', sec).forEach(function (question) { question.hidden = mc; });
      var qPaper = $('#qPaper');
      var oldNote = $('.mc-only-note', sec);
      var nSub = renderItems.filter(function (it) { return it.kind === 'sub'; }).length;
      if (mc && nSub && !oldNote) {
        var note = document.createElement('div');
        note.className = 'mc-only-note';
        note.innerHTML = '<span class="persona-icon persona-icon-fast" aria-hidden="true"></span> 已切為只做選擇題：' + nSub +
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
          x.setAttribute('aria-pressed', String(x.dataset.l === draft.pick[id]));
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
      if (reviewState) return;
      var miss = activeItems.filter(function (it) {
        if (it.kind === 'mc') return !draft.pick[it.id];
        return !((draft.text[it.id] && draft.text[it.id].trim()) || draft.paper[it.id]);
      });
      if (miss.length) {
        toast(sessState.mcOnly
          ? '仲有 ' + miss.length + ' 題 MC 未揀'
          : '仲有 ' + miss.length + ' 題未作答（MC 要揀，大題可填分步簡答或文字答案）');
        var el = $('.sq[data-id="' + miss[0].id + '"]');
        if (el) el.scrollIntoView({ behavior: motionBehavior(), block: 'center' });
        return;
      }
      submitSession(code, topic, dkey, activeItems, draft, sessState.mcOnly);
    });
  }

  /* ---------- 提交批改 ---------- */
  function submitSession(code, topic, dkey, items, draft, mcOnly) {
    // Keep the exact submitted text separate from later draft cleanup and sync.
    draft = JSON.parse(JSON.stringify(draft));
    reviewState = { results: {} };
    $all('input,textarea,button', $('#qPaper')).forEach(function(control){control.disabled=true;});
    var submitted = false;
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
      '<h2><span class="persona-icon persona-icon-records" aria-hidden="true"></span> 批改結果' + (mcOnly ? '（只做選擇題，已自動批改）' : '（大題可請 AI 逐點分析）') + '</h2>' +
      '<div class="rp-score">MC <b id="mcScore">' + mcMarks + ' / ' + mcFull + '</b> 分' +
      (mcOnly ? '' : '　·　大題自評 <b id="subScore">待核對 / ' + subFull + '</b> 分') +
      '　·　'+(mcOnly?'總分':'練習自評')+' <b id="allScore">' + (mcOnly?mcMarks + ' / ' + mcFull:'待核對') + '</b></div></div>';

    items.forEach(function (it, idx) {
      html += '<article class="rq ' + (it.kind === 'mc' ? 'rq-mc' : 'rq-sub') + '" data-id="' + esc(it.id) + '">';
      html += '<div class="sq-head"><span class="sq-no">' + (idx + 1) + '</span>' +
        '<span class="sq-badge">' + esc(it.qref) + '</span></div>';

      if (it.kind === 'mc') {
        var correctL = letterOf(it.correctOpt), picked = draft.pick[it.id];
        var ok = picked === correctL;
        html += '<div class="judge ' + (ok ? 'j-ok' : 'j-bad') + '">' +
          (ok ? '<span class="persona-icon persona-icon-success" aria-hidden="true"></span> 答對（' + picked + '）' : '<span class="persona-icon persona-icon-warning" aria-hidden="true"></span> 你揀 ' + picked + ' · 正解 ' + correctL) + '</div>' +
          answerBlocks(it, false, '');
      } else {
        var draftText = draft.text[it.id] || '';
        if (draftText.trim()) {
          html += '<div class="ans-block ans-type"><div class="ans-title"><span class="persona-icon persona-icon-practice" aria-hidden="true"></span> 你本次提交的答案</div>' +
            '<div class="ans-body">' + highlight(draftText, keywordsOf(it)) + '</div></div>';
        }
        if ((draft.steps || {})[it.id]?.assisted) html += '<p class="review-note">此草稿保留了先前 AI 引導的作答記錄；以下只核對你實際填寫的答案。</p>';
        html += aiPanelHtml(it, draftText) + '<details class="review-reference"><summary>查看參考答案與當年錯因</summary>'+answerBlocks(it, true, '')+'</details>';
        var checks = it.checks || [];
        var wList = checks.map(function (c) { return /^✗/.test(c) ? 0 : 1; });
        var wTot = wList.reduce(function (a, b) { return a + b; }, 0);
        var rubric = window.DSELibrary.practiceRubric(it);
        html += '<details class="review-self-check"><summary>自行核對／調整練習得分</summary><p class="review-note">核對項可能含替代答案或同一分的細節，圈點數量不直接等於分數；練習自評與 AI 分析分開保存。</p><div class="chk-form" data-id="' + esc(it.id) + '" data-marks="' + marksOf(it) +
          '" data-wtot="' + wTot + '">' +
          '<div class="chk-form-h"><span class="persona-icon persona-icon-notes" aria-hidden="true"></span> 你寫到邊個踩分點？（剔中 ' +
            '<span class="chk-got">0</span>/<span class="chk-tot">' + wTot + '</span>' +
            '　·　<b class="chk-score">' + (rubric ? '0' : '待確認') + '</b>/' + marksOf(it) + ' 分；<span class="persona-icon persona-icon-warning" aria-hidden="true"></span> 項只係防錯提醒，唔計分）</div>' +
          checks.map(function (c, i) {
            return '<label class="chk-line' + (wList[i] ? '' : ' is-warn') + '">' +
              '<input type="checkbox" data-i="' + i + '" data-w="' + wList[i] + '">' +
              '<span class="chk-text">' + checkText(c) + '</span></label>';
          }).join('') + (rubric
            ? '<p class="review-note">依已核實的獨立給分組及替代條件計分；儲存前請核對你的實際答案。</p>'
            : '<label class="review-manual-score">確認本題練習得分 <input class="manual-score" type="number" min="0" max="' + marksOf(it) + '" step="any" required placeholder="0–' + marksOf(it) + '" aria-label="' + esc(it.qref) + ' 練習自評得分"></label><p class="review-note">本題尚未設定逐點計分規則，請對照參考答案確認得分；勾選核對項不會自動換算分數。</p>') + '</div></details>';
      }
      html += '</article>';
    });

    html += '<div class="rp-actions">' +
      '<button class="btn btn-primary btn-lg" id="saveSessionBtn" type="button"><span class="persona-icon persona-icon-papers" aria-hidden="true"></span> '+(mcOnly?'儲存做題記錄':'確認自評並儲存練習記錄')+'</button>' +
      '<a class="btn btn-ghost" href="' + practiceHref(code, sessState.year) + '">返課題列表</a></div>';

    var panel = $('#resultPanel');
    panel.hidden = false;
    panel.innerHTML = html;
    bindAIPanels(panel, items);
    panel.scrollIntoView({ behavior: motionBehavior(), block: 'start' });

    function subResult(it, f) {
      var selected = $all('input[type="checkbox"]:checked', f).map(function (cb) { return parseInt(cb.dataset.i, 10); });
      var n = selected.filter(function (i) { return !/^✗/.test((it.checks || [])[i] || ''); }).length;
      var manual = $('.manual-score', f), raw = manual && String(manual.value || '').trim();
      var score = window.DSELibrary.practiceScore(Object.assign({}, it, { marks: marksOf(it) }), selected, raw ? Number(raw) : null);
      return { kind: 'sub', marks: score, tot: marksOf(it), ok: score === marksOf(it),
        got: n, checks: (it.checks || []).filter(function (c) { return !/^✗/.test(c); }).length,
        checkedIndices: selected, assisted: !!((draft.steps || {})[it.id] || {}).assisted };
    }
    function recalcSub() {
      var got = 0, pending = false;
      $all('.chk-form', panel).forEach(function (f) {
        var it = items.filter(function (item) { return item.id === f.dataset.id; })[0];
        var result = subResult(it, f);
        $('.chk-got', f).textContent = result.got;
        $('.chk-score', f).textContent = result.marks == null ? '待確認' : result.marks;
        reviewState.results[it.id] = result;
        pending = pending || result.marks == null; got += result.marks || 0;
      });
      $('#subScore').textContent = pending ? '待確認 / ' + subFull : got + ' / ' + subFull;
      $('#allScore').textContent = pending ? '待確認' : (mcMarks + got) + ' / ' + (mcFull + subFull);
    }
    $all('.chk-form input', panel).forEach(function (cb) {
      cb.addEventListener('change', recalcSub);
      if (cb.type === 'number') cb.addEventListener('input', recalcSub);
    });

    $('#saveSessionBtn').addEventListener('click', function () {
      if (submitted) return;
      var missingScore = false;
      items.forEach(function (it) {
        if (it.kind !== 'sub' || mcOnly) return;
        var f = $('.chk-form[data-id="' + it.id + '"]', panel);
        var result = subResult(it, f); reviewState.results[it.id] = result;
        if (result.marks == null && !missingScore) {
          missingScore = true;
          var details = f.closest && f.closest('details'); if (details) details.open = true;
          var manual = $('.manual-score', f); if (manual) manual.focus();
        }
      });
      if (missingScore) { toast('請先逐題確認練習得分（0 至本題滿分），再儲存記錄'); return; }
      submitted = true;
      var subGotFinal = Object.keys(reviewState.results).reduce(function (s, id) {
        var r = reviewState.results[id];
        return s + (r.kind === 'sub' ? r.marks : 0);
      }, 0);
      var savedAt = Date.now();
      items.forEach(function (it) {
        var result = reviewState.results[it.id];
        updateReviewPlan(it.id, result, savedAt);
        result.attempt = window.DSELibrary.attemptSnapshot(Object.assign({}, it, { marks: marksOf(it) }),
          it.kind === 'mc' ? result.picked : (draft.text[it.id] || ''), result.checkedIndices || [], result, savedAt,
          { assisted: result.assisted, onPaper: !!(draft.paper || {})[it.id], nextReviewAt: (reviewPlan[it.id] || {}).dueAt });
      });
      sessions.push({
        t: savedAt, subj: code, topic: topic, mcOnly: !!mcOnly,
        results: JSON.parse(JSON.stringify(reviewState.results)),
        mc: mcMarks + '/' + mcFull, sub: mcOnly ? null : (subGotFinal + '/' + subFull)
      });
      if (topic !== '__random__' && (mcOnly || sessState.year)) {
        // 按年份提交只清本次題目，保留其他年份與未提交的大題草稿。
        draft = mergeDraft(drafts[dkey], draft);
        items.forEach(function (it) {
          (it.kind === 'mc' ? ['pick'] : ['text', 'paper', 'steps']).forEach(function (kind) {
            draft[kind] = draft[kind] || {};
            draft[kind][it.id] = kind === 'paper' ? false : '';
            draft.changedAt = draft.changedAt || {};
            var key = kind + ':' + it.id;
            draft.changedAt[key] = Math.max(Date.now(), Number(draft.changedAt[key]) + 1 || 0);
          });
        });
        if (!Object.values(draft.pick).some(Boolean) &&
            !Object.values(draft.text).some(Boolean) && !Object.values(draft.paper).some(Boolean)) deleteDraft(dkey);
        else drafts[dkey] = draft;
      } else {
        deleteDraft(dkey);
      }
      save();
      if (topic === '__today__') localStorage.removeItem(LS_TODAY);
      var totalGot = mcMarks + (mcOnly ? 0 : subGotFinal);
      var totalFull = mcFull + (mcOnly ? 0 : subFull);
      var pct = Math.round(totalGot / totalFull * 100);
      panel.innerHTML =
        '<div class="saved-card">' +
          '<div class="saved-icon"><span class="persona-icon persona-icon-celebrate" aria-hidden="true"></span></div>' +
          '<h2>已存入做題記錄</h2>' +
          '<div class="saved-score">' + totalGot + ' / ' + totalFull +
            ' 分（' + pct + '%）</div>' +
          '<div class="saved-sub">' + (mcOnly
            ? '<span class="persona-icon persona-icon-fast" aria-hidden="true"></span> 只做選擇題 · MC ' + mcMarks + '/' + mcFull
            : 'MC ' + mcMarks + '/' + mcFull + '　大題 ' + subGotFinal + '/' + subFull) + '</div>' +
          (topic === '__today__' ? '<div class="today-followup"><h3>仍需鞏固</h3>' +
            (items.filter(function (it) { return !window.DSELibrary.full(reviewState.results[it.id]); }).map(function (it) {
              var subject = SUBJECT_ORDER.filter(function (c) { return itemsOf(c).some(function (q) { return q.id === it.id; }); })[0];
              return '<p><a href="#/library/books/' + subject + '/' + encodeURIComponent(it.topic) + '">' + esc(SUBJECT_META[subject].name + ' · ' + it.qref) + ' → 查看錯因與解析</a></p>';
            }).join('') || '<p>本次全部答對，可按下一次間隔繼續鞏固。</p>') + '<a class="btn btn-primary" href="#/">返回今日複習</a></div>' : '') +
          '<div class="rp-actions"><a class="btn btn-primary" href="#/records"><span class="persona-icon persona-icon-records" aria-hidden="true"></span> 睇記錄</a>' +
          '<a class="btn btn-ghost" href="' + practiceHref(code, sessState.year) + '">繼續練習 →</a></div>' +
        '</div>';
      panel.scrollIntoView({ behavior: motionBehavior(), block: 'center' });
      toast('記錄已儲存 ✔');
    });
  }

  var AI_TAGS = ['概念混淆', '審題遺漏', '計算失誤', '表達不完整'];
  var aiStatusSnapshot = null;
  var aiReplyHistories = Object.create(null);
  function latestAI(id) {
    return Object.values(aiReviews).filter(function (r) { return r && r.questionId === id && r.confirmedAt; })
      .sort(function (a,b) { return b.confirmedAt-a.confirmedAt; })[0];
  }
  function confirmedTags(id) { var row = latestAI(id); return row && Array.isArray(row.tags) ? row.tags.filter(function (t) { return AI_TAGS.indexOf(t)>=0; }) : []; }
  function aiFeedbackHtml(data) {
    var labels = { hit:'已達到', partial:'部分達到', missed:'未達到', uncertain:'待核實' }, symbols={hit:'●',partial:'◐',missed:'○',uncertain:'？'};
    var points=data.points || [], scoring=points.filter(function(p){return p.scoring!==false;}), counts={hit:0,partial:0,missed:0,uncertain:0};
    scoring.forEach(function(p){counts[labels[p.status]?p.status:'uncertain']++;});
    var overview=scoring.length?'<div class="ai-point-overview"><div class="ai-coverage-dots" aria-label="給分要點核對結果">'+scoring.map(function(p){var state=labels[p.status]?p.status:'uncertain';return '<span class="ai-dot ai-dot-'+state+'" role="img" aria-label="'+esc(labels[state]+'：'+p.basis)+'">'+symbols[state]+'</span>';}).join('')+'</div><p><b>已達到 '+counts.hit+' 項</b> · 待補 '+counts.missed+' 項'+(counts.partial?' · 部分達到 '+counts.partial+' 項':'')+(counts.uncertain?' · 待核實 '+counts.uncertain+' 項':'')+'</p><p class="review-note">● 已達到　○ 未達到　◐ 部分達到　？待核實。核對項數不直接等於分數，替代答案及防錯提醒需按題意判斷。</p></div>':'';
    return overview+'<p>' + esc(data.summary) + '</p>' + (data.uncertainty ? '<p class="ai-uncertainty">判斷限制：' + esc(data.uncertainty) + '</p>' : '') +
      (data.materialNotes ? '<p class="ai-uncertainty">' + esc(data.materialNotes) + '</p>' : '') +
      points.map(function (p) { var state=labels[p.status]?p.status:'uncertain',warning=p.scoring===false;
        return '<details class="ai-point ai-point-'+state+(warning?' ai-point-warning':'')+'"'+(!warning && state!=='hit'?' open':'')+'><summary>'+
        '<span class="ai-point-symbol ai-dot-'+state+'" aria-hidden="true">'+(warning?'!':symbols[state])+'</span><span class="ai-point-basis">'+(warning?'防錯提醒（不計分）：':'')+esc(p.basis)+'</span><span class="ai-point-state">'+(warning?'查看核對':labels[state])+'</span></summary><div class="ai-point-detail">'+
        '<p><b>你的原答：</b>' + esc(p.evidence || '未找到對應表達') + '</p><p><b>判斷：</b>' + esc(p.reason) + '</p>'+(p.suggestion?'<p><b>補充方向：</b>' + esc(p.suggestion) + '</p>':'')+'</div></details>'; }).join('') +
      (data.reply ? '<p class="ai-reply">' + esc(data.reply) + '</p>' : '');
  }
  function aiPanelHtml(item, answer, canReview) {
    if(canReview===false)return '';
    return '<section class="ai-panel" data-ai-id="' + esc(item.id) + '" data-can-review="true"><h3>AI 作答分析</h3>' +
      '<p class="review-note">核對本次已提交的答案，逐點查看已達到與尚欠的內容。分析確認後另行保存。</p>' +
      '<details class="ai-submitted"><summary>核對本次提交原文</summary><label>已提交答案<textarea class="ai-answer" maxlength="6000" rows="3" readonly>' + esc(answer) + '</textarea></label></details>' +
      '<label class="ai-figure-choice" hidden><input class="ai-figures" type="checkbox"> 同時提供本題相關圖表</label>' +
      '<div class="ai-actions"><button class="btn btn-primary" data-ai-mode="review" type="button" disabled>分析本次答案</button></div><p class="ai-status" role="status">正在核對 AI 連線…</p>' +
      '<details class="ai-connection"><summary>連線檢查與用量</summary><p>每日最多 20 次分析，請求間隔至少 10 秒。測試服務每分鐘一次。</p>'+
      '<button class="btn btn-ghost ai-reconnect" type="button">重新檢查配置</button>' +
      '<button class="btn btn-ghost ai-probe" type="button">測試 AI 服務</button></details>' +
      '<div class="ai-pager" role="group" aria-label="AI 回覆翻頁" hidden>' +
      '<button class="btn btn-ghost ai-page-prev" type="button" aria-label="查看上一則 AI 回覆">‹ 上一則</button>' +
      '<span class="ai-page-label" aria-live="polite"></span>' +
      '<button class="btn btn-ghost ai-page-next" type="button" aria-label="查看下一則 AI 回覆">下一則 ›</button>' +
      '<small>未確認的回覆在目前登入頁面內保留，重新整理後清除。</small></div>' +
      '<div class="ai-feedback" aria-live="polite"></div><div class="ai-confirm" hidden><p>確認本次錯因標籤（可取消或補選）</p>' +
      AI_TAGS.map(function (tag) { return '<label><input type="checkbox" value="' + tag + '"> ' + tag + '</label>'; }).join('') +
      '<button class="btn btn-primary ai-save" type="button">確認並儲存分析</button></div>' +
      '<div class="ai-chat" hidden><label>繼續追問本題<input class="ai-question" type="text" maxlength="2000"></label>' +
      '<button class="btn btn-ghost" data-ai-mode="followup" type="button" disabled>送出追問</button></div></section>';
  }
  function aiError(code) {
    return { ai_not_configured:'AI 服務尚未配置，暫時不能取得真實輔評。', ai_empty_answer:'請先填寫文字答案，再請 AI 檢查。', ai_insufficient_basis:'本題尚未提供給分依據，無法可靠輔評。',
      ai_rate_limited:'已達暫時或今日用量限制，請稍後重試；每日最多 20 次。', ai_in_progress:'上一個 AI 請求仍在處理，請稍後再試。', ai_timeout:'AI 回應逾時，請重試。',
      ai_provider_busy:'AI 服務暫時繁忙，請稍後重試。', ai_invalid_evidence:'AI 回傳的引文未能對應答案，未予採用。請重試。', ai_invalid_response:'AI 回傳資料未能對應給分點，未予採用。請重試。',
      ai_auth_error:'AI 服務端密鑰無效或權限不足，需修正服務配置。', ai_balance_exhausted:'AI 帳戶餘額不足，暫時無法作答。',
      ai_request_rejected:'AI 服務拒絕了請求格式，需檢查模型與接口設定。', ai_network_error:'AI 上游網絡未能連接，草稿已保留。',
      ai_provider_error:'AI 上游服務發生錯誤，請稍後重試。', ai_probe_limited:'連線測試每分鐘可執行一次，請稍後再試。',
      ai_practice_disabled:'練習階段的 AI 已停用，請自行作答後提交批改。',
      ai_figure_unavailable:'相關圖表未能讀取，請重試或取消附圖。', not_connected:'登入已失效，請重新登入。' }[code] || 'AI 暫時未能完成，請按原按鈕重試。';
  }
  function bindAIPanels(root, items) {
    $all('.ai-panel', root).forEach(function (widget) {
      var item = items.filter(function (it) { return it.id === widget.dataset.aiId; })[0], auth = localStorage.getItem(LS_SYNC_SESSION);
      var status = $('.ai-status',widget), output = $('.ai-feedback',widget), pending = null, ready = false, busy = false;
      var submittedAnswer=$('.ai-answer',widget).value, history = aiReplyHistories[item.id];
      if (!history || history.auth !== auth || history.answer!==submittedAnswer) history = aiReplyHistories[item.id] = { auth:auth, answer:submittedAnswer, entries:[], index:-1, messages:[] };
      var viewIndex = history.index;
      function current() { return widget.isConnected && localStorage.getItem(LS_SYNC_SESSION) === auth; }
      function enable() {
        $all('[data-ai-mode]',widget).forEach(function (b) { b.disabled = !ready || busy || !submittedAnswer.trim(); });
        $('.ai-save',widget).disabled = !pending || busy;
        $('.ai-probe',widget).disabled = !ready || busy;
      }
      function showReply(index) {
        if (!current()) return;
        viewIndex = history.index = Math.max(0, Math.min(index, history.entries.length-1));
        var entry = history.entries[viewIndex];
        $('.ai-pager',widget).hidden = !entry;
        $('.ai-page-prev',widget).disabled = viewIndex <= 0;
        $('.ai-page-next',widget).disabled = viewIndex >= history.entries.length-1;
        pending = entry && entry.mode === 'review' && !entry.confirmedAt && widget.dataset.canReview !== 'false' ? entry : null;
        $('.ai-confirm',widget).hidden = !pending;
        $('.ai-chat',widget).hidden = !entry;
        if (entry) {
          var title = entry.mode === 'review' ? '逐點分析' : '批改後追問';
          $('.ai-page-label',widget).textContent = (viewIndex+1)+' / '+history.entries.length+' · '+title;
          output.innerHTML = '<p class="ai-reply-meta">'+esc(fmtDateTime(entry.generatedAt))+(entry.confirmedAt?' · 已確認儲存':'')+'</p>' +
            (entry.mode === 'review' ? '<details class="ai-reviewed-answer"><summary>這則輔評對應的本次答案</summary><p>'+esc(entry.answer)+'</p></details>' : '') +
            (entry.mode === 'followup' ? '<p><b>你的追問：</b>'+esc(entry.question)+'</p>' : '') + aiFeedbackHtml(entry.feedback);
          $all('.ai-confirm input',widget).forEach(function (cb) { cb.checked = entry.tags.indexOf(cb.value)>=0; });
        }
        enable();
      }
      $('.ai-page-prev',widget).addEventListener('click',function () { showReply(viewIndex-1); });
      $('.ai-page-next',widget).addEventListener('click',function () { showReply(viewIndex+1); });
      $all('.ai-confirm input',widget).forEach(function (cb) { cb.addEventListener('change',function () {
        if (current() && pending) pending.tags = $all('.ai-confirm input:checked',widget).map(function (c) { return c.value; });
      }); });
      function call(path, body) {
        if (!auth || !SYNC_API) return Promise.reject({code:'not_connected'});
        return syncFetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},cache:'no-store',body:body?JSON.stringify(body):undefined},function (response) {
          return response.json().catch(function(){throw Object.assign(new Error('Invalid service response'),{code:'ai_network_error',status:response.status});}).then(function (data) { if (!response.ok) throw Object.assign(new Error(aiError(data.error)),{code:data.error,status:response.status});return data; });
        });
      }
      function connect() {
        status.textContent='正在核對 AI 連線…';ready=false;enable();
        var check = aiStatusSnapshot && aiStatusSnapshot.auth===auth && aiStatusSnapshot.until>Date.now() ? aiStatusSnapshot.promise : call('/ai/status');
        aiStatusSnapshot={auth:auth,until:Date.now()+30000,promise:check};
        check.then(function (config) {
          if(!current())return;
          ready=config.configured===true;status.textContent=!submittedAnswer.trim()?'本題未提交文字答案，可自行核對參考解答。':ready?'AI 分析已配置，按上方按鈕核對本次答案。':'AI 分析暫時未配置，你仍可自行核對給分點。';
          $('.ai-figure-choice',widget).hidden=!(config.figuresEnabled && (item.figures || []).length);enable();
        }).catch(function (err) { if(current()){status.textContent=aiError(err.code);enable();} });
      }
      $('.ai-reconnect',widget).addEventListener('click',function () { aiStatusSnapshot=null;connect(); });
      $('.ai-probe',widget).addEventListener('click',function () {
        if(!ready || busy)return;busy=true;enable();status.textContent='正在發送合成測試，核實 AI 能否實際回覆…';
        call('/ai/probe',{}).then(function(data){if(current())status.textContent='AI 實測成功 · '+data.provider+' / '+data.model+' · '+(data.elapsedMs/1000).toFixed(1)+' 秒'+(data.failover?' · 已使用備用接口':'');})
          .catch(function(err){if(current())status.textContent=aiError(err.code);}).finally(function(){busy=false;if(current())enable();});
      });
      $all('[data-ai-mode]',widget).forEach(function (button) { button.addEventListener('click',function () {
        if(!ready || busy)return;
        var mode=button.dataset.aiMode, answer=submittedAnswer, question=$('.ai-question',widget).value;
        if(mode==='review' && !answer.trim()){status.textContent=aiError('ai_empty_answer');return;}
        if(mode==='followup' && !question.trim()){status.textContent='請輸入關於本題的問題。';return;}
        busy=true;enable();status.textContent='AI 正在核對本題資料…';
        call('/ai/review',{questionId:item.id,answer:answer,mode:mode,question:question,messages:history.messages.slice(-6),includeFigures:$('.ai-figures',widget).checked}).then(function (data) {
          if(!current())return;
          if(data.questionId!==item.id || !Array.isArray(data.points))throw {code:'ai_invalid_response'};
          status.textContent='AI 已回覆 · '+data.provider+' / '+data.model+(data.failover?' · 已自動使用備用接口':'')+'。請核對判斷限制。';
          history.entries.push({questionId:item.id,answer:answer,feedback:data,tags:(data.tags||[]).slice(),generatedAt:data.generatedAt,
            mode:mode,question:question});
          if(mode==='followup') $('.ai-question',widget).value='';
          history.messages.push({role:'user',content:(mode==='followup'?question:'請逐點核對本次已提交答案').slice(0,3000)},{role:'assistant',content:JSON.stringify(data).slice(0,3000)});
          history.messages=history.messages.slice(-6);
          showReply(history.entries.length-1);
        }).catch(function (err) { if(current()){status.textContent=aiError(err.code);if(err.status===401)expireConnection(err,auth);} }).finally(function () {busy=false;if(current())enable();});
      }); });
      $('.ai-save',widget).addEventListener('click',function () {
        if(!current() || !pending || busy)return;
        if(pending.confirmedAt){showReply(viewIndex);return;}
        if($('.ai-answer',widget).value!==pending.answer){status.textContent='答案已更改，請重新檢查後再儲存。';return;}
        var at=Date.now(), id='ai-'+at+'-'+Math.random().toString(36).slice(2);
        aiReviews[id]=Object.assign({},pending,{confirmedAt:at,tags:$all('.ai-confirm input:checked',widget).map(function (cb) { return cb.value; })});
        pending.confirmedAt=at;pending=null;showReply(viewIndex);save();status.textContent='已獨立儲存輔評與你確認的標籤 · '+fmtDateTime(at)+'。原卷成績及練習次數不變。';
      });
      if(history.entries.length) showReply(history.index);
      connect();
    });
  }
  function checkText(text) {
    var warn = /^✗/.test(text);
    var body = warn ? text.slice(1).trim() : text;
    var html = '';
    body.split(/「([^」]+)」/).forEach(function (p, i) {
      html += (i % 2 === 1) ? '<b class="kw">' + esc(p) + '</b>' : esc(p);
    });
    return (warn ? '<span class="chk-warn"><span class="persona-icon persona-icon-warning" aria-hidden="true"></span> 防錯：</span>' : '') + html;
  }
  function answerBlocks(it, withMine, draftHtml) {
    var h = '';
    if (withMine && it.my && it.my.length) {
      h += '<div class="ans-block ans-mine"><div class="ans-title"><span class="persona-icon persona-icon-papers" aria-hidden="true"></span> 你當年嘅答案</div><div class="ans-body">' +
        it.my.map(function (s) {
          return s[1] ? '<span class="bad-seg">' + esc(s[0]) + '</span>' : esc(s[0]);
        }).join('<br>') + '</div></div>';
    }
    if (it.kind === 'mc') {
      h += '<div class="ans-block ans-mine"><div class="ans-title"><span class="persona-icon persona-icon-papers" aria-hidden="true"></span> 當年你揀</div>' +
        '<div class="ans-body">' + esc(it.option || '—') + '</div></div>';
    }
    h += '<div class="ans-block ans-deduct"><div class="ans-title"><span class="persona-icon persona-icon-warning" aria-hidden="true"></span> 錯因分析</div>' +
      '<div class="ans-body">' + esc(it.deduct || '—') + '</div></div>';
    h += '<div class="ans-block ans-correct"><div class="ans-title"><span class="persona-icon persona-icon-success" aria-hidden="true"></span> 正解詳解</div>' +
      '<div class="ans-body">' + esc(it.kind === 'mc' ? (it.correctOpt || '—') : (it.correct || '—')) + '</div></div>';
    if (it.points) {
      h += '<div class="ans-block ans-points"><div class="ans-title"><span class="persona-icon persona-icon-notes" aria-hidden="true"></span> 評分備註</div>' +
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
    if (PRIVATE_BANK && !bankLoaded) return '<div class="panel cycle-report"><h2 class="panel-h"><span class="persona-icon persona-icon-records" aria-hidden="true"></span> 雙週復習報告</h2>' +
      '<p class="review-note">登入並載入私人題庫後，即可查看本期與往期報告。</p></div>';
    var now = Date.now(), current = cycleStartOf(now), periods = reportPeriodStarts(now);
    if (selectedReportCycle == null || periods.indexOf(selectedReportCycle) < 0) selectedReportCycle = current;
    var start = selectedReportCycle, report = buildCycleReport(start, now);
    var pct = report.total ? Math.round(report.correct / report.total * 1000) / 10 : 0;
    var pctText = String(pct).replace(/\.0$/, '');
    var label = start === current ? '本期' : '該期';
    return '<div class="panel cycle-report"><div class="panel-h-row"><div><h2 class="panel-h"><span class="persona-icon persona-icon-records" aria-hidden="true"></span> 雙週復習報告</h2>' +
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
      '<div class="cycle-report-lists"><div><h3><span class="persona-icon persona-icon-success" aria-hidden="true"></span> ' + label + '首次解決（' + report.newSolved.length + '）</h3>' +
        reportRowsHtml(report.newSolved, '還沒有首次解決的題目。', false) + '</div>' +
        '<div><h3>↩️ ' + label + '答對後再錯（' + report.regressed.length + '）</h3>' +
        reportRowsHtml(report.regressed, '目前沒有答對後再錯的題目。', true) + '</div></div></div>';
  }
  function sessionTimelineHtml() {
    var rows = allSessions().filter(function (s) { return s && Number.isFinite(s.t) && s.t <= Date.now() && s.results; })
      .slice().sort(function (a, b) { return b.t - a.t; });
    // Replayed cloud copies of one submission appear only once.
    var seen = new Set();
    rows = rows.filter(function (s) {
      var key = JSON.stringify([s.t, s.subj, s.topic]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    return '<div class="panel"><div class="panel-h-row"><h2 class="panel-h">練習時間線</h2>' +
      '<label>顯示 <select id="historyScope"><option value="all">全部記錄</option><option value="cycle">本雙周</option></select></label></div>' +
      '<p class="history-summary">按提交時間排列 · 北京時間 · 本次正確題數與原卷成績分開記錄。最多顯示最近 30 次。</p>' +
      '<div class="session-history">' + (rows.slice(0, 30).map(function (s) {
        var ids = Object.keys(s.results), correct = ids.filter(function (id) { return window.DSELibrary.full(s.results[id]); }).length;
        var meta = SUBJECT_META[s.subj], name = meta ? meta.name : '未分類';
        return '<details class="session-entry" data-in-cycle="' + (s.t >= cycleStartOf(Date.now())) + '"><summary>' +
          '<time>' + esc(fmtDateTime(s.t)) + '</time><span class="session-entry-title">' + esc(name + ' · ' +
          (s.topic === '__random__' ? '隨機十題' : s.topic === '__today__' ? '今日複習' : s.topic + ' ' + topicName(s.subj, s.topic))) +
          '<small>已提交' + (s.mcOnly ? ' · 只做選擇題' : '') + ' · 展開詳情</small></span>' +
          '<span class="session-entry-score">' + correct + ' / ' + ids.length + '</span></summary>' +
          '<div class="session-entry-body">本次全對 ' + correct + ' 題；尚未全對 ' + (ids.length - correct) + ' 題。' +
          ids.map(function (id) {
            var result = s.results[id], attempt = result.attempt;
            if (!attempt || attempt.version !== 1) return '';
            return '<details class="attempt-snapshot"><summary>' + esc(id) + ' · ' + esc(result.marks + '/' + result.tot) +
              (attempt.assisted ? ' · 曾使用輔助' : '') + '</summary><p>本次提交原文</p><div class="ans-body">' +
              esc(attempt.answer).replace(/\n/g, '<br>') + (attempt.onPaper ? '<p>另有紙上作答；未保存影像，不新增獨立掌握證據。</p>' : '') +
              '</div><p>已勾核對項：' + esc((Array.isArray(attempt.checkedIndices) ? attempt.checkedIndices : []).map(function (i) { return i + 1; }).join('、') || '無') +
              ' · ' + (attempt.scoreMethod === 'manual' ? '人工確認自評' : attempt.scoreMethod === 'reviewed-rubric' ? '已核實給分規則' : '選項核對') +
              '</p></details>';
          }).join('') +
          '<div><a href="#/library/books/' + esc(s.subj) + '">查看錯題歸納</a>' +
          '<a href="#/session/' + esc(s.subj) + '/' + encodeURIComponent(s.topic) + '">再練一次</a></div></div></details>';
      }).join('') || '<p class="review-note">尚未有已提交的練習；閱讀和草稿不計作答。</p>') + '</div>' +
      '<p id="historyEmpty" class="review-note" hidden>本雙周尚未有已提交的練習。</p></div>';
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
        '<header class="page-head"><div><h1 class="page-title"><span class="persona-icon persona-icon-records" aria-hidden="true"></span> 做題記錄</h1>' +
        '<p class="page-sub">每完成一次課題練習就留一個印；滑鼠移上去睇詳情。</p></div>' +
          '<div class="record-tools"><button class="btn btn-ghost" id="exportDataBtn" type="button">⬇️ 匯出記錄</button>' +
          '<button class="btn btn-ghost" id="importDataBtn" type="button">⬆️ 匯入備份</button>' +
          '<input id="importDataFile" type="file" accept="application/json,.json" hidden></div>' +
          '<a class="btn btn-ghost" href="#/">← 主頁</a></header>' +

        '<div class="panel sync-panel"><div class="panel-h-row"><h2 class="panel-h"><span class="persona-icon persona-icon-sync" aria-hidden="true"></span> ' + (PASSWORD_AUTH ? '做題記錄自動同步' : 'GitHub 私有仓库自动同步') + '</h2>' +
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
          statCard('<span class="persona-icon persona-icon-practice" aria-hidden="true"></span>', '累計作答', totalDone + ' 題') +
          statCard('<span class="persona-icon persona-icon-home" aria-hidden="true"></span>', '練習次數', sessions.length + ' 次') +
          statCard('<span class="persona-icon persona-icon-random" aria-hidden="true"></span>', '上次仍錯', wrongRows.length + ' 題', wrongRows.length ? 'c-red' : 'c-green') +
        '</div>' +

        sessionTimelineHtml() +
        cycleReportHtml() +

        '<div class="panel"><h2 class="panel-h">刷題活躍圖（近 6 個月，按答題數）</h2><div id="heat"></div>' +
        '<div class="heat-legend">少 <span class="lv lv0"></span><span class="lv lv1"></span>' +
        '<span class="lv lv2"></span><span class="lv lv3"></span><span class="lv lv4"></span> 多（佔題庫比例）</div></div>' +

        '<div class="panel"><div class="panel-h-row"><h2 class="panel-h">⏰ 間隔複習（到期優先）</h2></div>' +
          '<p class="review-note">答對後依次隔 15、21、30、45、60 日重練；未滿分亦至少隔 15 日再試。複習進度會跨雙週保留。</p>' +
          '<div class="wrong-list" id="reviewDueList"></div></div>' +

        '<div class="panel"><div class="panel-h-row"><h2 class="panel-h"><span class="persona-icon persona-icon-sync" aria-hidden="true"></span> 錯題複習狀態（仍錯在上、已通過嘅沉底）</h2>' +
          '<div class="filter-seg" id="wrongFilter">' +
            ['ALL'].concat(SUBJECT_ORDER).map(function (c) {
              var lbl = c === 'ALL' ? '全部' : SUBJECT_META[c].name;
              return '<button class="seg' + (c === 'ALL' ? ' on' : '') + '" data-f="' + c + '" type="button">' + lbl + '</button>';
            }).join('') +
          '</div></div>' +
          '<div class="wrong-list" id="wrongList"></div>' +
        '</div>' +
      '</section>';

    $('#historyScope').addEventListener('change', function (event) {
      var visible = 0;
      $all('.session-entry').forEach(function (row) {
        row.hidden = event.target.value === 'cycle' && row.getAttribute('data-in-cycle') !== 'true';
        if (!row.hidden) visible++;
      });
      $('#historyEmpty').hidden = visible > 0;
    });
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
      aiReviews = data.aiReviews || {};
      localStorage.setItem(LS_SESS, JSON.stringify(sessions));
      localStorage.setItem(LS_ARCHIVE, JSON.stringify(archive));
      localStorage.setItem(LS_DRAFT, JSON.stringify(drafts));
      localStorage.setItem(LS_REVIEW, JSON.stringify(reviewPlan));
      localStorage.setItem(LS_AI, JSON.stringify(aiReviews));
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
      '<div class="heat-tip" id="heatTip" hidden></div>' +
      '<details class="text-activity"><summary>查看文字活動記錄（北京時間）</summary><ul>' +
      Object.keys(byDay).map(Number).filter(function (d) { return d >= start && d <= today; }).sort(function (a, b) { return b - a; }).map(function (d) {
        var date = new Date(d * DAY_MS);
        return '<li>' + date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) +
          '：作答 ' + byDay[d].q + ' 題，' + byDay[d].n + ' 次練習。</li>';
      }).join('') + (Object.keys(byDay).some(function (d) { return Number(d) >= start && Number(d) <= today; }) ? '' : '<li>近六個月尚未有已提交的練習。</li>') + '</ul></details>';
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
      el.innerHTML = '<div class="empty-ok"><span class="persona-icon persona-icon-success" aria-hidden="true"></span> 暫時沒有到期複習；新作答會自動排入複習。</div>';
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
      el.innerHTML = '<div class="empty-ok"><span class="persona-icon persona-icon-celebrate" aria-hidden="true"></span> 呢科嘅錯題全部征服咗！</div>';
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
      group('<span class="persona-icon persona-icon-warning" aria-hidden="true"></span> 待處理', due, 'due', null) +
      group('<span class="persona-icon persona-icon-passed" aria-hidden="true"></span> 已答對（再刷可鞏固）', passOnce, 'once', null) +
      group('<span class="persona-icon persona-icon-success" aria-hidden="true"></span> 反複測試通過', passStrong, 'strong', null);
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
        localStorage.removeItem(LS_AI); localStorage.removeItem(LS_TODAY);
        aiReviews = {}; todaySelection = null;
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
    setTimeout(function () { toast('新嘅雙週開始，進度已重置！'); }, 300);
  }
  route();
  initSync(startupHash);
})();


