/**
 * ============================================================================
 * 08_Metrics.gs — deterministic aggregation into Looker-friendly flat tables.
 * ============================================================================
 * Why summary sheets instead of live formulas:
 *   - Looker Studio charts over a 50k-row Tasks sheet with ARRAYFORMULA columns
 *     get slow and occasionally stale. Flat pre-aggregated tables are instant.
 *   - The AI layer consumes these same tables, so the dashboard and the AI can
 *     never disagree about a number.
 * A formula-only alternative is documented in docs/FORMULAS.md for anyone who
 * prefers spreadsheet-native aggregation.
 *
 * Every summary row carries Department = 'ALL' as well as per-department rows,
 * so a KPI card can read one row instead of summing a filtered range.
 * ============================================================================
 */

function rebuildMetrics() {
  const t0 = new Date();
  Masters.load(true);
  runDeterministicAnalysis();
  const tasks = readAll_(SHEETS.TASKS);
  buildDailySummary_(tasks);
  buildWeeklySummary_(tasks);
  buildMonthlySummary_(tasks);
  buildDepartmentSummary_(tasks);
  buildEmployeeSummary_(tasks);
  logInfo('Metrics', 'rebuildMetrics',
    'Rebuilt all summaries from ' + tasks.length + ' task rows in ' + (new Date() - t0) + 'ms');
  flushLog();
  return tasks.length;
}

/** Blank accumulator with every canonical status pre-seeded at zero. */
function newBucket_() {
  const b = { total: 0, slow: 0, repeated: 0, employees: {}, dates: {} };
  STATUSES.forEach(function (s) { b[s] = 0; });
  return b;
}

function accumulate_(b, t, idx) {
  b.total++;
  const st = String(t[idx.status]);
  if (b[st] === undefined) b[st] = 0;
  b[st]++;
  if (String(t[idx.slow]) === 'TRUE') b.slow++;
  if (String(t[idx.repeated]) === 'TRUE') b.repeated++;
  const e = String(t[idx.emp] || '');
  if (e) b.employees[e] = true;
  const d = fmtDate_(parseDate_(t[idx.date]));
  if (d) b.dates[d] = true;
}

function taskIndexes_() {
  return {
    date: col(SHEETS.TASKS, 'Date'), dept: col(SHEETS.TASKS, 'Department'),
    emp: col(SHEETS.TASKS, 'Employee_Name'), empId: col(SHEETS.TASKS, 'Employee_ID'),
    status: col(SHEETS.TASKS, 'Task_Status'), slow: col(SHEETS.TASKS, 'Slow_Task_Flag'),
    repeated: col(SHEETS.TASKS, 'Repeated_Task_Flag')
  };
}

function statusCells_(b) {
  return [b.total, b['Completed'] || 0, b['In Progress'] || 0, b['Pending'] || 0,
          b['Blocked'] || 0, b['Cancelled'] || 0, b['Not Started'] || 0];
}

/* --------------------------------- DAILY --------------------------------- */
function buildDailySummary_(tasks) {
  const idx = taskIndexes_();
  const buckets = {};
  tasks.forEach(function (t) {
    const d = parseDate_(t[idx.date]);
    if (!d) return;
    const ds = fmtDate_(d);
    [String(t[idx.dept] || 'Unassigned'), 'ALL'].forEach(function (dept) {
      const key = ds + '||' + dept;
      if (!buckets[key]) buckets[key] = { date: d, dept: dept, b: newBucket_() };
      accumulate_(buckets[key].b, t, idx);
    });
  });

  const keys = Object.keys(buckets).sort();
  const prevRate = {};   // dept -> {date, rate} of the previous day present
  const rows = [];
  const now = new Date();

  keys.map(function (k) { return buckets[k]; })
      .sort(function (a, b) { return a.date - b.date || (a.dept < b.dept ? -1 : 1); })
      .forEach(function (o) {
        const b = o.b;
        const rate = pct_(b['Completed'] || 0, b.total);
        const prev = prevRate[o.dept];
        rows.push([
          fmtDate_(o.date) + '|' + o.dept, o.date, o.dept
        ].concat(statusCells_(b)).concat([
          rate, pct_(b['Pending'] || 0, b.total), b.slow, b.repeated,
          Object.keys(b.employees).length,
          prev === undefined ? '' : prev,
          prev === undefined ? '' : ppChange_(rate, prev),
          now
        ]));
        prevRate[o.dept] = rate;
      });
  replaceAll_(SHEETS.DAILY, rows);
  return rows.length;
}

/* -------------------------------- WEEKLY --------------------------------- */
function buildWeeklySummary_(tasks) {
  const idx = taskIndexes_();
  const buckets = {};
  tasks.forEach(function (t) {
    const d = parseDate_(t[idx.date]);
    if (!d) return;
    const ws = weekStart_(d);
    const key = fmtDate_(ws);
    [String(t[idx.dept] || 'Unassigned'), 'ALL'].forEach(function (dept) {
      const k = key + '||' + dept;
      if (!buckets[k]) buckets[k] = { ws: ws, dept: dept, b: newBucket_() };
      accumulate_(buckets[k].b, t, idx);
    });
  });
  const prevRate = {};
  const rows = [];
  const now = new Date();
  Object.keys(buckets).map(function (k) { return buckets[k]; })
    .sort(function (a, b) { return a.ws - b.ws || (a.dept < b.dept ? -1 : 1); })
    .forEach(function (o) {
      const b = o.b;
      const we = addDays_(o.ws, 6);
      const rate = pct_(b['Completed'] || 0, b.total);
      const prev = prevRate[o.dept];
      rows.push([
        fmtDate_(o.ws) + '|' + o.dept, o.ws, we, isoWeekLabel_(o.ws), o.dept
      ].concat(statusCells_(b)).concat([
        rate, pct_(b['Pending'] || 0, b.total), b.slow, b.repeated,
        Object.keys(b.employees).length,
        prev === undefined ? '' : prev,
        prev === undefined ? '' : ppChange_(rate, prev),
        now
      ]));
      prevRate[o.dept] = rate;
    });
  replaceAll_(SHEETS.WEEKLY, rows);
  return rows.length;
}

/* -------------------------------- MONTHLY -------------------------------- */
function buildMonthlySummary_(tasks) {
  const idx = taskIndexes_();
  const buckets = {};
  tasks.forEach(function (t) {
    const d = parseDate_(t[idx.date]);
    if (!d) return;
    const ms = monthStart_(d);
    [String(t[idx.dept] || 'Unassigned'), 'ALL'].forEach(function (dept) {
      const k = fmtDate_(ms) + '||' + dept;
      if (!buckets[k]) buckets[k] = { ms: ms, dept: dept, b: newBucket_() };
      accumulate_(buckets[k].b, t, idx);
    });
  });
  const prevRate = {};
  const rows = [];
  const now = new Date();
  Object.keys(buckets).map(function (k) { return buckets[k]; })
    .sort(function (a, b) { return a.ms - b.ms || (a.dept < b.dept ? -1 : 1); })
    .forEach(function (o) {
      const b = o.b;
      const rate = pct_(b['Completed'] || 0, b.total);
      const prev = prevRate[o.dept];
      rows.push([
        fmtDate_(o.ms) + '|' + o.dept, o.ms, monthLabel_(o.ms), o.dept
      ].concat(statusCells_(b)).concat([
        rate, pct_(b['Pending'] || 0, b.total), b.slow, b.repeated,
        Object.keys(b.employees).length,
        prev === undefined ? '' : prev,
        prev === undefined ? '' : ppChange_(rate, prev),
        now
      ]));
      prevRate[o.dept] = rate;
    });
  replaceAll_(SHEETS.MONTHLY, rows);
  return rows.length;
}

/* ------------------------------ DEPARTMENT ------------------------------- */
function buildDepartmentSummary_(tasks) {
  const idx = taskIndexes_();
  const anchor = latestTaskDate_(tasks) || todayLocal_();
  const win1 = addDays_(anchor, -6);      // last 7 days inclusive
  const win2 = addDays_(anchor, -13);     // the 7 days before that
  const acc = {};
  tasks.forEach(function (t) {
    const d = parseDate_(t[idx.date]);
    if (!d) return;
    const dept = String(t[idx.dept] || 'Unassigned');
    if (!acc[dept]) {
      acc[dept] = { b: newBucket_(), first: d, last: d,
                    l7: newBucket_(), p7: newBucket_() };
    }
    const a = acc[dept];
    accumulate_(a.b, t, idx);
    if (d < a.first) a.first = d;
    if (d > a.last) a.last = d;
    if (d >= win1 && d <= anchor) accumulate_(a.l7, t, idx);
    else if (d >= win2 && d < win1) accumulate_(a.p7, t, idx);
  });
  const now = new Date();
  const rows = Object.keys(acc).sort().map(function (dept) {
    const a = acc[dept], b = a.b;
    const r7 = pct_(a.l7['Completed'] || 0, a.l7.total);
    const p7 = pct_(a.p7['Completed'] || 0, a.p7.total);
    return [dept].concat(statusCells_(b)).concat([
      pct_(b['Completed'] || 0, b.total), b.slow, b.repeated,
      Object.keys(b.employees).length, a.first, a.last,
      a.l7.total, a.p7.total, r7, p7,
      a.p7.total ? ppChange_(r7, p7) : '', now
    ]);
  });
  replaceAll_(SHEETS.DEPT_SUMMARY, rows);
  return rows.length;
}

/* ------------------------------- EMPLOYEE -------------------------------- */
function buildEmployeeSummary_(tasks) {
  const idx = taskIndexes_();
  const anchor = latestTaskDate_(tasks) || todayLocal_();
  const w1 = addDays_(anchor, -6), w2 = addDays_(anchor, -13);
  const m1 = addDays_(anchor, -29), m2 = addDays_(anchor, -59);
  const acc = {};
  tasks.forEach(function (t) {
    const d = parseDate_(t[idx.date]);
    if (!d) return;
    const name = String(t[idx.emp] || '').trim();
    if (!name) return;
    if (!acc[name]) {
      acc[name] = { id: t[idx.empId], dept: t[idx.dept], b: newBucket_(),
                    first: d, last: d, l7: newBucket_(), p7: newBucket_(),
                    l30: 0, p30: 0 };
    }
    const a = acc[name];
    accumulate_(a.b, t, idx);
    if (d < a.first) a.first = d;
    if (d > a.last) a.last = d;
    if (d >= w1 && d <= anchor) accumulate_(a.l7, t, idx);
    else if (d >= w2 && d < w1) accumulate_(a.p7, t, idx);
    if (d >= m1 && d <= anchor) a.l30++;
    else if (d >= m2 && d < m1) a.p30++;
  });
  const now = new Date();
  const rows = Object.keys(acc).sort().map(function (name) {
    const a = acc[name], b = a.b;
    const days = Object.keys(b.dates).length;
    const r7 = pct_(a.l7['Completed'] || 0, a.l7.total);
    const p7 = pct_(a.p7['Completed'] || 0, a.p7.total);
    // Honest data-sufficiency label. The dashboard shows measurable ACTIVITY;
    // it must not imply a performance verdict from a thin sample.
    const suff = b.total >= 30 && days >= 10 ? 'Sufficient for trend'
               : b.total >= 10 ? 'Indicative only'
               : 'Insufficient — do not rank';
    return [name, a.id, a.dept].concat(statusCells_(b)).concat([
      pct_(b['Completed'] || 0, b.total), b.slow, b.repeated, days,
      a.first, a.last, a.l7.total, a.p7.total, r7, p7,
      a.p7.total ? ppChange_(r7, p7) : '', a.l30, a.p30, suff, now
    ]);
  });
  replaceAll_(SHEETS.EMP_SUMMARY, rows);
  return rows.length;
}

function latestTaskDate_(tasks) {
  const i = col(SHEETS.TASKS, 'Date');
  var max = null;
  tasks.forEach(function (t) {
    const d = parseDate_(t[i]);
    if (d && (!max || d > max)) max = d;
  });
  return max;
}
