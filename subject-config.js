/* Shared account subject profiles. Contains no private questions or records. */
(function (global) {
  'use strict';
  var names = Object.freeze({ chem: '化學', bio: '生物', math: '數學', m2: '數學延伸 2（M2）', physics: '物理' });
  var profiles = Object.freeze({ kyle: Object.freeze(['chem', 'bio', 'math']), yeelam: Object.freeze(['math', 'm2', 'physics']) });
  function codes(account) { return (profiles[account] || []).slice(); }
  function emptySubject(code) { return { name: names[code], topics: [], items: [] }; }
  function emptyBank(account) {
    return { subjects: Object.fromEntries(codes(account).map(function (code) { return [code, emptySubject(code)]; })) };
  }
  function bankFor(account, bank) {
    if (!bank || !bank.subjects || typeof bank.subjects !== 'object') return bank;
    var subjects = {};
    codes(account).forEach(function (code) {
      if (Object.prototype.hasOwnProperty.call(bank.subjects, code)) subjects[code] = bank.subjects[code];
      else if (['math', 'm2', 'physics'].indexOf(code) >= 0) subjects[code] = emptySubject(code);
    });
    return Object.assign({}, bank, { subjects: subjects });
  }
  function icon(code) {
    if (code === 'm2') return '<span class="subject-symbol" aria-hidden="true">∑</span>';
    if (code === 'physics') return '<svg class="subject-symbol" width="1.2em" height="1.2em" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></g><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>';
    return '<span class="persona-icon persona-icon-' + code + '" aria-hidden="true"></span>';
  }
  global.DSESubjects = Object.freeze({ names: names, codes: codes, icon: icon, emptyBank: emptyBank, bankFor: bankFor,
    allows: function (account, code) { return codes(account).indexOf(code) >= 0; },
    libraryOrder: function (subjects) { return ['bio', 'chem', 'math', 'm2', 'physics'].filter(function (code) { return subjects[code]; }); } });
})(typeof window === 'undefined' ? globalThis : window);
