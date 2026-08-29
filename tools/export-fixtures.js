#!/usr/bin/env node
/**
 * Regenerates everything in sample-data/ and test-emails/ from the REAL
 * pipeline, so the committed artefacts can never drift from the code.
 *
 *   node tools/export-fixtures.js
 *
 * The demo email is dated relative to today, so the Monday demo shows a live
 * dashboard rather than stale history.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const stubs = require('./gas-stubs');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'apps-script');
const sandbox = Object.assign({ console, JSON, Math, Date, String, Number, Array,
  Object, isNaN, parseInt, parseFloat, RegExp, Error }, stubs);
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort()
  .forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));

const emailDir = path.join(root, 'test-emails');
const dataDir = path.join(root, 'sample-data');
fs.mkdirSync(emailDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

/* ---------------- test-email fixtures ---------------- */
const T = vm.runInContext('TEST_EMAILS', sandbox);
const fixtures = {
  '01-perfect-report.html':            T.T1_PERFECT,
  '02-reordered-columns.html':         T.T2_REORDERED,
  '03-extra-columns.html':             T.T13_EXTRA_COLUMNS,
  '04-missing-required-field.html':    T.T4_MISSING_REQUIRED,
  '05-missing-optional-field.html':    T.T3_MISSING_OPTIONAL,
  '06-duplicate-email.html':           T.T5_DUPLICATE_PLUS_NEW,
  '07-forwarded-report.html':          T.T14_FORWARDED,
  '08-multiple-tables.html':           T.T6_MULTI_TABLE,
  '10a-invalid-status.html':           T.T8_INVALID_STATUS,
  '10b-invalid-date.html':             T.T9_INVALID_DATE,
  '11-repeated-tasks.html':            T.T7_REPEATED,
  '12-duration-slow-task.html':        T.T15_DURATION_SLOW,
  '13-colspan-rowspan.html':           T.T11_SPANS,
  '14-large-report.html':              T.T10_LARGE()
};
Object.keys(fixtures).forEach(name => {
  fs.writeFileSync(path.join(emailDir, name),
    '<!-- Fixture used by apps-script/13_Tests.gs. Open in a browser, select the\n' +
    '     rendered table, copy, and paste into a Gmail compose window. -->\n' +
    fixtures[name] + '\n');
});
fs.writeFileSync(path.join(emailDir, '09-plain-text-table.txt'), T.T12_PIPE_TEXT);

/* ---------------- demo email, dated for today ---------------- */
function fmt(d) {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return String(d.getDate()).padStart(2,'0') + ' ' + M[d.getMonth()] + ' ' + d.getFullYear();
}
const today = fmt(new Date());
const demoRows = [
  [today, 'Rahul Mehta',    'Update CRM with new leads',        'Completed',   'https://crm.example.com/leads/992', '09:15', '09:50'],
  [today, 'Priya Sharma',   'Follow up with key account Acme',  'In Progress', '', '', ''],
  [today, 'Priya Sharma',   'Client call',                      'Completed',   '', '', ''],
  [today, 'Priya Sharma',   'Client call',                      'Completed',   '', '', ''],
  [today, 'Priya Sharma',   'Client call',                      'In Progress', '', '', ''],
  [today, 'Imran Khan',     'Client call - Corvin onboarding',  'Done',        '', '15:00', '17:45'],
  [today, 'Imran Khan',     'Send quotation to Delta Industries','Pending',    '', '', ''],
  [today, 'Neha Gupta',     'Write blog post: SEO basics',      'Completed',   'https://blog.example.com/seo', '', ''],
  [today, 'Arjun Patel',    'Google Ads campaign optimisation', 'WIP',         '', '', ''],
  [today, 'Sana Qureshi',   'Design creatives for festive campaign', 'In Progress', '', '09:30', '18:00'],
  [today, 'Vikas Nair',     'Process customer orders',          'Complete',    '', '08:45', '10:15'],
  [today, 'Deepa Iyer',     'Prepare daily report',             'Done',        '', '', ''],
  [today, 'Rohit Verma',    'Dispatch shipments',               'In progress', '', '', ''],
  [today, 'Ayesha Siddiqui','Resolve support ticket #4412',     'Completed',   'https://help.example.com/t/4412', '09:00', '11:30'],
  [today, 'Rohit Verma',    'Stock audit',                      'Compleeted!!','', '', ''],
  [today, '',               'Unassigned housekeeping task',     'Pending',     '', '', '']
];
const head = ['Date','Employee Name','Task','Status','Link','Start Time','End Time'];
const demoHtml =
'<!-- MONDAY DEMO EMAIL — regenerate with: node tools/export-fixtures.js\n' +
'     Subject line to use:  Daily Report - Sales, Marketing, Operations\n' +
'     Row 14 has a deliberately unmappable status and row 15 a missing\n' +
'     employee: both land in Data_Quality, and the other 13 still import. -->\n' +
'<div dir="ltr"><p>Hi Sir,</p><p>Please find today\'s consolidated report below.</p>' +
'<table border="1" cellspacing="0" cellpadding="5" style="border-collapse:collapse">' +
'<thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
demoRows.map(r => '<tr>' + [
  r[0], r[1], r[2], r[3],
  r[4] ? '<a href="' + r[4] + '">link</a>' : '', r[5], r[6]
].map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') +
'</tbody></table><p>Regards,<br>Team</p>' +
'<table><tr><td><b>Contact</b></td><td>+91 00000 00000</td></tr></table></div>\n';
fs.writeFileSync(path.join(dataDir, 'real-demo-email.html'), demoHtml);

const demoTxt =
'Subject: Daily Report - Sales, Marketing, Operations\n\n' +
'Hi Sir,\n\nPlease find today\'s consolidated report below.\n\n' +
head.join(' | ') + '\n' +
demoRows.map(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]].join(' | ')).join('\n') +
'\n\nRegards,\nTeam\n';
fs.writeFileSync(path.join(dataDir, 'real-demo-email.txt'), demoTxt);

/* ---------------- sample data straight out of the pipeline ---------------- */
sandbox.setupSpreadsheet();
sandbox.loadSampleData();
sandbox.rebuildMetrics();

function csv(rows) {
  return rows.map(r => r.map(v => {
    if (v instanceof Date) return sandbox.fmtDate_(v);
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}
const exports_ = {
  'sample_tasks.csv': 'Tasks',
  'sample_employees.csv': 'Employees',
  'sample_departments.csv': 'Departments',
  'sample_categories.csv': 'Task_Categories',
  'sample_statuses.csv': 'Statuses',
  'sample_reports.csv': 'Reports',
  'sample_data_quality.csv': 'Data_Quality',
  'sample_daily_summary.csv': 'Daily_Summary',
  'sample_department_summary.csv': 'Department_Summary',
  'sample_employee_summary.csv': 'Employee_Summary',
  'sample_repeated_tasks.csv': 'Repeated_Tasks',
  'sample_slow_tasks.csv': 'Slow_Tasks',
  'sample_config.csv': 'Config'
};
Object.keys(exports_).forEach(file => {
  const sh = stubs.SS.getSheetByName(exports_[file]);
  if (!sh || sh.getLastRow() === 0) return;
  const rows = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  fs.writeFileSync(path.join(dataDir, file), csv(rows));
  console.log(file.padEnd(32) + (rows.length - 1) + ' rows');
});

const rep = sandbox.generateDailyReport();
fs.writeFileSync(path.join(dataDir, 'Example_Daily_Report.txt'), rep.report + '\n');
fs.writeFileSync(path.join(dataDir, 'Example_System_Status.txt'), sandbox.showSystemStatus() + '\n');
console.log('Example_Daily_Report.txt / Example_System_Status.txt written');
console.log('test-emails: ' + (Object.keys(fixtures).length + 1) + ' fixtures written');
