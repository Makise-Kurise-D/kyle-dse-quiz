(function () {
  'use strict';
  // Page shells stay in the document; only nearby full-size images stay decoded.
  window.DSEPaperReader = function (options) {
    var root = options.root, scroll = options.scrollRoot, thumbs = options.thumbs;
    var manifest = options.manifest, current = options.page || 1, stopped = false;
    var rows = [], queue = [], active = 0, frame = null, atlasUrl = null, warmTimer;
    var atlas = manifest.thumbnails, sections = manifest.sections || [], resizeObserver;
    var lastWidth = root.clientWidth, anchorFraction = 0;
    function measureToolbar() {
      if (options.toolbar.getBoundingClientRect) options.toolbar.parentElement.style.setProperty('--paper-toolbar-height', options.toolbar.getBoundingClientRect().height + 'px');
    }
    function label(page) {
      var section = sections.filter(function (s) { return s.page <= page; }).pop();
      return '第 ' + page + ' 頁' + (section ? ' · ' + section.label : '');
    }
    function escape(value) { return String(value).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
    root.innerHTML = Array.from({ length: manifest.pages }, function (_, index) {
      var n = index + 1, size = manifest.page_sizes && manifest.page_sizes[index];
      var ratio = size ? size[0] / size[1] : 1 / Math.sqrt(2);
      return '<figure class="paper-sheet" id="paperSheet-' + n + '" aria-label="' + escape(label(n)) + '">' +
        '<figcaption>' + escape(label(n)) + '</figcaption><div class="paper-sheet-body" style="aspect-ratio:' + ratio + '">' +
        '<span class="paper-placeholder" id="paperPlaceholder-' + n + '">第 ' + n + ' 頁</span>' +
        '<img id="paperImage-' + n + '" alt="' + escape(options.title + ' ' + label(n)) + '" decoding="async" hidden>' +
        '<button type="button" class="paper-page-retry" id="paperRetry-' + n + '" hidden>載入失敗，點此重試</button></div></figure>';
    }).join('');
    thumbs.innerHTML = Array.from({ length: manifest.pages }, function (_, index) {
      return '<button class="paper-thumb" type="button" id="paperThumb-' + (index + 1) + '" data-page="' + (index + 1) +
        '" aria-label="' + escape(label(index + 1)) + '"><span class="paper-thumb-preview" id="paperPreview-' + (index + 1) +
        '" aria-hidden="true"></span><span>' + (index + 1) + '</span></button>';
    }).join('');
    for (var n = 1; n <= manifest.pages; n++) {
      var row = { page: n, state: 'idle', url: null, sheet: root.querySelector('#paperSheet-' + n),
        image: root.querySelector('#paperImage-' + n), placeholder: root.querySelector('#paperPlaceholder-' + n),
        retry: root.querySelector('#paperRetry-' + n), thumb: thumbs.querySelector('#paperThumb-' + n),
        preview: thumbs.querySelector('#paperPreview-' + n) };
      (function (r) {
        r.retry.addEventListener('click', function () { r.state = 'idle'; ensure(r.page, true); });
        r.thumb.addEventListener('click', function () { go(r.page); if (options.onNavigate) options.onNavigate(); });
        r.thumb.addEventListener('keydown', function (event) {
          var target = event.key === 'ArrowDown' ? r.page + 1 : event.key === 'ArrowUp' ? r.page - 1 :
            event.key === 'Home' ? 1 : event.key === 'End' ? manifest.pages : 0;
          if (target >= 1 && target <= manifest.pages) { event.preventDefault(); go(target); rows[target - 1].thumb.focus(); }
        });
      })(row);
      rows.push(row);
    }
    function notify() {
      rows.forEach(function (r) { r.thumb.setAttribute('aria-current', r.page === current ? 'page' : 'false'); r.thumb.tabIndex = r.page === current ? 0 : -1; });
      var thumb = rows[current - 1].thumb;
      if (thumb.getBoundingClientRect && thumbs.getBoundingClientRect) {
        var t = thumb.getBoundingClientRect(), area = thumbs.getBoundingClientRect();
        if (t.top < area.top || t.bottom > area.bottom) thumbs.scrollTop += t.top - area.top - (area.height - t.height) / 2;
      }
      options.onPage(current, rows[current - 1].url);
    }
    function evict() {
      rows.forEach(function (r) {
        if (r.url && Math.abs(r.page - current) > 3) {
          r.image.onload = r.image.onerror = null;
          r.image.hidden = true; r.image.removeAttribute('src');
          if (!atlas) r.preview.style.backgroundImage = '';
          URL.revokeObjectURL(r.url); r.url = null; r.state = 'idle'; r.placeholder.hidden = false;
        }
      });
    }
    function ensure(page, priority) {
      var r = rows[page - 1];
      if (!r || stopped || r.state !== 'idle') return;
      r.state = 'queued';
      if (priority) queue.unshift(r); else queue.push(r);
      pump();
    }
    function pump() {
      if (stopped) return;
      while (active < 2 && queue.length) {
        var r = queue.shift();
        if (Math.abs(r.page - current) > 3) { r.state = 'idle'; continue; }
        active++; r.state = 'loading'; r.retry.hidden = true;
        r.placeholder.textContent = '正在載入第 ' + r.page + ' 頁…';
        (function (row) {
          options.loadPage(row.page).then(function (blob) {
            if (stopped) return;
            if (Math.abs(row.page - current) > 3) { row.state = 'idle'; return; }
            row.url = URL.createObjectURL(blob);
            var assignedUrl = row.url;
            row.image.onload = function () {
              if (!stopped && row.url === assignedUrl) { row.placeholder.hidden = true; row.image.hidden = false; }
            };
            row.image.onerror = function () { if (!stopped && row.url === assignedUrl) fail(row, new Error('頁面圖片未能顯示')); };
            row.image.hidden = true; row.image.src = row.url; row.state = 'ready';
            if (!atlas) row.preview.style.backgroundImage = 'url("' + row.url + '")';
            if (row.page === current) options.onPage(current, row.url);
            evict();
          }).catch(function (error) { if (!stopped) fail(row, error); }).finally(function () { active--; pump(); });
        })(r);
      }
    }
    function fail(row, error) {
      if (row.url) { URL.revokeObjectURL(row.url); row.url = null; }
      row.image.hidden = true; row.image.removeAttribute('src'); row.state = 'error'; row.retry.hidden = false;
      row.placeholder.hidden = true;
      if (row.page === current) { options.onPage(current, null); options.onError(error); }
    }
    function nearby() { ensure(current, true); ensure(current + 1); ensure(current - 1); evict(); }
    function track() {
      frame = null;
      if (stopped || !root.getBoundingClientRect) return;
      var area = scroll.getBoundingClientRect(), toolbar = options.toolbar.getBoundingClientRect();
      var top = Math.max(area.top, toolbar.bottom) + 24;
      var next = current;
      for (var i = 0; i < rows.length; i++) {
        var box = rows[i].sheet.getBoundingClientRect();
        if (box.top <= top) next = i + 1;
        else break;
      }
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) next = manifest.pages;
      if (next !== current) { current = next; notify(); }
      var currentBox = rows[current - 1].sheet.getBoundingClientRect();
      anchorFraction = Math.max(0, Math.min(0.99, (top - currentBox.top) / currentBox.height));
      nearby();
    }
    function schedule() {
      if (stopped || frame !== null) return;
      frame = window.requestAnimationFrame ? window.requestAnimationFrame(track) : setTimeout(track, 16);
    }
    function go(page) {
      if (stopped || !Number.isInteger(page) || page < 1 || page > manifest.pages) return;
      current = page; anchorFraction = 0; notify();
      if (rows[page - 1].sheet.getBoundingClientRect) {
        var targetTop = scroll.getBoundingClientRect().top + options.toolbar.getBoundingClientRect().height + 16;
        var delta = rows[page - 1].sheet.getBoundingClientRect().top - targetTop;
        scroll.scrollTop += delta;
      }
      nearby();
    }
    scroll.addEventListener('scroll', schedule, { passive: true });
    function resize() {
      measureToolbar();
      var width = root.clientWidth;
      if (lastWidth && width !== lastWidth && root.getBoundingClientRect) {
        var box = rows[current - 1].sheet.getBoundingClientRect();
        var top = scroll.getBoundingClientRect().top + options.toolbar.getBoundingClientRect().height + 24;
        scroll.scrollTop += box.top + anchorFraction * box.height - top;
      }
      lastWidth = width; schedule();
    }
    window.addEventListener('resize', resize);
    measureToolbar();
    if (window.ResizeObserver) { resizeObserver = new window.ResizeObserver(resize); resizeObserver.observe(options.toolbar); resizeObserver.observe(root); }
    notify(); ensure(current, true);
    warmTimer = setTimeout(function () { if (!stopped) { if (current > 1) go(current); else nearby(); } }, 200);
    if (atlas && options.loadThumbnails) {
      options.loadThumbnails().then(function (blob) {
        if (stopped) return;
        atlasUrl = URL.createObjectURL(blob);
        rows.forEach(function (r, index) {
          var x = index % atlas.columns, y = Math.floor(index / atlas.columns);
          r.preview.style.backgroundImage = 'url("' + atlasUrl + '")';
          r.preview.style.backgroundSize = (atlas.columns * 100) + '% ' + (atlas.rows * 100) + '%';
          r.preview.style.backgroundPosition = (atlas.columns === 1 ? 0 : x / (atlas.columns - 1) * 100) + '% ' +
            (atlas.rows === 1 ? 0 : y / (atlas.rows - 1) * 100) + '%';
        });
      }).catch(function () { if (!stopped && options.onThumbnailError) options.onThumbnailError(); });
    }
    return { go: go, layoutChange: function (change) { change(); resize(); }, destroy: function () {
      stopped = true; clearTimeout(warmTimer); queue = [];
      scroll.removeEventListener('scroll', schedule); window.removeEventListener('resize', resize);
      if (resizeObserver) resizeObserver.disconnect();
      if (frame !== null) { if (window.cancelAnimationFrame) window.cancelAnimationFrame(frame); else clearTimeout(frame); }
      rows.forEach(function (r) { r.image.onload = r.image.onerror = null; if (r.url) URL.revokeObjectURL(r.url); r.image.removeAttribute('src'); r.preview.style.backgroundImage = ''; });
      if (atlasUrl) URL.revokeObjectURL(atlasUrl);
    } };
  };
})();
