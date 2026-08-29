/**
 * ============================================================================
 * 06_Ingest.gs — the document → database pipeline. This is the heart of P0.
 * ============================================================================
 * Guarantees:
 *   IDEMPOTENT  Running twice over the same email inserts nothing the second
 *               time. Enforced by Task_Fingerprint + Source_Email_ID, not by
 *               the Gmail label (labels are a convenience, not the source of
 *               truth — a user can remove one).
 *   ATOMIC-ish  Each email is committed on its own (tasks → report row →
 *               label). A crash mid-run leaves earlier emails done and the
 *               current one retryable; the retry re-detects its own rows as
 *               already-inserted and skips them.
 *   LOSSLESS    A bad row never kills the email. It lands in Data_Quality
 *               with the raw values and a precise reason.
 * ============================================================================
 */

const PIPELINE = 'Ingest';

/* ---------------------------------------------------------------------------
 * State: what the database already knows.
 * ------------------------------------------------------------------------- */
function loadIngestState_() {
  const fingerprints = {};   // fingerprint -> source email id
  const tasks = readAll_(SHEETS.TASKS);
  const fpIdx = col(SHEETS.TASKS, 'Task_Fingerprint');
  const emIdx = col(SHEETS.TASKS, 'Source_Email_ID');
  for (var i = 0; i < tasks.length; i++) {
    const fp = tasks[i][fpIdx];
    if (fp) fingerprints[fp] = tasks[i][emIdx];
  }
  const terminalEmailIds = {};
  const reports = readAll_(SHEETS.REPORTS);
  const rEmail = col(SHEETS.REPORTS, 'Email_ID');
  const rStatus = col(SHEETS.REPORTS, 'Processing_Status');
  for (var j = 0; j < reports.length; j++) {
    const st = String(reports[j][rStatus] || '');
    if (st === 'SUCCESS' || st === 'PARTIAL' || st === 'NO_DATA' || st === 'IGNORED') {
      terminalEmailIds[reports[j][rEmail]] = st;
    }
  }
  logDebug(PIPELINE, 'loadState', 'Loaded ' + Object.keys(fingerprints).length +
    ' fingerprints, ' + Object.keys(terminalEmailIds).length + ' completed emails');
  return { fingerprints: fingerprints, terminalEmailIds: terminalEmailIds };
}

/* ---------------------------------------------------------------------------
 * One email, end to end.
 * ------------------------------------------------------------------------- */
/**
 * Ingests one "document" — a Gmail message, a test fixture, or sample data.
 * Keeping Gmail behind this boundary is what makes the parser unit-testable
 * without sending a single email.
 * doc = {emailId, threadId, subject, from, received, html, plain}
 */
function ingestDocument_(doc, state, cfg) {
  const emailId = doc.emailId;
  const subject = doc.subject || '';
  const from = doc.from || '';
  const addr = (from.match(/<([^>]+)>/) || [null, from]).slice(1)[0].toLowerCase().trim();
  const domain = addr.indexOf('@') >= 0 ? addr.split('@')[1] : '';
  const received = doc.received || new Date();
  const reportId = 'RPT-' + shortHash_(emailId, 10).toUpperCase();

  // 1. Extract candidate tables
  var tables = [];
  const body = doc.html || '';
  if (body) tables = extractTables_(body);
  if (!tables.length && cfg.PARSE_PLAINTEXT_PIPE_TABLES) {
    tables = extractPipeTables_(doc.plain || tagText_(body));
  }

  // 2. Keep only tables that map to the schema
  const reportTables = [];
  tables.forEach(function (tbl) {
    const hdr = mapHeaderRow_(tbl.rows);
    if (hdr) reportTables.push({ table: tbl, header: hdr });
  });

  if (!reportTables.length) {
    const detail = 'No table with recognisable Date/Employee/Task/Status headers. ' +
      'Tables seen: ' + tables.length + '. Add the missing header wording to the ' +
      SHEETS.HEADER_ALIAS + ' sheet if this email really is a report.';
    if (!doc.dryRun) writeReportRow_({
      reportId: reportId, emailId: emailId, threadId: doc.threadId || '', subject: subject,
      sender: from, domain: domain, department: '', reportDate: atMidnight_(received),
      received: received, status: 'NO_DATA', tables: tables.length, extracted: 0,
      insertedCount: 0, skippedCount: 0, rejectedCount: 0, error: detail
    });
    logWarn(PIPELINE, 'noTable', detail, { emailId: emailId, reportId: reportId });
    return { status: 'NO_DATA', inserted: 0, rejected: 0, skipped: 0,
             tables: tables.length, extracted: 0, error: detail };
  }

  // 3. Department hint from subject / sender, overridable per row
  const deptHint = departmentFromContext_(subject, domain, from);

  // 4. Parse every report table into candidate rows
  const candidates = [];
  const rejects = [];
  var extracted = 0;

  reportTables.forEach(function (rt, tIdx) {
    const rows = rt.table.rows;
    const map = rt.header.mapping;
    for (var r = rt.header.headerRowIndex + 1; r < rows.length; r++) {
      if (extracted >= cfg.MAX_ROWS_PER_EMAIL) break;
      const raw = readRowFields_(rows[r], map);
      if (isBlankRow_(raw)) continue;
      if (looksLikeTotalsRow_(raw)) continue;
      extracted++;
      const built = buildTaskRecord_(raw, {
        reportId: reportId, emailId: emailId, received: received, deptHint: deptHint,
        tableIndex: tIdx, rowIndex: r, cfg: cfg
      });
      if (built.ok) candidates.push(built.record);
      else rejects.push(rejectionRow_(built, {
        reportId: reportId, emailId: emailId, subject: subject, sender: from,
        tableIndex: tIdx, rowIndex: r, raw: raw
      }));
    }
  });

  // 5. Fingerprint + duplicate resolution
  const ordinals = {};
  const toInsert = [];
  var skippedIdempotent = 0;

  candidates.forEach(function (rec, candidateIndex) {
    const base = [
      fmtDate_(rec.date), Masters.keyify(rec.employeeName),
      Masters.keyify(rec.department), rec.taskNormalized, rec.status
    ].join('|');
    ordinals[base] = (ordinals[base] || 0) + 1;
    const ordinal = ordinals[base];
    const fp = shortHash_(base + '#' + ordinal, 16);
    rec.fingerprint = fp;
    rec.occurrenceInReport = ordinal;

    const owner = state.fingerprints[fp];
    if (owner === undefined) {
      state.fingerprints[fp] = rec.emailId;
      toInsert.push(rec);
    } else if (owner === rec.emailId) {
      skippedIdempotent++;                       // safe re-run of the same email
    } else {
      rejects.push(rejectionRow_({
        reason: 'DUPLICATE_ACROSS_EMAILS',
        detail: 'Identical task already imported from email ' + owner +
                ' (fingerprint ' + fp + ', occurrence ' + ordinal +
                ' of this Date+Employee+Task+Status). Not a repeated task: the same ' +
                'occurrence number is already in the database.'
      }, {
        // Carry the row's real position so every duplicate stays individually
        // identifiable in Data_Quality.
        reportId: reportId, emailId: emailId, subject: subject, sender: from,
        tableIndex: rec.tableIndex, rowIndex: rec.rowIndex, raw: rec.rawEcho
      }));
    }
  });

  // 6. Commit — tasks first, then the report row (so a crash is retryable)
  if (!doc.dryRun) {
    if (toInsert.length) appendRows_(SHEETS.TASKS, toInsert.map(taskRecordToRow_));
    if (rejects.length) appendRows_(SHEETS.DATA_QUALITY, rejects);
  }

  const reportDate = pickReportDate_(candidates, subject, received);
  const status = toInsert.length === 0 && rejects.length > 0 ? 'PARTIAL'
               : rejects.length > 0 ? 'PARTIAL'
               : toInsert.length === 0 && skippedIdempotent > 0 ? 'SUCCESS'
               : toInsert.length === 0 ? 'NO_DATA' : 'SUCCESS';

  if (!doc.dryRun) writeReportRow_({
    reportId: reportId, emailId: emailId, threadId: doc.threadId || '', subject: subject,
    sender: from, domain: domain,
    department: dominantDepartment_(candidates) || deptHint || '',
    reportDate: reportDate, received: received, status: status,
    tables: reportTables.length, extracted: extracted,
    insertedCount: toInsert.length, skippedCount: skippedIdempotent,
    rejectedCount: rejects.length,
    error: rejects.length ? rejects.length + ' row(s) rejected — see ' + SHEETS.DATA_QUALITY : ''
  });

  logInfo(PIPELINE, 'email',
    'Imported ' + toInsert.length + '/' + extracted + ' rows (' + skippedIdempotent +
    ' already present, ' + rejects.length + ' rejected) from "' + truncate_(subject, 80) + '"',
    { emailId: emailId, reportId: reportId });

  return { status: status, inserted: toInsert.length, rejected: rejects.length,
           skipped: skippedIdempotent, tables: reportTables.length, extracted: extracted,
           records: toInsert, rejectedRows: rejects };
}

/* ---------------------------------------------------------------------------
 * Row helpers
 * ------------------------------------------------------------------------- */
function readRowFields_(cells, map) {
  const out = {};
  Object.keys(map).forEach(function (field) {
    const c = cells[map[field]];
    out[field] = c ? c.text : '';
    if (field === FIELDS.LINK && c && c.href) out[field] = c.href;
  });
  // Any URL anywhere in the row is better than no link at all.
  if (!out[FIELDS.LINK]) {
    for (var i = 0; i < cells.length; i++) {
      if (cells[i] && cells[i].href) { out[FIELDS.LINK] = cells[i].href; break; }
    }
  }
  return out;
}

function isBlankRow_(raw) {
  return !Object.keys(raw).some(function (k) { return cleanWhitespace_(raw[k]); });
}

function looksLikeTotalsRow_(raw) {
  const t = cleanWhitespace_(raw[FIELDS.TASK] || '').toLowerCase();
  const e = cleanWhitespace_(raw[FIELDS.EMPLOYEE] || '').toLowerCase();
  return /^(total|grand total|sum|subtotal)\b/.test(t) || /^(total|grand total)\b/.test(e);
}

/**
 * Validates + normalises one raw row.
 * Returns {ok:true, record} or {ok:false, reason, detail}.
 */
function buildTaskRecord_(raw, ctx) {
  const cfg = ctx.cfg;
  const problems = [];

  // --- Date (required) ---
  const rawDate = cleanWhitespace_(raw[FIELDS.DATE]);
  if (!rawDate) return { ok: false, reason: 'MISSING_REQUIRED_FIELD', detail: 'Date is empty' };
  const date = parseDate_(rawDate, cfg.DATE_ORDER);
  if (!date) {
    return { ok: false, reason: 'INVALID_DATE',
      detail: 'Could not parse "' + rawDate + '". Accepted: 2026-08-29, 29 Aug 2026, ' +
              '29/08/2026 (DATE_ORDER=' + cfg.DATE_ORDER + '), Aug 29 2026.' };
  }
  const daysAhead = Math.round((date - todayLocal_()) / 86400000);
  if (daysAhead > 2) problems.push('Date is ' + daysAhead + ' day(s) in the future');

  // --- Employee (required) ---
  const rawEmp = cleanWhitespace_(raw[FIELDS.EMPLOYEE]);
  if (!rawEmp) return { ok: false, reason: 'MISSING_REQUIRED_FIELD', detail: 'Employee name is empty' };
  const deptRaw = cleanWhitespace_(raw[FIELDS.DEPARTMENT]);
  const deptFromRow = deptRaw ? Masters.resolveDepartment(deptRaw, '', '') : '';
  const emp = Masters.resolveEmployee(rawEmp, deptFromRow || ctx.deptHint || cfg.DEFAULT_DEPARTMENT);
  if (!emp) {
    return { ok: false, reason: 'UNKNOWN_EMPLOYEE',
      detail: '"' + rawEmp + '" is not in ' + SHEETS.EMPLOYEES +
              ' and AUTO_CREATE_EMPLOYEES is FALSE.' };
  }
  if (emp.isNew) problems.push('Employee auto-created from this email');
  // Department precedence:
  //   explicit column > employee master > email/subject hint > configured default
  // Department is part of the duplicate fingerprint, so it must be derived the
  // same way on every run.
  //
  // DEFAULT_DEPARTMENT is a placeholder, not a fact: if the employee master
  // only carries the placeholder (which is what an auto-created employee gets),
  // a real signal from the subject line or sender domain must still win.
  const deptFromMaster = (emp.dept && emp.dept !== cfg.DEFAULT_DEPARTMENT) ? emp.dept : '';
  const department = deptFromRow || deptFromMaster ||
                     ctx.deptHint || cfg.DEFAULT_DEPARTMENT;

  // --- Task (required) ---
  const rawTask = cleanWhitespace_(raw[FIELDS.TASK]);
  if (!rawTask) return { ok: false, reason: 'MISSING_REQUIRED_FIELD', detail: 'Task is empty' };
  if (rawTask.length < cfg.MIN_TASK_LENGTH) {
    return { ok: false, reason: 'TASK_TOO_SHORT',
      detail: 'Task "' + rawTask + '" is shorter than MIN_TASK_LENGTH=' + cfg.MIN_TASK_LENGTH };
  }
  const taskNormalized = normalizeTask_(rawTask);
  if (!taskNormalized) {
    return { ok: false, reason: 'TASK_NOT_MEANINGFUL',
      detail: 'Task "' + rawTask + '" contains no usable words after normalisation' };
  }

  // --- Status (required) ---
  const rawStatus = cleanWhitespace_(raw[FIELDS.STATUS]);
  if (!rawStatus) return { ok: false, reason: 'MISSING_REQUIRED_FIELD', detail: 'Status is empty' };
  var status = Masters.normalizeStatus(rawStatus);
  if (!status) {
    if (cfg.REJECT_UNKNOWN_STATUS) {
      return { ok: false, reason: 'UNKNOWN_STATUS',
        detail: '"' + rawStatus + '" does not map to any canonical status. Add it to the ' +
                SHEETS.STATUS_ALIAS + ' sheet (Alias -> Canonical_Status) and re-import.' };
    }
    status = 'Pending';
    problems.push('Unrecognised status "' + rawStatus + '" defaulted to Pending');
  }

  // --- Optional fields ---
  const priority = normalizePriority_(raw[FIELDS.PRIORITY]);
  const startDate = parseDate_(raw[FIELDS.START_DATE], cfg.DATE_ORDER);
  const startTime = parseTime_(raw[FIELDS.START_TIME]);
  const compDate  = parseDate_(raw[FIELDS.COMPLETION_DATE], cfg.DATE_ORDER);
  const compTime  = parseTime_(raw[FIELDS.COMPLETION_TIME]);
  const link      = cleanWhitespace_(raw[FIELDS.LINK]);
  const notes     = cleanWhitespace_(raw[FIELDS.NOTES]);

  // Category: explicit column wins, else keyword match, else Uncategorised.
  var categoryName = cleanWhitespace_(raw[FIELDS.CATEGORY]);
  var expected = null;
  if (categoryName) {
    expected = Masters.expectedDurationFor(categoryName);
  } else {
    const cat = Masters.resolveCategory(taskNormalized);
    categoryName = cat.name;
    expected = cat.expected;
  }
  const expectedFromEmail = toHours_(raw[FIELDS.EXPECTED_DURATION]);
  if (expectedFromEmail !== null) expected = expectedFromEmail;

  const dur = computeDuration_(date, startDate, startTime, compDate, compTime,
                               toHours_(raw[FIELDS.ACTUAL_DURATION]));
  if (dur.basis === 'Insufficient Data') {
    problems.push('No start/completion timestamps — duration cannot be measured');
  }

  const quality = problems.length ? (problems.some(function (p) { return /future|Unrecognised/.test(p); })
      ? 'Review' : 'Partial') : 'OK';

  return {
    ok: true,
    record: {
      taskId: 'TSK-' + shortHash_(ctx.emailId + '|' + ctx.tableIndex + '|' + ctx.rowIndex + '|' + rawTask, 10).toUpperCase(),
      reportId: ctx.reportId,
      tableIndex: ctx.tableIndex,
      rowIndex: ctx.rowIndex,
      date: date,
      department: department,
      employeeName: emp.name,
      employeeId: emp.id,
      task: rawTask,
      taskNormalized: taskNormalized,
      category: categoryName,
      status: status,
      priority: priority,
      startDate: startDate, startTime: startTime,
      compDate: compDate, compTime: compTime,
      expected: expected,
      actual: dur.hours,
      durationBasis: dur.basis,
      link: link,
      emailId: ctx.emailId,
      emailDate: ctx.received,
      quality: quality,
      qualityNotes: problems.join('; '),
      notes: notes,
      rawEcho: raw
    }
  };
}

function normalizePriority_(v) {
  const s = cleanWhitespace_(v).toLowerCase();
  if (!s) return '';
  if (/^(p0|p1|high|urgent|critical|h)$/.test(s)) return 'High';
  if (/^(p2|medium|med|normal|m)$/.test(s)) return 'Medium';
  if (/^(p3|p4|low|minor|l)$/.test(s)) return 'Low';
  return titleCase_(s);
}

function toHours_(v) {
  if (v === null || v === undefined) return null;
  const s = cleanWhitespace_(String(v)).toLowerCase();
  if (!s) return null;
  var m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)?$/);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(\d+)\s*(m|min|mins|minutes)$/);
  if (m) return Math.round((parseFloat(m[1]) / 60) * 100) / 100;
  m = s.match(/^(\d+)\s*:\s*(\d{1,2})$/);       // 2:30 = 2.5h
  if (m) return Math.round((parseInt(m[1], 10) + parseInt(m[2], 10) / 60) * 100) / 100;
  m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs)\s*(\d+)\s*(m|min|mins)$/);
  if (m) return Math.round((parseFloat(m[1]) + parseFloat(m[3]) / 60) * 100) / 100;
  return null;
}

/**
 * Actual duration in hours.
 *   Reported  — the email supplied an explicit hours column
 *   Derived   — computed from start/completion stamps
 *   Insufficient Data — never guessed
 */
function computeDuration_(taskDate, sd, st, cd, ct, reportedHours) {
  if (reportedHours !== null && reportedHours > 0) {
    return { hours: reportedHours, basis: 'Reported' };
  }
  const startD = sd || (st ? taskDate : null);
  const endD   = cd || (ct ? taskDate : null);
  if (startD && endD && st && ct) {
    const s = new Date(startD.getFullYear(), startD.getMonth(), startD.getDate(),
                       +st.split(':')[0], +st.split(':')[1]);
    const e = new Date(endD.getFullYear(), endD.getMonth(), endD.getDate(),
                       +ct.split(':')[0], +ct.split(':')[1]);
    const h = (e - s) / 3600000;
    if (h >= 0 && h < 24 * 30) return { hours: Math.round(h * 100) / 100, basis: 'Derived' };
    return { hours: null, basis: 'Insufficient Data' };
  }
  if (startD && endD && !st && !ct) {
    const days = Math.round((endD - startD) / 86400000);
    if (days >= 0 && days <= 365) {
      // Whole-day span only: expressed in days-as-hours is misleading, so we
      // record it but mark the basis honestly.
      return { hours: days === 0 ? null : days * 8, basis: days === 0 ? 'Insufficient Data' : 'Derived' };
    }
  }
  return { hours: null, basis: 'Insufficient Data' };
}

function taskRecordToRow_(r) {
  return [
    r.taskId, r.reportId, r.date, r.department, r.employeeName, r.employeeId,
    r.task, r.taskNormalized, r.category, r.status, r.priority,
    r.startDate || '', r.startTime || '', r.compDate || '', r.compTime || '',
    r.expected === null || r.expected === undefined ? '' : r.expected,
    r.actual === null || r.actual === undefined ? '' : r.actual,
    r.durationBasis, r.link, r.emailId, r.emailDate, new Date(),
    r.quality, r.qualityNotes, 'FALSE', r.fingerprint,
    'FALSE', '', 'INSUFFICIENT_DATA', '', r.notes
  ];
}

function rejectionRow_(fail, ctx) {
  const raw = ctx.raw || {};
  return [
    'REJ-' + shortHash_(ctx.emailId + '|' + ctx.tableIndex + '|' + ctx.rowIndex + '|' +
      (fail.reason || '') + '|' + JSON.stringify(raw), 10).toUpperCase(),
    ctx.reportId, ctx.emailId, truncate_(ctx.subject || '', 200), ctx.sender || '',
    ctx.tableIndex, ctx.rowIndex, fail.reason, truncate_(fail.detail || '', 900),
    cleanWhitespace_(raw[FIELDS.DATE]), cleanWhitespace_(raw[FIELDS.EMPLOYEE]),
    truncate_(cleanWhitespace_(raw[FIELDS.TASK]), 300), cleanWhitespace_(raw[FIELDS.STATUS]),
    cleanWhitespace_(raw[FIELDS.LINK]),
    truncate_(JSON.stringify(raw), 2000), new Date(), 'Open'
  ];
}

function writeReportRow_(o) {
  appendRows_(SHEETS.REPORTS, [[
    o.reportId, o.emailId, o.threadId, truncate_(o.subject, 250), o.sender, o.domain,
    o.department, o.reportDate, o.received, o.status, o.tables, o.extracted,
    o.insertedCount, o.skippedCount, o.rejectedCount, truncate_(o.error || '', 900),
    new Date(), runId()
  ]]);
}

/**
 * Best-effort department for the whole email. A per-row Department column
 * always wins over this hint.
 *
 * Only EXISTING departments are accepted here. A subject line is far too noisy
 * to mint master data from — "Fwd: Daily Report" must never create a
 * department called "Fwd", not least because Department is part of the
 * duplicate fingerprint.
 */
function departmentFromContext_(subject, domain, from) {
  const bySubject = subject.match(/\b(?:dept|department|team)\s*[:\-]\s*([A-Za-z &]+)/i);
  if (bySubject) {
    const d = Masters.lookupDepartment(bySubject[1]);
    if (d) return d;
  }
  // "Sales - Daily Report" / "Daily Report - Operations 28 Aug 2026"
  const inSubject = Masters.findDepartmentInText(subject);
  if (inSubject) return inSubject;
  return Masters.resolveDepartment('', domain, from) || '';
}

function dominantDepartment_(candidates) {
  const counts = {};
  candidates.forEach(function (c) { counts[c.department] = (counts[c.department] || 0) + 1; });
  var best = '', n = 0;
  Object.keys(counts).forEach(function (k) { if (counts[k] > n) { n = counts[k]; best = k; } });
  return best;
}

function pickReportDate_(candidates, subject, received) {
  if (candidates.length) {
    var max = candidates[0].date;
    candidates.forEach(function (c) { if (c.date > max) max = c.date; });
    return max;
  }
  const m = subject.match(/(\d{1,2}[\s\-\/.][A-Za-z]{3,9}[\s\-\/.,]+\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/);
  const d = m ? parseDate_(m[1]) : null;
  return d || atMidnight_(received);
}
