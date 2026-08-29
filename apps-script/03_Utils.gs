/**
 * ============================================================================
 * 03_Utils.gs — spreadsheet access, batch I/O, logging, hashing, dates,
 *               and the master-data normaliser (Masters).
 * ============================================================================
 * Performance rules honoured here:
 *   - one getValues() per sheet per pass (never cell-by-cell)
 *   - one setValues() per write batch (never row-by-row appends in a loop)
 *   - header positions cached per execution
 * ============================================================================
 */

var __SS = null;
var __HEADER_CACHE = {};
var __RUN_ID = null;
var __LOG_BUFFER = [];

function openSpreadsheet_() {
  if (__SS) return __SS;
  const id = (typeof __CONFIG_CACHE === 'object' && __CONFIG_CACHE && __CONFIG_CACHE.SPREADSHEET_ID)
    ? __CONFIG_CACHE.SPREADSHEET_ID : DEFAULT_CONFIG.SPREADSHEET_ID;
  __SS = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!__SS) throw new Error('No spreadsheet. Bind the script to a Sheet or set CONFIG.SPREADSHEET_ID.');
  return __SS;
}

function runId() {
  if (!__RUN_ID) {
    __RUN_ID = 'RUN-' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd-HHmmss') +
               '-' + Math.floor(Math.random() * 1000);
  }
  return __RUN_ID;
}

function tz_() {
  try { return getConfig().TIMEZONE || Session.getScriptTimeZone(); }
  catch (e) { return Session.getScriptTimeZone(); }
}

/** Returns the sheet, creating it from SCHEMA if missing. */
function sheet_(name) {
  const ss = openSpreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = createSheetFromSchema_(name);
  return sh;
}

function createSheetFromSchema_(name) {
  const ss = openSpreadsheet_();
  const def = SCHEMA[name];
  if (!def) throw new Error('Unknown sheet in schema: ' + name);
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(def.freeze || 1);
  if (sh.getMaxColumns() > def.headers.length) {
    sh.deleteColumns(def.headers.length + 1, sh.getMaxColumns() - def.headers.length);
  }
  applyFormats_(sh, name);
  return sh;
}

function applyFormats_(sh, name) {
  const def = SCHEMA[name];
  if (!def || !def.formats) return;
  const maxRows = Math.max(sh.getMaxRows() - 1, 1);
  Object.keys(def.formats).forEach(function (field) {
    const c = def.headers.indexOf(field) + 1;
    if (c > 0) sh.getRange(2, c, maxRows, 1).setNumberFormat(def.formats[field]);
  });
}

/** 0-based column index of a field within a sheet's schema. */
function col(sheetName, field) {
  const key = sheetName + '::' + field;
  if (key in __HEADER_CACHE) return __HEADER_CACHE[key];
  const def = SCHEMA[sheetName];
  if (!def) throw new Error('Unknown sheet: ' + sheetName);
  const i = def.headers.indexOf(field);
  if (i < 0) throw new Error('Unknown field "' + field + '" on sheet "' + sheetName + '"');
  __HEADER_CACHE[key] = i;
  return i;
}

/** Reads all data rows of a sheet as a 2-D array (no header row). One API call. */
function readAll_(sheetName) {
  const sh = sheet_(sheetName);
  const lastRow = sh.getLastRow();
  const width = SCHEMA[sheetName].headers.length;
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, width).getValues();
}

/** Reads all rows as objects keyed by header name. Convenience, still 1 call. */
function readObjects_(sheetName) {
  const headers = SCHEMA[sheetName].headers;
  return readAll_(sheetName).map(function (r) {
    const o = {};
    for (var i = 0; i < headers.length; i++) o[headers[i]] = r[i];
    return o;
  });
}

/** Appends many rows in ONE setValues call. rows = array of arrays. */
function appendRows_(sheetName, rows) {
  if (!rows || !rows.length) return 0;
  const sh = sheet_(sheetName);
  const width = SCHEMA[sheetName].headers.length;
  const norm = rows.map(function (r) {
    const out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
  const start = sh.getLastRow() + 1;
  if (sh.getMaxRows() < start + norm.length) {
    sh.insertRowsAfter(sh.getMaxRows(), start + norm.length - sh.getMaxRows());
  }
  sh.getRange(start, 1, norm.length, width).setValues(norm);
  return norm.length;
}

/** Replaces the whole body of a sheet (headers kept) in one write. */
function replaceAll_(sheetName, rows) {
  const sh = sheet_(sheetName);
  const width = SCHEMA[sheetName].headers.length;
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  if (rows && rows.length) {
    const norm = rows.map(function (r) {
      const out = r.slice(0, width);
      while (out.length < width) out.push('');
      return out;
    });
    if (sh.getMaxRows() < norm.length + 1) {
      sh.insertRowsAfter(sh.getMaxRows(), norm.length + 1 - sh.getMaxRows());
    }
    sh.getRange(2, 1, norm.length, width).setValues(norm);
  }
  applyFormats_(sh, sheetName);
  return rows ? rows.length : 0;
}

/** Writes one column of an existing range in a single call. */
function writeColumn_(sheetName, field, values) {
  if (!values.length) return;
  const sh = sheet_(sheetName);
  const c = col(sheetName, field) + 1;
  sh.getRange(2, c, values.length, 1).setValues(values.map(function (v) { return [v]; }));
}

/* ---------------------------------------------------------------------------
 * Logging
 * ------------------------------------------------------------------------- */

const LOG_LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function logEvent(level, component, action, status, message, opts) {
  opts = opts || {};
  const cfgLevel = LOG_LEVELS[(safeConfig_('LOG_LEVEL') || 'INFO')] || 20;
  if ((LOG_LEVELS[level] || 20) < cfgLevel) return;
  __LOG_BUFFER.push([
    new Date(), runId(), level, component, action, status,
    truncate_(String(message == null ? '' : message), 900),
    opts.emailId || '', opts.reportId || '',
    truncate_(typeof opts.details === 'string' ? opts.details
      : (opts.details ? JSON.stringify(opts.details) : ''), 4000)
  ]);
  if (__LOG_BUFFER.length >= 200) flushLog();
  if (level === 'ERROR') console.error(component + '/' + action + ': ' + message);
}

function logInfo(c, a, m, o)  { logEvent('INFO',  c, a, 'OK',    m, o); }
function logWarn(c, a, m, o)  { logEvent('WARN',  c, a, 'WARN',  m, o); }
function logError(c, a, m, o) { logEvent('ERROR', c, a, 'ERROR', m, o); }
function logDebug(c, a, m, o) { logEvent('DEBUG', c, a, 'OK',    m, o); }

/** Must be called at the end of every entry point. Writes the buffer once. */
function flushLog() {
  if (!__LOG_BUFFER.length) return;
  const buf = __LOG_BUFFER;
  __LOG_BUFFER = [];
  try {
    appendRows_(SHEETS.LOG, buf);
    trimLog_();
  } catch (e) {
    console.error('Log flush failed: ' + e);
  }
}

function trimLog_() {
  const max = safeConfig_('LOG_MAX_ROWS') || 20000;
  const sh = sheet_(SHEETS.LOG);
  const rows = sh.getLastRow() - 1;
  if (rows > max) sh.deleteRows(2, rows - max);
}

function safeConfig_(key) {
  try { return getConfig()[key]; } catch (e) { return DEFAULT_CONFIG[key]; }
}

/* ---------------------------------------------------------------------------
 * Hashing / ids
 * ------------------------------------------------------------------------- */

function sha1Hex_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, s, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function shortHash_(s, len) { return sha1Hex_(s).substring(0, len || 12); }

/* ---------------------------------------------------------------------------
 * Strings
 * ------------------------------------------------------------------------- */

function truncate_(s, n) { return s && s.length > n ? s.substring(0, n - 3) + '...' : s; }

function cleanWhitespace_(s) {
  return String(s == null ? '' : s)
    .replace(/ /g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeEntities_(s) {
  if (!s) return '';
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'").replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '...')
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
}

/* ---------------------------------------------------------------------------
 * Dates
 * ------------------------------------------------------------------------- */

const MONTHS_ = { jan:0, january:0, feb:1, february:1, mar:2, march:2, apr:3, april:3,
  may:4, jun:5, june:5, jul:6, july:6, aug:7, august:7, sep:8, sept:8, september:8,
  oct:9, october:9, nov:10, november:10, dec:11, december:11 };

/**
 * Tolerant date parser. Returns a Date at local midnight, or null.
 * Supported: Date objects, yyyy-mm-dd, dd/mm/yyyy (or mm/dd per DATE_ORDER),
 * dd-mm-yyyy, "29 Aug 2026", "Aug 29, 2026", "29 August 2026", "29.08.2026",
 * two-digit years, and ISO timestamps.
 */
function parseDate_(v, dateOrder) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : atMidnight_(v);
  }
  if (typeof v === 'number') {
    // Sheets serial date
    if (v > 20000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return atMidnight_(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
    return null;
  }
  var s = cleanWhitespace_(String(v)).replace(/^[\[(]|[\])]$/g, '');
  if (!s) return null;
  s = s.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');

  var m;
  // ISO / yyyy-mm-dd (optionally with time)
  m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T ].*)?$/);
  if (m) return mkDate_(+m[1], +m[2] - 1, +m[3]);

  // 29 Aug 2026 / 29 August 26
  m = s.match(/^(\d{1,2})[\s\-\/.]+([A-Za-z]{3,9})[\s\-\/.,]+(\d{2,4})$/);
  if (m && MONTHS_[m[2].toLowerCase()] !== undefined) {
    return mkDate_(fixYear_(+m[3]), MONTHS_[m[2].toLowerCase()], +m[1]);
  }
  // Aug 29, 2026
  m = s.match(/^([A-Za-z]{3,9})[\s\-\/.]+(\d{1,2})[\s\-\/.,]+(\d{2,4})$/);
  if (m && MONTHS_[m[1].toLowerCase()] !== undefined) {
    return mkDate_(fixYear_(+m[3]), MONTHS_[m[1].toLowerCase()], +m[2]);
  }
  // 29 Aug (no year) -> current year
  m = s.match(/^(\d{1,2})[\s\-\/.]+([A-Za-z]{3,9})$/);
  if (m && MONTHS_[m[2].toLowerCase()] !== undefined) {
    return mkDate_(new Date().getFullYear(), MONTHS_[m[2].toLowerCase()], +m[1]);
  }
  // n/n/yyyy — order from config
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
  if (m) {
    var a = +m[1], b = +m[2], y = fixYear_(+m[3]);
    var order = dateOrder || safeConfig_('DATE_ORDER') || 'DMY';
    var day, mon;
    if (a > 12 && b <= 12)      { day = a; mon = b; }
    else if (b > 12 && a <= 12) { day = b; mon = a; }
    else if (order === 'MDY')   { mon = a; day = b; }
    else                        { day = a; mon = b; }
    return mkDate_(y, mon - 1, day);
  }
  return null;
}

function mkDate_(y, mo, d) {
  if (y < 2000 || y > 2100 || mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo, d, 0, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return dt;
}

function fixYear_(y) { return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }
function atMidnight_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/** "HH:mm" or null. Accepts 9:30, 09:30, 9.30, 9:30 AM, 2130. */
function parseTime_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return pad2_(v.getHours()) + ':' + pad2_(v.getMinutes());
  }
  var s = cleanWhitespace_(String(v)).toUpperCase();
  var m = s.match(/^(\d{1,2})[:.\s]?(\d{2})?\s*(AM|PM)?$/);
  if (!m) return null;
  var h = +m[1], mi = m[2] ? +m[2] : 0;
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return pad2_(h) + ':' + pad2_(mi);
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function fmtDate_(d) {
  if (!d) return '';
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

function todayLocal_() { return atMidnight_(new Date()); }

function addDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

function weekStart_(d) {
  const startDow = (safeConfig_('WEEK_START') || 'MONDAY') === 'SUNDAY' ? 0 : 1;
  const dow = d.getDay();
  var diff = dow - startDow;
  if (diff < 0) diff += 7;
  return addDays_(atMidnight_(d), -diff);
}

function monthStart_(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function isoWeekLabel_(ws) {
  return Utilities.formatDate(ws, tz_(), 'yyyy') + '-W' +
         pad2_(Math.ceil(((ws - new Date(ws.getFullYear(), 0, 1)) / 86400000 + 1) / 7));
}

function monthLabel_(ms) { return Utilities.formatDate(ms, tz_(), 'yyyy-MM (MMM yyyy)'); }

/** Percentage with one decimal, 0 when denominator is 0. */
function pct_(num, den) { return den > 0 ? Math.round((num / den) * 1000) / 10 : 0; }

/** Percentage-POINT change (never call this a "% change"). */
function ppChange_(current, previous) { return Math.round((current - previous) * 10) / 10; }


/* ===========================================================================
 * MASTER DATA + NORMALISATION
 * ---------------------------------------------------------------------------
 * Turns messy human input into canonical master values. All master tables are
 * loaded ONCE per execution into memory by Masters.load().
 * =========================================================================*/

var Masters = (function () {
  var loaded = false;
  var statusAlias = {};     // normalised alias -> canonical status
  var statusSet = {};       // canonical status -> true
  var headerAlias = {};     // normalised header text -> canonical field
  var employees = [];       // {id,name,key,aliases:[keys],dept,active}
  var employeeByKey = {};
  var departments = [];     // {id,name,key,aliases:[keys],domains:[]}
  var deptByKey = {};
  var categories = [];      // {id,name,keywords:[],expected}
  var newEmployees = [];    // buffered auto-created rows
  var newDepartments = [];

  function keyify(s) {
    return cleanWhitespace_(decodeEntities_(s)).toLowerCase()
      .replace(/[.’']/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s{2,}/g, ' ').trim();
  }

  function load(force) {
    if (loaded && !force) return;
    statusAlias = {}; statusSet = {}; headerAlias = {};
    employees = []; employeeByKey = {}; departments = []; deptByKey = {};
    categories = []; newEmployees = []; newDepartments = [];

    readAll_(SHEETS.STATUS).forEach(function (r) {
      var name = cleanWhitespace_(r[col(SHEETS.STATUS, 'Status')]);
      if (name) { statusSet[name] = true; statusAlias[keyify(name)] = name; }
    });
    if (!Object.keys(statusSet).length) {
      STATUSES.forEach(function (s) { statusSet[s] = true; statusAlias[keyify(s)] = s; });
    }
    readAll_(SHEETS.STATUS_ALIAS).forEach(function (r) {
      var a = keyify(r[0]), c = cleanWhitespace_(r[1]);
      if (a && c) statusAlias[a] = c;
    });
    readAll_(SHEETS.HEADER_ALIAS).forEach(function (r) {
      var a = keyify(r[0]), c = cleanWhitespace_(r[1]);
      if (a && c) headerAlias[a] = c;
    });

    readAll_(SHEETS.DEPARTMENTS).forEach(function (r) {
      var name = cleanWhitespace_(r[col(SHEETS.DEPARTMENTS, 'Department_Name')]);
      if (!name) return;
      var d = {
        id: r[col(SHEETS.DEPARTMENTS, 'Department_ID')],
        name: name, key: keyify(name),
        aliases: splitList_(r[col(SHEETS.DEPARTMENTS, 'Name_Aliases')]).map(keyify),
        domains: splitList_(r[col(SHEETS.DEPARTMENTS, 'Sender_Domains')])
                   .map(function (x) { return x.toLowerCase(); })
      };
      departments.push(d);
      deptByKey[d.key] = d;
      d.aliases.forEach(function (a) { if (a) deptByKey[a] = d; });
    });

    readAll_(SHEETS.EMPLOYEES).forEach(function (r) {
      var name = cleanWhitespace_(r[col(SHEETS.EMPLOYEES, 'Employee_Name')]);
      if (!name) return;
      var e = {
        id: r[col(SHEETS.EMPLOYEES, 'Employee_ID')],
        name: name, key: keyify(name),
        aliases: splitList_(r[col(SHEETS.EMPLOYEES, 'Name_Aliases')]).map(keyify),
        dept: cleanWhitespace_(r[col(SHEETS.EMPLOYEES, 'Department')]),
        active: String(r[col(SHEETS.EMPLOYEES, 'Active')]).toUpperCase() !== 'FALSE'
      };
      employees.push(e);
      employeeByKey[e.key] = e;
      e.aliases.forEach(function (a) { if (a) employeeByKey[a] = e; });
    });

    readAll_(SHEETS.CATEGORIES).forEach(function (r) {
      var name = cleanWhitespace_(r[col(SHEETS.CATEGORIES, 'Category_Name')]);
      if (!name) return;
      var exp = r[col(SHEETS.CATEGORIES, 'Expected_Duration')];
      categories.push({
        id: r[col(SHEETS.CATEGORIES, 'Category_ID')],
        name: name,
        keywords: splitList_(r[col(SHEETS.CATEGORIES, 'Match_Keywords')])
                    .map(function (k) { return k.toLowerCase(); })
                    .filter(function (k) { return k; }),
        expected: (exp === '' || exp === null || exp === undefined) ? null : Number(exp)
      });
    });
    loaded = true;
  }

  function splitList_(v) {
    return String(v || '').split(/[,;|]/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x; });
  }

  /* ---------------- status ---------------- */
  function normalizeStatus(raw) {
    load();
    var k = keyify(raw);
    if (!k) return null;
    if (statusAlias[k]) return statusAlias[k];
    // tolerate trailing punctuation / percentages / decorations
    var k2 = k.replace(/\b(task|status|is|was)\b/g, '').replace(/\s{2,}/g, ' ').trim();
    if (statusAlias[k2]) return statusAlias[k2];
    if (/^\d+%$/.test(k)) return parseInt(k, 10) >= 100 ? 'Completed' : 'In Progress';
    return null;
  }

  /* ---------------- headers ---------------- */
  function normalizeHeader(raw) {
    load();
    var k = keyify(raw);
    if (!k) return null;
    if (headerAlias[k]) return headerAlias[k];
    var k2 = k.replace(/\s*\(.*?\)\s*/g, ' ').replace(/[*#:]/g, '').replace(/\s{2,}/g, ' ').trim();
    if (headerAlias[k2]) return headerAlias[k2];
    var k3 = k2.replace(/^(s no|sr no|sl no|sno|srno|#)$/, '');
    if (headerAlias[k3]) return headerAlias[k3];
    return null;
  }

  /* ---------------- employees ---------------- */
  function resolveEmployee(rawName, deptHint) {
    load();
    var name = cleanWhitespace_(decodeEntities_(rawName))
      .replace(/\s*\((.*?)\)\s*$/, '')         // strip trailing "(Sales)"
      .replace(/^(mr|mrs|ms|dr)\.?\s+/i, '');
    var k = keyify(name);
    if (!k) return null;
    var hit = employeeByKey[k];
    if (hit) return { id: hit.id, name: hit.name, dept: hit.dept || deptHint || '', isNew: false };
    // first-name-only match, only when unambiguous
    var partial = employees.filter(function (e) {
      return e.key === k || e.key.split(' ')[0] === k;
    });
    if (partial.length === 1) {
      return { id: partial[0].id, name: partial[0].name,
               dept: partial[0].dept || deptHint || '', isNew: false };
    }
    if (!getConfig().AUTO_CREATE_EMPLOYEES) return null;
    var id = 'EMP-' + shortHash_(k, 6).toUpperCase();
    var rec = { id: id, name: titleCase_(name), key: k, aliases: [],
                dept: deptHint || getConfig().DEFAULT_DEPARTMENT, active: true };
    employees.push(rec); employeeByKey[k] = rec;
    newEmployees.push([id, rec.name, '', rec.dept, 'TRUE', '', '', '']);
    return { id: id, name: rec.name, dept: rec.dept, isNew: true };
  }

  /* ---------------- departments ---------------- */
  function resolveDepartment(rawDept, senderDomain, senderName) {
    load();
    var k = keyify(rawDept);
    if (k && deptByKey[k]) return deptByKey[k].name;
    if (!k && senderDomain) {
      for (var i = 0; i < departments.length; i++) {
        if (departments[i].domains.indexOf(String(senderDomain).toLowerCase()) >= 0) {
          return departments[i].name;
        }
      }
    }
    if (!k && senderName) {
      var sk = keyify(senderName);
      for (var j = 0; j < departments.length; j++) {
        if (sk.indexOf(departments[j].key) >= 0) return departments[j].name;
      }
    }
    if (!k) return '';
    if (!getConfig().AUTO_CREATE_DEPARTMENTS) return getConfig().DEFAULT_DEPARTMENT;
    var name = titleCase_(cleanWhitespace_(rawDept));
    var id = 'DEP-' + shortHash_(k, 6).toUpperCase();
    var d = { id: id, name: name, key: k, aliases: [], domains: [] };
    departments.push(d); deptByKey[k] = d;
    newDepartments.push([id, name, '', '', '', '', 'TRUE']);
    return name;
  }

  /**
   * Finds an EXISTING department mentioned anywhere in a piece of text
   * (subject line, sender name). Longest match wins so "Business Development"
   * beats "Development". Never creates master data.
   */
  function findDepartmentInText(text) {
    load();
    const hay = ' ' + keyify(text) + ' ';
    var best = '', bestLen = 0;
    const dflt = keyify(DEFAULT_CONFIG.DEFAULT_DEPARTMENT);
    departments.forEach(function (d) {
      const candidates = [d.key].concat(d.aliases);
      candidates.forEach(function (k) {
        if (!k || k === dflt) return;
        if (hay.indexOf(' ' + k + ' ') >= 0 && k.length > bestLen) {
          best = d.name; bestLen = k.length;
        }
      });
    });
    return best;
  }

  /** Lookup-only: returns an EXISTING department name or '' — never creates one. */
  function lookupDepartment(rawDept) {
    load();
    var k = keyify(rawDept);
    return (k && deptByKey[k]) ? deptByKey[k].name : '';
  }

  /* ---------------- categories ---------------- */
  function resolveCategory(taskNormalized) {
    load();
    var best = null, bestLen = 0;
    for (var i = 0; i < categories.length; i++) {
      var c = categories[i];
      for (var j = 0; j < c.keywords.length; j++) {
        var kw = c.keywords[j];
        if (kw && taskNormalized.indexOf(kw) >= 0 && kw.length > bestLen) {
          best = c; bestLen = kw.length;
        }
      }
    }
    return best ? { name: best.name, expected: best.expected }
                : { name: '', expected: null };
  }

  function expectedDurationFor(categoryName) {
    load();
    for (var i = 0; i < categories.length; i++) {
      if (categories[i].name === categoryName) return categories[i].expected;
    }
    return null;
  }

  /** Persists auto-created masters. Call once per run, after ingestion. */
  function flushNewMasters() {
    if (newEmployees.length) {
      appendRows_(SHEETS.EMPLOYEES, newEmployees);
      logInfo('Normalize', 'flushNewMasters',
        'Auto-created ' + newEmployees.length + ' employee(s): ' +
        newEmployees.map(function (r) { return r[1]; }).join(', '));
      newEmployees = [];
    }
    if (newDepartments.length) {
      appendRows_(SHEETS.DEPARTMENTS, newDepartments);
      logInfo('Normalize', 'flushNewMasters',
        'Auto-created ' + newDepartments.length + ' department(s): ' +
        newDepartments.map(function (r) { return r[1]; }).join(', '));
      newDepartments = [];
    }
  }

  return {
    load: load, keyify: keyify, normalizeStatus: normalizeStatus,
    normalizeHeader: normalizeHeader, resolveEmployee: resolveEmployee,
    resolveDepartment: resolveDepartment, lookupDepartment: lookupDepartment,
    findDepartmentInText: findDepartmentInText,
    resolveCategory: resolveCategory,
    expectedDurationFor: expectedDurationFor, flushNewMasters: flushNewMasters,
    statuses: function () { load(); return Object.keys(statusSet); }
  };
})();

function titleCase_(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); })
    .replace(/\b(Of|And|The|To|For)\b/g, function (m) { return m.toLowerCase(); })
    .replace(/^./, function (m) { return m.toUpperCase(); });
}

/**
 * Task normalisation used for repeat detection and duplicate fingerprints.
 * Deliberately CONSERVATIVE: it removes noise (case, punctuation, filler words,
 * dates/numbers that only mark an instance) but never merges different verbs
 * or different objects.
 */
const TASK_STOPWORDS_ = {
  'the':1,'a':1,'an':1,'of':1,'for':1,'to':1,'and':1,'on':1,'in':1,'at':1,
  'with':1,'today':1,'todays':1,'daily':1,'pls':1,'please':1,'done':1
};

function normalizeTask_(raw) {
  var s = cleanWhitespace_(decodeEntities_(raw)).toLowerCase();
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/[‘’“”]/g, '');
  s = s.replace(/[^a-z0-9%\s]+/g, ' ');
  s = s.replace(/\b\d{1,4}\b/g, ' ');            // instance numbers, dates
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

/** Token set for similarity, stopwords removed, order-independent. */
function taskTokens_(normalized) {
  const seen = {};
  const out = [];
  normalized.split(' ').forEach(function (t) {
    if (!t || TASK_STOPWORDS_[t] || t.length < 2) return;
    if (!seen[t]) { seen[t] = 1; out.push(t); }
  });
  return out.sort();
}

/** Jaccard similarity of two token arrays (0..1). Deterministic, no AI. */
function tokenSimilarity_(a, b) {
  if (!a.length || !b.length) return 0;
  var setB = {};
  b.forEach(function (t) { setB[t] = 1; });
  var inter = 0;
  a.forEach(function (t) { if (setB[t]) inter++; });
  return inter / (a.length + b.length - inter);
}
