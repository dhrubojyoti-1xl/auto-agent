/**
 * ============================================================================
 * 07_Analysis.gs — deterministic analysis. NO AI involved anywhere here.
 * ============================================================================
 * Two passes, both idempotent and safe to re-run:
 *   analyzeRepeatedTasks()  -> Repeated_Task_Flag, Repeat_Classification, Repeated_Tasks
 *   analyzeSlowTasks()      -> Slow_Task_Flag, Slow_Variance_Hours, Slow_Tasks
 *
 * Design rule honoured: repetition is NOT the same thing as duplication, and
 * a task with no duration data is NEVER called slow.
 * ============================================================================
 */

function runDeterministicAnalysis() {
  const tasks = readAll_(SHEETS.TASKS);
  if (!tasks.length) {
    logInfo('Analysis', 'run', 'No tasks to analyse');
    flushLog();
    return { repeated: 0, slow: 0 };
  }
  const rep = analyzeRepeatedTasks_(tasks);
  const slow = analyzeSlowTasks_(tasks);

  // Two column writes instead of one write per row.
  writeColumn_(SHEETS.TASKS, 'Repeated_Task_Flag', rep.flags);
  writeColumn_(SHEETS.TASKS, 'Repeat_Classification', rep.classes);
  writeColumn_(SHEETS.TASKS, 'Slow_Task_Flag', slow.flags);
  writeColumn_(SHEETS.TASKS, 'Slow_Variance_Hours', slow.variances);

  replaceAll_(SHEETS.REPEATED, rep.summaryRows);
  replaceAll_(SHEETS.SLOW, slow.summaryRows);

  logInfo('Analysis', 'run',
    rep.groupCount + ' repeat group(s) over ' + tasks.length + ' tasks; ' +
    slow.slowCount + ' slow task(s), ' + slow.insufficientCount +
    ' task(s) with insufficient duration data');
  flushLog();
  return { repeated: rep.groupCount, slow: slow.slowCount };
}

/* ---------------------------------------------------------------------------
 * REPEATED TASKS
 * ------------------------------------------------------------------------- */
function analyzeRepeatedTasks_(tasks) {
  const cfg = getConfig();
  const iDate = col(SHEETS.TASKS, 'Date');
  const iDept = col(SHEETS.TASKS, 'Department');
  const iEmp  = col(SHEETS.TASKS, 'Employee_Name');
  const iTask = col(SHEETS.TASKS, 'Task');
  const iNorm = col(SHEETS.TASKS, 'Task_Normalized');
  const iStat = col(SHEETS.TASKS, 'Task_Status');

  // Lookback is anchored on the newest data point, so historical imports and
  // demo data behave the same way as live data.
  var maxDate = null;
  tasks.forEach(function (t) {
    const d = parseDate_(t[iDate]);
    if (d && (!maxDate || d > maxDate)) maxDate = d;
  });
  const cutoff = maxDate ? addDays_(maxDate, -cfg.REPEAT_LOOKBACK_DAYS) : null;

  // 1. Exact grouping on employee + normalised task
  const groups = {};
  tasks.forEach(function (t, idx) {
    const d = parseDate_(t[iDate]);
    if (!d || (cutoff && d < cutoff)) return;
    const norm = String(t[iNorm] || normalizeTask_(t[iTask]));
    if (!norm) return;
    const empKey = Masters.keyify(t[iEmp]);
    const key = empKey + '||' + norm;
    if (!groups[key]) {
      groups[key] = {
        key: key, employee: t[iEmp], department: t[iDept], norm: norm,
        sample: t[iTask], tokens: taskTokens_(norm), rows: [], dates: {},
        sameDay: {}, completed: 0, open: 0
      };
    }
    const g = groups[key];
    g.rows.push(idx);
    const ds = fmtDate_(d);
    g.dates[ds] = true;
    g.sameDay[ds] = (g.sameDay[ds] || 0) + 1;
    if (String(t[iStat]) === 'Completed') g.completed++; else g.open++;
  });

  // 2. Merge near-identical wordings for the SAME employee (deterministic,
  //    token-set Jaccard). Different employees are never merged.
  const keys = Object.keys(groups);
  const byEmployee = {};
  keys.forEach(function (k) {
    const emp = k.split('||')[0];
    (byEmployee[emp] = byEmployee[emp] || []).push(k);
  });
  const merged = {};        // key -> canonical key
  Object.keys(byEmployee).forEach(function (emp) {
    const ks = byEmployee[emp].sort(function (a, b) {
      return groups[b].rows.length - groups[a].rows.length;
    });
    const canon = [];
    ks.forEach(function (k) {
      for (var i = 0; i < canon.length; i++) {
        if (tokenSimilarity_(groups[k].tokens, groups[canon[i]].tokens) >= cfg.SIMILARITY_THRESHOLD) {
          merged[k] = canon[i];
          return;
        }
      }
      canon.push(k);
      merged[k] = k;
    });
  });

  const finalGroups = {};
  keys.forEach(function (k) {
    const target = merged[k] || k;
    if (!finalGroups[target]) {
      finalGroups[target] = {
        employee: groups[target].employee, department: groups[target].department,
        norm: groups[target].norm, sample: groups[target].sample,
        rows: [], dates: {}, sameDay: {}, completed: 0, open: 0, variants: {}
      };
    }
    const f = finalGroups[target];
    const g = groups[k];
    f.rows = f.rows.concat(g.rows);
    Object.keys(g.dates).forEach(function (d) { f.dates[d] = true; });
    Object.keys(g.sameDay).forEach(function (d) {
      f.sameDay[d] = (f.sameDay[d] || 0) + g.sameDay[d];
    });
    f.completed += g.completed; f.open += g.open;
    f.variants[g.sample] = true;
  });

  // 3. Classify + flag
  const flags = tasks.map(function () { return 'FALSE'; });
  const classes = tasks.map(function () { return ''; });
  const summaryRows = [];
  const now = new Date();
  var groupCount = 0;

  Object.keys(finalGroups).forEach(function (k) {
    const g = finalGroups[k];
    const occurrences = g.rows.length;
    if (occurrences < 2) return;
    groupCount++;
    const dateList = Object.keys(g.dates).sort();
    const distinctDates = dateList.length;
    var maxSameDay = 0;
    Object.keys(g.sameDay).forEach(function (d) {
      if (g.sameDay[d] > maxSameDay) maxSameDay = g.sameDay[d];
    });

    var cls, reason;
    if (maxSameDay >= cfg.REPEAT_SAME_DAY_REVIEW_MIN) {
      cls = 'Needs Review';
      reason = maxSameDay + ' occurrences on a single day (>= REPEAT_SAME_DAY_REVIEW_MIN=' +
               cfg.REPEAT_SAME_DAY_REVIEW_MIN + '). Could be genuine batched work or ' +
               'a reporting habit — a human should confirm.';
    } else if (occurrences >= cfg.REPEAT_HIGH_MIN) {
      cls = 'Highly Repetitive';
      reason = occurrences + ' occurrences across ' + distinctDates +
               ' day(s) (>= REPEAT_HIGH_MIN=' + cfg.REPEAT_HIGH_MIN +
               '). Candidate for automation or templating, not a performance judgement.';
    } else if (distinctDates >= cfg.REPEAT_RECURRING_MIN) {
      cls = 'Recurring / Legitimate';
      reason = 'Appears on ' + distinctDates + ' distinct dates — a routine recurring duty.';
    } else if (occurrences > distinctDates) {
      cls = 'Potential Duplication';
      reason = occurrences + ' occurrences over only ' + distinctDates +
               ' date(s). Same-day repeats may be genuine, or the row may have been ' +
               'reported twice. Cross-check the Data_Quality sheet for hard duplicates.';
    } else {
      cls = 'Recurring / Legitimate';
      reason = 'Appears on ' + distinctDates + ' distinct dates.';
    }

    g.rows.forEach(function (idx) { flags[idx] = 'TRUE'; classes[idx] = cls; });

    summaryRows.push([
      shortHash_(k, 12), g.employee, g.department,
      Object.keys(g.variants).slice(0, 3).join(' | '), g.norm,
      occurrences, distinctDates, maxSameDay,
      parseDate_(dateList[0]), parseDate_(dateList[dateList.length - 1]),
      dateList.slice(0, 40).join(', ') + (dateList.length > 40 ? ' …' : ''),
      g.completed, g.open, cls, reason, now
    ]);
  });

  summaryRows.sort(function (a, b) { return b[5] - a[5]; });
  return { flags: flags.map(function (v) { return v; }), classes: classes,
           summaryRows: summaryRows, groupCount: groupCount };
}

/* ---------------------------------------------------------------------------
 * SLOW TASKS
 * ------------------------------------------------------------------------- */
function analyzeSlowTasks_(tasks) {
  const cfg = getConfig();
  const iId    = col(SHEETS.TASKS, 'Task_ID');
  const iDate  = col(SHEETS.TASKS, 'Date');
  const iDept  = col(SHEETS.TASKS, 'Department');
  const iEmp   = col(SHEETS.TASKS, 'Employee_Name');
  const iTask  = col(SHEETS.TASKS, 'Task');
  const iCat   = col(SHEETS.TASKS, 'Task_Category');
  const iStat  = col(SHEETS.TASKS, 'Task_Status');
  const iExp   = col(SHEETS.TASKS, 'Expected_Duration');
  const iAct   = col(SHEETS.TASKS, 'Actual_Duration');
  const iBasis = col(SHEETS.TASKS, 'Duration_Basis');
  const iLink  = col(SHEETS.TASKS, 'Link');

  const flags = [], variances = [], summaryRows = [];
  const now = new Date();
  var slowCount = 0, insufficientCount = 0;

  tasks.forEach(function (t) {
    const exp = t[iExp] === '' || t[iExp] === null ? null : Number(t[iExp]);
    const act = t[iAct] === '' || t[iAct] === null ? null : Number(t[iAct]);

    if (exp === null || act === null || isNaN(exp) || isNaN(act) || exp <= 0) {
      flags.push('INSUFFICIENT_DATA');
      variances.push('');
      insufficientCount++;
      return;
    }
    const variance = Math.round((act - exp) * 100) / 100;
    const isSlow = act > exp * cfg.SLOW_TASK_MULTIPLIER;
    flags.push(isSlow ? 'TRUE' : 'FALSE');
    variances.push(variance);
    if (isSlow) {
      slowCount++;
      summaryRows.push([
        t[iId], parseDate_(t[iDate]), t[iDept], t[iEmp], t[iTask], t[iCat], t[iStat],
        exp, act, variance, pct_(act - exp, exp), t[iBasis], t[iLink], now
      ]);
    }
  });

  summaryRows.sort(function (a, b) { return b[9] - a[9]; });   // largest variance first
  return { flags: flags, variances: variances, summaryRows: summaryRows,
           slowCount: slowCount, insufficientCount: insufficientCount };
}
