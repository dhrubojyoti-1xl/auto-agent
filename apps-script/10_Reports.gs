/**
 * ============================================================================
 * 10_Reports.gs — daily / weekly / monthly management reports.
 * ============================================================================
 * A report is ALWAYS produced. The deterministic sections are built from the
 * dataset; the AI only supplies commentary. Generator column records which of
 * 'deterministic' / 'ai:<model>' / 'ai-manual' produced the commentary.
 * ============================================================================
 */

function generateDailyReport()   { return generateReport_('DAILY'); }
function generateWeeklyReport()  { return generateReport_('WEEKLY'); }
function generateMonthlyReport() { return generateReport_('MONTHLY'); }

function periodFor_(type, anchorDate) {
  const anchor = anchorDate || latestTaskDate_(readAll_(SHEETS.TASKS)) || todayLocal_();
  if (type === 'DAILY')   return { start: anchor, end: anchor };
  if (type === 'WEEKLY')  { const ws = weekStart_(anchor); return { start: ws, end: addDays_(ws, 6) }; }
  if (type === 'MONTHLY') {
    const ms = monthStart_(anchor);
    return { start: ms, end: new Date(ms.getFullYear(), ms.getMonth() + 1, 0) };
  }
  throw new Error('Unknown report type ' + type);
}

function generateReport_(type, anchorDate) {
  const cfg = getConfig();
  const p = periodFor_(type, anchorDate);
  const dataset = buildAiDataset_(type, p.start, p.end);

  var generator = 'deterministic';
  var model = '';
  var aiClean = null;
  var validationError = '';
  var status = 'OK_NO_AI';

  if (cfg.AI_ENABLED && cfg.AI_PROVIDER !== 'manual') {
    const res = callAi_(dataset);
    if (res.ok) {
      const v = validateAiJson_(res.json, dataset);
      aiClean = v.clean;
      validationError = v.errors.join(' | ');
      generator = 'ai:' + cfg.AI_PROVIDER;
      model = cfg.AI_MODEL;
      status = v.ok ? 'OK_AI' : 'OK_AI_PARTIAL';
      if (!v.ok) {
        logWarn('AI', 'validate', v.errors.length + ' AI claim(s) rejected: ' +
          truncate_(validationError, 500));
      }
    } else {
      validationError = 'AI unavailable (' + res.reason + (res.error ? ': ' + res.error : '') + ')';
      status = 'OK_AI_UNAVAILABLE';
      logWarn('AI', 'call', validationError);
    }
  } else if (cfg.AI_ENABLED && cfg.AI_PROVIDER === 'manual') {
    writeManualDataset_(type, p, dataset);
    validationError = 'Manual AI mode: prompt + dataset written to the ' + SHEETS.AI_DATASET +
      ' sheet. Paste the model response back and run importPastedAiJson().';
    status = 'OK_AWAITING_MANUAL_AI';
  }

  const human = renderHumanReport_(dataset, aiClean, status, validationError);
  const reportId = type + '-' + fmtDate_(p.start) + '-' + shortHash_(fmtDate_(p.end) + type, 6);

  upsertAiReport_([
    reportId, type, p.start, p.end, new Date(), generator, model, status,
    truncate_(aiClean ? aiClean.summary : deterministicSummary_(dataset), 2000),
    truncate_(human, 45000),
    truncate_(JSON.stringify({ dataset: dataset, ai: aiClean }), 45000),
    truncate_(validationError, 2000)
  ]);

  const wantEmail = (type === 'DAILY' && cfg.EMAIL_DAILY_REPORT) ||
                    (type === 'WEEKLY' && cfg.EMAIL_WEEKLY_REPORT) ||
                    (type === 'MONTHLY' && cfg.EMAIL_WEEKLY_REPORT);
  if (wantEmail && cfg.MANAGEMENT_EMAIL) {
    try {
      MailApp.sendEmail({
        to: cfg.MANAGEMENT_EMAIL,
        subject: type.charAt(0) + type.slice(1).toLowerCase() + ' Department Report — ' +
                 fmtDate_(p.start) + (fmtDate_(p.start) === fmtDate_(p.end) ? '' : ' to ' + fmtDate_(p.end)),
        body: human
      });
      logInfo('Reports', 'email', 'Sent ' + type + ' report to ' + cfg.MANAGEMENT_EMAIL);
    } catch (e) {
      logError('Reports', 'email', 'Send failed: ' + e.message);
    }
  }

  logInfo('Reports', 'generate', type + ' report ' + reportId + ' status=' + status);
  flushLog();
  return { reportId: reportId, status: status, report: human };
}

/** Insert-or-replace by Report_ID so re-running a day does not duplicate rows. */
function upsertAiReport_(row) {
  const sh = sheet_(SHEETS.AI_REPORTS);
  const existing = readAll_(SHEETS.AI_REPORTS);
  const idCol = col(SHEETS.AI_REPORTS, 'Report_ID');
  for (var i = 0; i < existing.length; i++) {
    if (String(existing[i][idCol]) === String(row[0])) {
      sh.getRange(i + 2, 1, 1, SCHEMA[SHEETS.AI_REPORTS].headers.length).setValues([row]);
      return;
    }
  }
  appendRows_(SHEETS.AI_REPORTS, [row]);
}

/* ---------------------------------------------------------------------------
 * Human-readable rendering (the exact management format)
 * ------------------------------------------------------------------------- */
function renderHumanReport_(d, ai, status, validationError) {
  const L = [];
  const title = d.meta.report_type === 'DAILY' ? 'DAILY DEPARTMENT REPORT'
              : d.meta.report_type === 'WEEKLY' ? 'WEEKLY DEPARTMENT REPORT'
              : 'MONTHLY DEPARTMENT REPORT';
  L.push(title);
  L.push('Period: ' + d.meta.period_start +
    (d.meta.period_start === d.meta.period_end ? '' : ' to ' + d.meta.period_end));
  L.push('Generated: ' + d.meta.generated_at);
  L.push('');
  L.push('EXECUTIVE SUMMARY');
  L.push('');
  L.push(ai && ai.summary ? ai.summary : deterministicSummary_(d));
  L.push('');
  L.push('Overall Performance:');
  L.push('  ' + d.totals.completion_rate + '% completion');
  L.push('');
  L.push('Total Tasks:');
  L.push('  ' + d.totals.total);
  L.push('');
  L.push('Completed:');
  L.push('  ' + d.totals.completed);
  L.push('');
  L.push('Pending:');
  L.push('  ' + d.totals.pending);
  L.push('');
  L.push('In Progress:');
  L.push('  ' + d.totals.in_progress);
  if (d.totals.blocked || d.totals.cancelled || d.totals.not_started) {
    L.push('');
    L.push('Blocked: ' + d.totals.blocked + '   Not Started: ' + d.totals.not_started +
           '   Cancelled: ' + d.totals.cancelled);
  }
  L.push('');
  L.push('Versus ' + d.meta.comparison_period_start + ' to ' + d.meta.comparison_period_end + ':');
  if (d.comparison_totals.total === 0) {
    L.push('  No comparable data in the previous period. Insufficient data.');
  } else {
    L.push('  Tasks: ' + d.comparison_totals.total + ' → ' + d.totals.total +
      ' (' + signed_(d.totals.total - d.comparison_totals.total) + ')');
    L.push('  Completion rate: ' + d.comparison_totals.completion_rate + '% → ' +
      d.totals.completion_rate + '% (' +
      signed_(d.completion_rate_change_percentage_points) + ' percentage points)');
  }
  L.push('');
  L.push('');
  L.push('DEPARTMENT PERFORMANCE');
  L.push('');
  if (!d.departments.length) L.push('Insufficient data.');
  d.departments.forEach(function (x) {
    L.push(x.department + ':');
    L.push('  ' + x.completion_rate + '%  (' + x.completed + ' of ' + x.total +
      ' completed, ' + x.pending + ' pending, ' + x.in_progress + ' in progress, ' +
      x.employees_reporting + ' employee(s) reporting)');
    const obs = ai && ai.department_observations.filter(function (o) {
      return o.department === x.department;
    })[0];
    if (obs) {
      if (obs.observation) L.push('  Observation: ' + obs.observation);
      if (obs.interpretation) L.push('  Interpretation (' + obs.confidence + ' confidence): ' + obs.interpretation);
    }
    L.push('');
  });
  L.push('');
  L.push('AREAS REQUIRING ATTENTION');
  L.push('');
  const attention = (ai && ai.attention_items.length) ? ai.attention_items
                                                      : deterministicAttention_(d);
  if (!attention.length) L.push('Nothing flagged by the deterministic rules for this period.');
  attention.forEach(function (a, i) {
    L.push((i + 1) + '. ' + a.item);
    if (a.why_it_matters)   L.push('   Why it matters: ' + a.why_it_matters);
    if (a.supporting_data)  L.push('   Supporting data: ' + a.supporting_data);
    if (a.suggested_action) L.push('   Suggested action: ' + a.suggested_action);
  });
  L.push('');
  L.push('');
  L.push('SLOW TASKS');
  L.push('');
  if (!d.slow_tasks.length) {
    L.push('None identified. ' + d.slow_task_note);
  } else {
    d.slow_tasks.slice(0, 15).forEach(function (s) {
      const c = ai && ai.slow_tasks.filter(function (x) { return x.task_id === s.task_id; })[0];
      L.push('Task:       ' + s.task);
      L.push('Employee:   ' + s.employee);
      L.push('Department: ' + s.department);
      L.push('Expected:   ' + s.expected_hours + ' h');
      L.push('Actual:     ' + s.actual_hours + ' h');
      L.push('Variance:   ' + signed_(s.variance_hours) + ' h');
      if (c && c.comment) L.push('Comment:    ' + c.comment);
      L.push('');
    });
    L.push(d.slow_task_note);
  }
  L.push('');
  L.push('');
  L.push('REPEATED TASK PATTERNS');
  L.push('');
  if (!d.repeated_tasks.length) {
    L.push('No repeated task groups in this period.');
  } else {
    d.repeated_tasks.slice(0, 15).forEach(function (r) {
      const c = ai && ai.repeated_tasks.filter(function (x) {
        return x.employee === r.employee && x.task === r.task;
      })[0];
      L.push('Task:           ' + r.task);
      L.push('Employee:       ' + r.employee);
      L.push('Occurrences:    ' + r.occurrences + ' across ' + r.distinct_dates + ' date(s)');
      L.push('Classification: ' + r.classification);
      if (c && c.comment) L.push('Comment:        ' + c.comment);
      L.push('');
    });
  }
  L.push('');
  L.push('KEY TRENDS');
  L.push('');
  const trends = (ai && ai.trends.length) ? ai.trends : deterministicTrends_(d);
  if (!trends.length) L.push('- Insufficient data.');
  trends.forEach(function (t) { L.push('- ' + t); });
  L.push('');
  L.push('');
  L.push('DATA QUALITY');
  L.push('');
  const q = d.data_quality;
  L.push('- Tasks in period: ' + q.tasks_in_period);
  L.push('- Rows rejected during import: ' + q.rows_rejected_in_period +
    (Object.keys(q.rejection_reasons).length
      ? ' (' + Object.keys(q.rejection_reasons).map(function (k) {
          return k + ': ' + q.rejection_reasons[k]; }).join(', ') + ')' : ''));
  L.push('- Tasks missing a link: ' + q.tasks_missing_link);
  L.push('- Tasks flagged for review: ' + q.tasks_flagged_for_review);
  L.push('- Tasks without duration information: ' + q.tasks_without_duration_data +
    ' (duration and efficiency cannot be measured for these)');
  L.push('- Unclassified tasks: ' + q.uncategorised_tasks);
  if (ai && ai.data_quality.length) ai.data_quality.forEach(function (x) { L.push('- ' + x); });
  L.push('');
  L.push('');
  L.push('PROVENANCE');
  L.push('- All counts, rates and flags above are computed by spreadsheet code, not by an AI.');
  if (status === 'OK_NO_AI') {
    L.push('- AI commentary: disabled. Deterministic commentary used.');
  } else if (status === 'OK_AI_UNAVAILABLE') {
    L.push('- AI commentary: UNAVAILABLE this run. ' + validationError);
  } else if (status === 'OK_AWAITING_MANUAL_AI') {
    L.push('- AI commentary: awaiting manual paste. ' + validationError);
  } else if (status === 'OK_AI_PARTIAL') {
    L.push('- AI commentary: included, but some claims failed validation and were removed: ' +
      truncate_(validationError, 400));
  } else {
    L.push('- AI commentary: included and validated against the dataset.');
  }
  return L.join('\n');
}

function signed_(n) {
  if (n === null || n === undefined || n === '') return 'n/a';
  const r = Math.round(Number(n) * 10) / 10;
  return (r > 0 ? '+' : '') + r;
}

/* ---------------------------------------------------------------------------
 * Deterministic fallbacks — used when the AI layer is off or unavailable.
 * These state facts only. They never speculate.
 * ------------------------------------------------------------------------- */
function deterministicSummary_(d) {
  const t = d.totals;
  const parts = [];
  parts.push(t.total + ' task(s) were reported by ' + d.departments.length +
    ' department(s) and ' + t.employees_reporting + ' employee(s) in this period, of which ' +
    t.completed + ' are marked Completed (' + t.completion_rate + '%).');
  if (d.comparison_totals.total > 0) {
    parts.push('The previous comparable period had ' + d.comparison_totals.total +
      ' task(s) at ' + d.comparison_totals.completion_rate + '% completion, a change of ' +
      signed_(d.completion_rate_change_percentage_points) + ' percentage points.');
  } else {
    parts.push('There is no comparable previous period in the database, so no trend is stated.');
  }
  if (d.slow_tasks.length) {
    parts.push(d.slow_tasks.length + ' task(s) exceeded their expected duration threshold.');
  } else {
    parts.push('No task exceeded its expected duration threshold; ' +
      d.data_quality.tasks_without_duration_data + ' task(s) lack the timestamps needed to judge duration.');
  }
  return parts.join(' ');
}

function deterministicAttention_(d) {
  const items = [];
  const cfg = getConfig();
  d.departments.forEach(function (x) {
    if (x.total >= 5 && x.completion_rate < 50) {
      items.push({
        item: x.department + ' completion rate is ' + x.completion_rate + '%',
        why_it_matters: 'Below half of reported tasks are marked Completed.',
        supporting_data: x.completed + ' completed of ' + x.total + ' reported; ' +
          x.pending + ' pending, ' + x.blocked + ' blocked.',
        suggested_action: 'Confirm with the department whether the work is genuinely open ' +
          'or whether statuses are not being updated at day end.'
      });
    }
    if (x.blocked >= 3) {
      items.push({
        item: x.department + ' has ' + x.blocked + ' blocked task(s)',
        why_it_matters: 'Blocked work does not move without an external unblock.',
        supporting_data: x.blocked + ' of ' + x.total + ' tasks carry status Blocked.',
        suggested_action: 'Review the blockers in the dashboard Department page.'
      });
    }
  });
  if (d.slow_tasks.length) {
    const worst = d.slow_tasks[0];
    items.push({
      item: d.slow_tasks.length + ' task(s) ran beyond ' + cfg.SLOW_TASK_MULTIPLIER +
        'x their expected duration',
      why_it_matters: 'Persistent overruns usually mean the estimate is wrong or the ' +
        'process has a hidden step.',
      supporting_data: 'Largest variance: "' + worst.task + '" (' + worst.employee + ') ' +
        worst.actual_hours + ' h actual vs ' + worst.expected_hours + ' h expected.',
      suggested_action: 'Check whether the category estimate in Task_Categories is realistic.'
    });
  }
  const review = d.repeated_tasks.filter(function (r) { return r.classification === 'Needs Review'; });
  if (review.length) {
    items.push({
      item: review.length + ' repeated-task group(s) need a human check',
      why_it_matters: 'Several identical rows on one day may be genuine batched work or a ' +
        'reporting artefact. The system does not guess.',
      supporting_data: review.slice(0, 3).map(function (r) {
        return r.employee + ': "' + r.task + '" x' + r.occurrences; }).join('; '),
      suggested_action: 'Open the Repeated Tasks dashboard page and confirm with the reporter.'
    });
  }
  if (d.data_quality.rows_rejected_in_period > 0) {
    items.push({
      item: d.data_quality.rows_rejected_in_period + ' row(s) were rejected at import',
      why_it_matters: 'Rejected rows are missing from every metric on the dashboard.',
      supporting_data: JSON.stringify(d.data_quality.rejection_reasons),
      suggested_action: 'Open the Data_Quality sheet, fix the source format or add the ' +
        'missing alias, then re-send the email.'
    });
  }
  return items;
}

function deterministicTrends_(d) {
  const out = [];
  if (d.comparison_totals.total > 0) {
    out.push('Task volume moved from ' + d.comparison_totals.total + ' to ' + d.totals.total +
      ' (' + signed_(d.totals.total - d.comparison_totals.total) + ').');
    out.push('Completion rate moved from ' + d.comparison_totals.completion_rate + '% to ' +
      d.totals.completion_rate + '% (' + signed_(d.completion_rate_change_percentage_points) +
      ' percentage points — not a percentage change).');
  }
  const top = d.departments.slice().sort(function (a, b) { return b.total - a.total; })[0];
  if (top) out.push('Highest reported volume: ' + top.department + ' with ' + top.total + ' task(s).');
  const rec = d.repeated_tasks.filter(function (r) {
    return r.classification === 'Highly Repetitive'; });
  if (rec.length) {
    out.push(rec.length + ' task pattern(s) are highly repetitive and may be automation candidates: ' +
      rec.slice(0, 3).map(function (r) { return '"' + r.task + '"'; }).join(', ') + '.');
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * MANUAL AI MODE — zero dependency, zero cost, honestly semi-automatic.
 * ------------------------------------------------------------------------- */
function buildDailyAiDataset()   { return buildManualDataset_('DAILY'); }
function buildWeeklyAiDataset()  { return buildManualDataset_('WEEKLY'); }
function buildMonthlyAiDataset() { return buildManualDataset_('MONTHLY'); }

function buildManualDataset_(type) {
  const p = periodFor_(type);
  const dataset = buildAiDataset_(type, p.start, p.end);
  writeManualDataset_(type, p, dataset);
  flushLog();
  try {
    SpreadsheetApp.getUi().alert('Prompt and dataset written to the "' + SHEETS.AI_DATASET +
      '" sheet.\n\n1. Copy column E (prompt) AND column F (dataset) into any chatbot.\n' +
      '2. Paste the JSON reply into column G of that same row.\n' +
      '3. Menu → "Import pasted AI JSON".');
  } catch (e) {}
  return dataset;
}

function writeManualDataset_(type, p, dataset) {
  appendRows_(SHEETS.AI_DATASET, [[
    new Date(), type, p.start, p.end,
    AI_SYSTEM_PROMPT + '\n\n' + '--- TASK ---\nProduce the JSON described above for the ' +
      type + ' period ' + fmtDate_(p.start) + ' to ' + fmtDate_(p.end) +
      ' using ONLY the dataset in the next cell. Output JSON only.',
    truncate_(JSON.stringify(dataset, null, 1), 45000),
    '', 'AWAITING_PASTE'
  ]]);
}

/** Reads the newest AI_Dataset row that has a pasted response and rebuilds the report. */
function importPastedAiJson() {
  const rows = readAll_(SHEETS.AI_DATASET);
  const iResp = col(SHEETS.AI_DATASET, 'Paste_AI_JSON_Response_Here');
  const iStat = col(SHEETS.AI_DATASET, 'Import_Status');
  const iType = col(SHEETS.AI_DATASET, 'Report_Type');
  const iStart = col(SHEETS.AI_DATASET, 'Period_Start');
  const iEnd = col(SHEETS.AI_DATASET, 'Period_End');

  var target = -1;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][iResp]).trim() && String(rows[i][iStat]) !== 'IMPORTED') { target = i; break; }
  }
  if (target < 0) {
    try { SpreadsheetApp.getUi().alert('No pasted AI response found in ' + SHEETS.AI_DATASET + '.'); } catch (e) {}
    return null;
  }

  const type = String(rows[target][iType]);
  const start = parseDate_(rows[target][iStart]);
  const end = parseDate_(rows[target][iEnd]);
  const dataset = buildAiDataset_(type, start, end);
  const parsed = parseJsonLoose_(rows[target][iResp]);
  const sh = sheet_(SHEETS.AI_DATASET);

  if (!parsed) {
    sh.getRange(target + 2, iStat + 1).setValue('PARSE_FAILED');
    logError('AI', 'importPasted', 'Pasted response was not valid JSON');
    flushLog();
    try { SpreadsheetApp.getUi().alert('That response is not valid JSON. Nothing was published.'); } catch (e) {}
    return null;
  }
  const v = validateAiJson_(parsed, dataset);
  const human = renderHumanReport_(dataset, v.clean,
    v.ok ? 'OK_AI' : 'OK_AI_PARTIAL', v.errors.join(' | '));
  const reportId = type + '-' + fmtDate_(start) + '-' + shortHash_(fmtDate_(end) + type, 6);

  upsertAiReport_([
    reportId, type, start, end, new Date(), 'ai-manual', 'pasted',
    v.ok ? 'OK_AI' : 'OK_AI_PARTIAL',
    truncate_(v.clean.summary, 2000), truncate_(human, 45000),
    truncate_(JSON.stringify({ dataset: dataset, ai: v.clean }), 45000),
    truncate_(v.errors.join(' | '), 2000)
  ]);
  sh.getRange(target + 2, iStat + 1).setValue('IMPORTED');
  logInfo('AI', 'importPasted', 'Imported manual AI JSON for ' + reportId +
    (v.ok ? '' : ' with ' + v.errors.length + ' rejected claim(s)'));
  flushLog();
  try {
    SpreadsheetApp.getUi().alert('Imported. See the ' + SHEETS.AI_REPORTS + ' sheet, row for ' +
      reportId + (v.ok ? '.' : '.\n\n' + v.errors.length + ' unsupported claim(s) were removed.'));
  } catch (e) {}
  return reportId;
}
