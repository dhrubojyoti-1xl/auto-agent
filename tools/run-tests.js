#!/usr/bin/env node
/**
 * Local test harness.
 *
 * Loads every apps-script/*.gs file into ONE VM context alongside a minimal
 * in-memory emulation of the Google Apps Script services (tools/gas-stubs.js)
 * and runs the REAL production functions — not a parallel re-implementation.
 * The same setupSpreadsheet(), ingestDocument_(), rebuildMetrics() and
 * generateDailyReport() that run inside Google run here.
 *
 *   node tools/run-tests.js            unit + integration suite
 *   node tools/run-tests.js --verbose  also dump the resulting sheets
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const stubs = require('./gas-stubs');

const VERBOSE = process.argv.includes('--verbose');
const dir = path.join(__dirname, '..', 'apps-script');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort();

const sandbox = Object.assign({
  console, JSON, Math, Date, String, Number, Array, Object,
  isNaN, parseInt, parseFloat, RegExp, Error
}, stubs);
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

files.forEach(f => {
  try {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  } catch (e) {
    console.error('LOAD ERROR in ' + f + ': ' + e.message);
    process.exit(1);
  }
});
console.log('Loaded ' + files.length + ' Apps Script files: ' + files.join(', ') + '\n');

let failures = [];

/* ------------------------------------------------------------------ */
/* 1. The in-Sheet suite (13_Tests.gs) — unit + parser + AI validation */
/* ------------------------------------------------------------------ */
sandbox.setupSpreadsheet();
const unit = sandbox.runAllTests();
if (unit.failures.length) failures = failures.concat(unit.failures);

/* ------------------------------------------------------------------ */
/* 2. End-to-end integration: fixture -> DB -> metrics -> report       */
/* ------------------------------------------------------------------ */
console.log('\n=== END-TO-END INTEGRATION ===');
const e2e = [];
function check(name, fn) {
  try { fn(); e2e.push({ name, pass: true }); console.log('PASS  ' + name); }
  catch (e) {
    e2e.push({ name, pass: false, error: e.message });
    failures.push({ name, error: e.message });
    console.log('FAIL  ' + name + '  -> ' + e.message);
  }
}
function eq(a, b, msg) {
  if (String(a) !== String(b)) throw new Error((msg || 'expected') + ' "' + b + '" but got "' + a + '"');
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const SS = stubs.SS;
const rows = n => Math.max(SS.getSheetByName(n).getLastRow() - 1, 0);

const first = sandbox.loadSampleData();
check('run 1 inserts task rows', () => assert(first.inserted > 40,
  'expected >40 inserted, got ' + first.inserted));
check('run 1 rejects the deliberately bad rows', () => assert(first.rejected > 0,
  'expected some rejections'));
check('Tasks populated', () => assert(rows('Tasks') === first.inserted,
  'Tasks rows (' + rows('Tasks') + ') should equal inserted (' + first.inserted + ')'));
check('Reports has one row per source email', () => assert(rows('Reports') === 5,
  'got ' + rows('Reports')));
check('Data_Quality captured the rejects', () => eq(rows('Data_Quality'), first.rejected));

const second = sandbox.loadSampleData();
check('IDEMPOTENT: run 2 inserts 0 rows', () => eq(second.inserted, 0));
check('IDEMPOTENT: run 2 rejects 0 rows', () => eq(second.rejected, 0));
check('IDEMPOTENT: Tasks row count unchanged', () => eq(rows('Tasks'), first.inserted));

// Row-level guarantee: forget the emails, keep the tasks, re-run.
const rep = SS.getSheetByName('Reports');
rep.getRange(2, 1, rep.getLastRow() - 1, rep.getLastColumn()).clearContent();
const third = sandbox.loadSampleData();
check('IDEMPOTENT: fingerprints alone stop re-insertion', () => eq(third.inserted, 0));
check('IDEMPOTENT: rows recognised as already present', () => assert(third.skipped > 40,
  'expected >40 skipped, got ' + third.skipped));

sandbox.rebuildMetrics();
check('metrics built', () => assert(rows('Daily_Summary') > 0 && rows('Department_Summary') === 3,
  'Daily=' + rows('Daily_Summary') + ' Dept=' + rows('Department_Summary')));
check('repeated tasks detected', () => assert(rows('Repeated_Tasks') > 0));
check('slow tasks detected', () => assert(rows('Slow_Tasks') > 0));
check('every department resolved (no Unassigned)', () => {
  const sh = SS.getSheetByName('Department_Summary');
  const names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]));
  assert(names.indexOf('Unassigned') < 0, 'found Unassigned: ' + names.join(','));
});

const daily = sandbox.generateDailyReport();
check('daily report generated', () => assert(daily.report.indexOf('DAILY DEPARTMENT REPORT') === 0));
check('report states provenance', () => assert(daily.report.indexOf('PROVENANCE') > 0));
check('report never prints raw JSON braces in the body', () =>
  assert(daily.report.indexOf('{"project"') < 0));
check('weekly report generated', () => assert(!!sandbox.generateWeeklyReport().reportId));
check('monthly report generated', () => assert(!!sandbox.generateMonthlyReport().reportId));
check('AI_Reports archive populated', () => assert(rows('AI_Reports') === 3,
  'expected 3 archived reports, got ' + rows('AI_Reports')));
check('re-generating a report upserts instead of duplicating', () => {
  sandbox.generateDailyReport();
  eq(rows('AI_Reports'), 3, 'still 3 rows after regenerating the daily report');
});

/* --- manual AI round trip, including a deliberately hallucinated reply --- */
sandbox.buildDailyAiDataset();
const aiSheet = SS.getSheetByName('AI_Dataset');
check('AI dataset + prompt written for manual mode', () => {
  const r = aiSheet.getRange(aiSheet.getLastRow(), 1, 1, aiSheet.getLastColumn()).getValues()[0];
  assert(String(r[4]).indexOf('ABSOLUTE RULES') > 0, 'prompt missing');
  assert(String(r[5]).indexOf('"totals"') > 0, 'dataset missing');
  eq(r[7], 'AWAITING_PASTE');
});
aiSheet.getRange(aiSheet.getLastRow(), 7).setValue('```json\n' + JSON.stringify({
  summary: 'Volume held steady while completion slipped.',
  overall_completion_rate: 999,                                  // impossible
  department_observations: [
    { department: 'Sales', observation: 'Six tasks reported.',
      interpretation: 'Half still open.', confidence: 'medium' },
    { department: 'Atlantis', observation: 'fake', interpretation: 'fake',
      confidence: 'high' }                                       // invented dept
  ],
  attention_items: [{ item: 'Marketing completion is low', why_it_matters: 'x',
                      supporting_data: '0 of 3', suggested_action: 'ask' }],
  slow_tasks: [{ task_id: 'TSK-NOPE', comment: 'invented' }],    // invented id
  repeated_tasks: [], trends: ['Volume rose slightly.'],
  data_quality: ['Several tasks lack timestamps.']
}) + '\n```');
const importedId = sandbox.importPastedAiJson();
const aiRep = SS.getSheetByName('AI_Reports');
// importPastedAiJson() UPSERTS by Report_ID, so the imported row is wherever the
// daily report already was — not necessarily the last row. Look it up properly.
const aiRow = aiRep.getRange(2, 1, aiRep.getLastRow() - 1, aiRep.getLastColumn())
  .getValues().filter(r => String(r[0]) === String(importedId))[0] || [];
check('pasted AI JSON imported (code fences tolerated)', () => assert(!!importedId));
// The PROVENANCE footer deliberately QUOTES what was removed, so the rejected
// claims must be absent from the report BODY but present in the disclosure.
const reportBody = String(aiRow[9]).split('PROVENANCE')[0];
const reportFooter = String(aiRow[9]).split('PROVENANCE')[1] || '';
const validationCol = String(aiRow[11]);
check('AI VALIDATION: impossible rate replaced by the database value', () => {
  assert(validationCol.indexOf('999') >= 0, 'the 999 claim should be logged');
  assert(reportBody.indexOf('999') < 0, 'the report body must not print 999');
  const stated = reportBody.match(/Overall Performance:\s*\n\s*([\d.]+)%/);
  assert(stated, 'could not find the headline completion rate');
  assert(Number(stated[1]) >= 0 && Number(stated[1]) <= 100,
    'headline rate out of range: ' + stated[1]);
});
check('AI VALIDATION: invented department dropped from the report body', () => {
  assert(validationCol.indexOf('Atlantis') >= 0, 'should be logged');
  assert(reportBody.indexOf('Atlantis') < 0, 'must not appear as a real department');
});
check('AI VALIDATION: invented Task_ID dropped from the report body', () => {
  assert(validationCol.indexOf('TSK-NOPE') >= 0, 'should be logged');
  assert(reportBody.indexOf('TSK-NOPE') < 0, 'must not appear as a real task');
});
check('AI VALIDATION: removals are disclosed to the reader', () =>
  assert(reportFooter.indexOf('failed validation') > 0,
    'the provenance footer must say claims were removed'));
check('AI VALIDATION: partial status is disclosed in the report', () => {
  eq(aiRow[7], 'OK_AI_PARTIAL');
  assert(String(aiRow[9]).indexOf('some claims failed validation') > 0);
});
check('AI validation keeps the supportable commentary', () =>
  assert(String(aiRow[9]).indexOf('Volume held steady') > 0));

check('System Status reports real numbers', () => {
  const s = sandbox.getSystemStatus();
  eq(s.tasksInDatabase, first.inserted, 'tasksInDatabase');
  assert(s.duplicatesDetected > 0, 'duplicatesDetected should be > 0');
  eq(s.aiEnabled, false, 'aiEnabled');
});

/* ------------------------------------------------------------------ */
/* 3. The Monday demo email — the numbers quoted in the docs must hold  */
/* ------------------------------------------------------------------ */
console.log('\n=== DEMO EMAIL (sample-data/real-demo-email.html) ===');
const demoHtml = fs.readFileSync(path.join(__dirname, '..', 'sample-data', 'real-demo-email.html'), 'utf8');
const demoState = { fingerprints: {}, terminalEmailIds: {} };
const demoDoc = {
  emailId: 'DEMO', threadId: 'DEMO',
  subject: 'Daily Report - Sales, Marketing, Operations',
  from: 'Team <team@example.com>', received: new Date(),
  html: demoHtml, plain: '', dryRun: true
};
const demo = sandbox.ingestDocument_(demoDoc, demoState, sandbox.getConfig());
check('demo email: 14 rows import', () => eq(demo.inserted, 14));
check('demo email: 2 rows quarantined', () => {
  eq(demo.rejected, 2);
  const reasons = demo.rejectedRows.map(r => r[7]).sort();
  eq(reasons.join(','), 'MISSING_REQUIRED_FIELD,UNKNOWN_STATUS');
});
check('demo email: three identical client calls are ALL kept', () => {
  const calls = demo.records.filter(r => r.taskNormalized === 'client call');
  eq(calls.length, 3, 'client call rows imported');
});
check('demo email: repeat group is classified Needs Review', () => {
  const out = sandbox.analyzeRepeatedTasks_(demo.records.map(sandbox.taskRecordToRow_));
  const grp = out.summaryRows.filter(r => String(r[3]).toLowerCase().indexOf('client call') >= 0)[0];
  assert(grp, 'no client-call repeat group');
  eq(grp[5], 3, 'occurrence count');
  eq(grp[13], 'Needs Review', 'classification');
});
check('demo email: exactly 4 measurable slow tasks', () => {
  const out = sandbox.analyzeSlowTasks_(demo.records.map(sandbox.taskRecordToRow_));
  eq(out.slowCount, 4, 'slow tasks');
  assert(out.insufficientCount > 0, 'the rest must read INSUFFICIENT_DATA');
});
check('demo email: forwarding it imports nothing', () => {
  const resend = sandbox.ingestDocument_(
    Object.assign({}, demoDoc, { emailId: 'DEMO-FWD',
      subject: 'Fwd: Daily Report - Sales, Marketing, Operations' }),
    demoState, sandbox.getConfig());
  eq(resend.inserted, 0, 'inserted on resend');
  const dupes = resend.rejectedRows.filter(r => r[7] === 'DUPLICATE_ACROSS_EMAILS').length;
  eq(dupes, 14, 'duplicate rejections');
});

/* ------------------------------------------------------------------ */
/* 4. Optional dump                                                    */
/* ------------------------------------------------------------------ */
if (VERBOSE) {
  ['Tasks', 'Reports', 'Data_Quality', 'Daily_Summary', 'Department_Summary',
   'Employee_Summary', 'Repeated_Tasks', 'Slow_Tasks'].forEach(n => {
    const sh = SS.getSheetByName(n);
    console.log('\n--- ' + n + ' (' + rows(n) + ' rows) ---');
    const data = sh.getRange(1, 1, Math.min(sh.getLastRow(), 7), sh.getLastColumn()).getValues();
    data.forEach(r => console.log(r.map(v =>
      (v instanceof Date ? sandbox.fmtDate_(v) : String(v)).slice(0, 20)).join(' | ')));
  });
  console.log('\n' + daily.report);
}

/* ------------------------------------------------------------------ */
const total = unit.total + e2e.length;
const passed = total - failures.length;
console.log('\n============================================================');
console.log('TOTAL: ' + passed + '/' + total + ' passed' +
  (failures.length ? ', ' + failures.length + ' FAILED' : ''));
console.log('============================================================');
if (failures.length) {
  failures.forEach(f => console.error(' FAIL  ' + f.name + ': ' + f.error));
  process.exit(1);
}
