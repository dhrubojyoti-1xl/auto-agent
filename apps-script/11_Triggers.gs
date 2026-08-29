/**
 * ============================================================================
 * 11_Triggers.gs — automation. Timing lives on the Config sheet.
 * ============================================================================
 * Trigger map:
 *   every N minutes  -> ingestTrigger        (email -> Tasks)
 *   daily  @ hour    -> dailyPipeline        (analysis + metrics + daily report)
 *   weekly @ day/hr  -> weeklyPipeline
 *   monthly@ day/hr  -> monthlyPipeline      (implemented as a daily check)
 *
 * A LockService lock prevents two overlapping runs from double-writing.
 * ============================================================================
 */

function installTriggers() {
  removeTriggers();
  const cfg = getConfig();
  const created = [];

  if (cfg.TRIGGER_INGEST_EVERY_MINUTES > 0) {
    const m = [1, 5, 10, 15, 30].indexOf(cfg.TRIGGER_INGEST_EVERY_MINUTES) >= 0
      ? cfg.TRIGGER_INGEST_EVERY_MINUTES : null;
    if (m) {
      ScriptApp.newTrigger('ingestTrigger').timeBased().everyMinutes(m).create();
      created.push('ingest every ' + m + ' min');
    } else {
      ScriptApp.newTrigger('ingestTrigger').timeBased().everyHours(1).create();
      created.push('ingest hourly (Apps Script only allows 1/5/10/15/30 min intervals)');
    }
  }

  ScriptApp.newTrigger('dailyPipeline').timeBased()
    .atHour(cfg.TRIGGER_DAILY_HOUR).nearMinute(10).everyDays(1).create();
  created.push('dailyPipeline at ' + cfg.TRIGGER_DAILY_HOUR + ':10');

  const wd = ScriptApp.WeekDay[cfg.TRIGGER_WEEKLY_DAY] || ScriptApp.WeekDay.MONDAY;
  ScriptApp.newTrigger('weeklyPipeline').timeBased()
    .onWeekDay(wd).atHour(cfg.TRIGGER_WEEKLY_HOUR).nearMinute(30).create();
  created.push('weeklyPipeline on ' + cfg.TRIGGER_WEEKLY_DAY + ' at ' + cfg.TRIGGER_WEEKLY_HOUR + ':30');

  ScriptApp.newTrigger('monthlyPipeline').timeBased()
    .atHour(cfg.TRIGGER_MONTHLY_HOUR).nearMinute(50).everyDays(1).create();
  created.push('monthlyPipeline daily check at ' + cfg.TRIGGER_MONTHLY_HOUR + ':50');

  logInfo('Triggers', 'install', 'Installed: ' + created.join(' | '));
  flushLog();
  try { SpreadsheetApp.getUi().alert('Triggers installed:\n\n' + created.join('\n')); } catch (e) {}
  return created;
}

function removeTriggers() {
  const all = ScriptApp.getProjectTriggers();
  all.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  logInfo('Triggers', 'remove', 'Removed ' + all.length + ' trigger(s)');
  flushLog();
  return all.length;
}

function withLock_(name, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    logWarn('Triggers', name, 'Another run holds the lock; skipping this execution.');
    flushLog();
    return null;
  }
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function ingestTrigger() {
  return withLock_('ingestTrigger', function () {
    const r = processIncomingReports();
    // Keep the dashboard live: refresh metrics only when something changed.
    if (r && (r.inserted > 0 || r.rejected > 0)) rebuildMetrics();
    return r;
  });
}

function dailyPipeline() {
  return withLock_('dailyPipeline', function () {
    processIncomingReports();
    rebuildMetrics();
    return generateDailyReport();
  });
}

function weeklyPipeline() {
  return withLock_('weeklyPipeline', function () {
    rebuildMetrics();
    return generateWeeklyReport();
  });
}

/** Runs daily but only acts on the configured day of the month. */
function monthlyPipeline() {
  const cfg = getConfig();
  if (new Date().getDate() !== cfg.TRIGGER_MONTHLY_DAY) return null;
  return withLock_('monthlyPipeline', function () {
    rebuildMetrics();
    // Report on the month that just ended.
    const anchor = addDays_(monthStart_(todayLocal_()), -1);
    return generateReport_('MONTHLY', anchor);
  });
}

/** Convenience for the very first end-to-end proof. */
function runFullPipelineNow() {
  const ingest = processIncomingReports();
  const metrics = rebuildMetrics();
  const report = generateDailyReport();
  console.log(JSON.stringify({ ingest: ingest, taskRows: metrics, report: report.status }));
  return report.report;
}
