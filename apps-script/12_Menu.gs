/**
 * ============================================================================
 * 12_Menu.gs — the spreadsheet menu and the System Status panel.
 * ============================================================================
 * Everything an operator needs is reachable from this menu. Nobody should ever
 * have to open the script editor to run the system day to day.
 * ============================================================================
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Department Reporting')
    .addItem('Setup System', 'setupSpreadsheet')
    .addItem('Process New Emails', 'processIncomingReports')
    .addItem('Rebuild Metrics', 'rebuildMetrics')
    .addSeparator()
    .addItem('Generate Daily Report', 'generateDailyReport')
    .addItem('Generate Weekly Report', 'generateWeeklyReport')
    .addItem('Generate Monthly Report', 'generateMonthlyReport')
    .addSeparator()
    .addItem('Load Sample Data', 'loadSampleData')
    .addItem('Run Tests', 'runAllTests')
    .addItem('System Status', 'showSystemStatus')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('AI (optional)')
      .addItem('Build AI dataset + prompt (daily)', 'buildDailyAiDataset')
      .addItem('Import pasted AI JSON', 'importPastedAiJson')
      .addItem('Store AI API key', 'setApiKey')
      .addItem('Clear AI API key', 'clearApiKey'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Automation')
      .addItem('Install triggers', 'installTriggers')
      .addItem('Remove triggers', 'removeTriggers'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Maintenance')
      .addItem('Clear demo/transactional data', 'clearTransactionalData'))
    .addToUi();
}

/**
 * Collects a live health picture from the database itself — never from cached
 * counters, so it cannot drift from reality.
 */
function getSystemStatus() {
  const cfg = getConfig();
  const reports = readObjects_(SHEETS.REPORTS);
  const tasks = readAll_(SHEETS.TASKS);
  const rejects = readAll_(SHEETS.DATA_QUALITY);
  const aiReports = readObjects_(SHEETS.AI_REPORTS);
  const logs = readObjects_(SHEETS.LOG);

  function latest(rows, field) {
    var best = null;
    rows.forEach(function (r) {
      const d = r[field] instanceof Date ? r[field] : parseDate_(r[field]);
      if (d && (!best || d > best)) best = d;
    });
    return best;
  }
  function fmtStamp(d) {
    return d ? Utilities.formatDate(d, tz_(), 'yyyy-MM-dd HH:mm') : 'never';
  }

  var inserted = 0, rejected = 0, skipped = 0, extracted = 0;
  const byStatus = {};
  reports.forEach(function (r) {
    inserted += Number(r['Rows_Inserted'] || 0);
    rejected += Number(r['Rows_Rejected'] || 0);
    skipped += Number(r['Rows_Skipped_Idempotent'] || 0);
    extracted += Number(r['Rows_Extracted'] || 0);
    byStatus[r['Processing_Status']] = (byStatus[r['Processing_Status']] || 0) + 1;
  });

  var duplicates = 0;
  const dupIdx = col(SHEETS.DATA_QUALITY, 'Rejection_Reason');
  rejects.forEach(function (r) { if (String(r[dupIdx]) === 'DUPLICATE_ACROSS_EMAILS') duplicates++; });

  const metricsStamp = (function () {
    const rows = readObjects_(SHEETS.DAILY);
    return rows.length ? latest(rows, 'Updated_At') : null;
  })();

  var triggerInfo = [];
  try {
    triggerInfo = ScriptApp.getProjectTriggers().map(function (t) {
      return t.getHandlerFunction();
    });
  } catch (e) {
    triggerInfo = ['(unavailable: ' + e.message + ')'];
  }

  const lastError = logs.filter(function (l) { return String(l['Level']) === 'ERROR'; }).pop();

  return {
    lastEmailProcessing: fmtStamp(latest(reports, 'Processed_At')),
    emailsProcessed: reports.length,
    emailsByStatus: byStatus,
    rowsExtracted: extracted,
    tasksImported: inserted,
    tasksInDatabase: tasks.length,
    tasksRejected: rejected,
    rowsSkippedIdempotent: skipped,
    duplicatesDetected: duplicates,
    dataQualityRows: rejects.length,
    lastMetricsRebuild: fmtStamp(metricsStamp),
    lastReportGenerated: fmtStamp(latest(aiReports, 'Generated_At')),
    lastReportType: aiReports.length ? aiReports[aiReports.length - 1]['Report_Type'] : 'none',
    aiEnabled: cfg.AI_ENABLED,
    aiProvider: cfg.AI_PROVIDER,
    aiKeyStored: getApiKey_() ? 'yes' : 'no',
    triggers: triggerInfo,
    searchQuery: cfg.SEARCH_QUERY,
    lastError: lastError
      ? Utilities.formatDate(new Date(lastError['Timestamp']), tz_(), 'yyyy-MM-dd HH:mm') +
        ' — ' + lastError['Component'] + '/' + lastError['Action'] + ': ' + lastError['Message']
      : 'none'
  };
}

function formatSystemStatus_(s) {
  const L = [];
  L.push('SYSTEM STATUS');
  L.push('');
  L.push('INGESTION');
  L.push('  Last email processing : ' + s.lastEmailProcessing);
  L.push('  Emails processed      : ' + s.emailsProcessed +
    (Object.keys(s.emailsByStatus).length
      ? '  (' + Object.keys(s.emailsByStatus).map(function (k) {
          return k + ': ' + s.emailsByStatus[k]; }).join(', ') + ')' : ''));
  L.push('  Rows extracted        : ' + s.rowsExtracted);
  L.push('  Tasks imported        : ' + s.tasksImported);
  L.push('  Tasks in database     : ' + s.tasksInDatabase);
  L.push('  Tasks rejected        : ' + s.tasksRejected);
  L.push('  Duplicates detected   : ' + s.duplicatesDetected);
  L.push('  Skipped as idempotent : ' + s.rowsSkippedIdempotent);
  L.push('  Data_Quality rows     : ' + s.dataQualityRows);
  L.push('');
  L.push('PROCESSING');
  L.push('  Last metrics rebuild  : ' + s.lastMetricsRebuild);
  L.push('  Last report generated : ' + s.lastReportGenerated + ' (' + s.lastReportType + ')');
  L.push('');
  L.push('AI');
  L.push('  Enabled               : ' + (s.aiEnabled ? 'yes' : 'no'));
  L.push('  Provider              : ' + s.aiProvider);
  L.push('  API key stored        : ' + s.aiKeyStored);
  L.push('');
  L.push('AUTOMATION');
  L.push('  Gmail search          : ' + s.searchQuery);
  L.push('  Triggers installed    : ' + (s.triggers.length ? s.triggers.join(', ') : 'none'));
  L.push('');
  L.push('HEALTH');
  L.push('  Last error            : ' + s.lastError);
  return L.join('\n');
}

function showSystemStatus() {
  const text = formatSystemStatus_(getSystemStatus());
  console.log(text);
  try {
    SpreadsheetApp.getUi().alert('System Status', text, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* running headless */ }
  return text;
}
