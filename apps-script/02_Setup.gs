/**
 * ============================================================================
 * 02_Setup.gs — one-click creation of the whole database.
 * ============================================================================
 * Run setupSpreadsheet() ONCE (menu: Department Reporting -> Setup System). It is idempotent: running it again repairs
 * missing tabs/headers and re-seeds only empty master tables. It never
 * deletes Tasks/Reports data.
 * ============================================================================
 */

function setupSpreadsheet() {
  const started = new Date();
  const ss = openSpreadsheet_();

  SHEET_ORDER.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { createSheetFromSchema_(name); return; }
    // repair headers non-destructively
    const want = SCHEMA[name].headers;
    const haveWidth = Math.max(sh.getLastColumn(), 1);
    const have = sh.getRange(1, 1, 1, haveWidth).getValues()[0].map(String);
    var same = have.length === want.length &&
      want.every(function (h, i) { return String(have[i]).trim() === h; });
    if (!same) {
      if (sh.getMaxColumns() < want.length) {
        sh.insertColumnsAfter(sh.getMaxColumns(), want.length - sh.getMaxColumns());
      }
      sh.getRange(1, 1, 1, want.length).setValues([want])
        .setFontWeight('bold').setBackground('#f1f3f4');
      sh.setFrozenRows(1);
    }
    applyFormats_(sh, name);
  });

  // Drop the default "Sheet1" if it is empty and unused.
  const s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0) ss.deleteSheet(s1);

  seedConfigSheet_();
  seedStatuses_();
  seedStatusAliases_();
  seedHeaderAliases_();
  seedDepartments_();
  seedCategories_();
  ensureGmailLabels_();
  addDataValidation_();

  SHEET_ORDER.forEach(function (n) { ss.getSheetByName(n).autoResizeColumns(1, Math.min(6, SCHEMA[n].headers.length)); });

  logInfo('Setup', 'setupSpreadsheet', 'Setup complete in ' +
    (new Date() - started) + 'ms across ' + SHEET_ORDER.length + ' sheets');
  flushLog();
  try {
    SpreadsheetApp.getUi().alert('Setup complete.\n\nSpreadsheet ID:\n' + ss.getId() +
      '\n\nNext: menu → "2. Load sample data" to see the pipeline work end to end.');
  } catch (e) { /* not run from the UI */ }
  return ss.getId();
}

/** Writes the Config tab only if empty, so operator edits are never clobbered. */
function seedConfigSheet_() {
  const sh = sheet_(SHEETS.CONFIG);
  if (sh.getLastRow() > 1) return;
  const notes = {
    SPREADSHEET_ID: 'Leave blank when the script is bound to this sheet.',
    SEARCH_QUERY: 'Gmail search that finds candidate report emails.',
    REPORT_LABEL: 'Label you apply (manually or via a Gmail filter) to report emails.',
    PROCESSED_LABEL: 'Applied by the script after a successful import.',
    ERROR_LABEL: 'Applied when the whole email failed to process.',
    REVIEW_LABEL: 'Applied when some rows were rejected but others imported.',
    MAX_EMAILS_PER_RUN: 'Safety cap per execution.',
    ALLOWED_SENDER_DOMAINS: 'Comma separated. Blank = accept any domain.',
    ALLOWED_SENDERS: 'Comma separated exact addresses. Blank = any.',
    SUBJECT_MUST_CONTAIN_ANY: 'Comma separated phrases. Blank = no subject filter.',
    DATE_ORDER: 'DMY or MDY — how to read ambiguous 04/05/2026 dates.',
    REJECT_UNKNOWN_STATUS: 'TRUE = park unknown statuses in Data_Quality.',
    SLOW_TASK_MULTIPLIER: 'Slow when Actual > Expected x this value.',
    REPEAT_RECURRING_MIN: 'Distinct dates before a task counts as Recurring.',
    REPEAT_HIGH_MIN: 'Occurrences before a task counts as Highly Repetitive.',
    AI_ENABLED: 'FALSE keeps the whole system working without any AI.',
    AI_PROVIDER: 'manual | gemini | custom_http',
    MANAGEMENT_EMAIL: 'Where to email the summary. Blank = do not email.',
    BRIDGE_ENABLED: 'TRUE = also post each email to the hosted web app.',
    BRIDGE_URL: 'https://<your-app>.vercel.app/api/ingest',
    BRIDGE_ONLY: 'TRUE = send to the web app only, do not write to this Sheet.',
    TRIGGER_INGEST_EVERY_MINUTES: '0 disables the ingest trigger. Else 5/10/15/30/60.'
  };
  const rows = Object.keys(DEFAULT_CONFIG).map(function (k) {
    var v = DEFAULT_CONFIG[k];
    if (Array.isArray(v)) v = v.join(',');
    if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
    return [k, v, notes[k] || ''];
  });
  appendRows_(SHEETS.CONFIG, rows);
}

function seedStatuses_() {
  const sh = sheet_(SHEETS.STATUS);
  if (sh.getLastRow() > 1) return;
  // Status | Active | Counts_As_Completed | Is_Terminal | Sort_Order
  appendRows_(SHEETS.STATUS, [
    ['Completed',   'TRUE', 'TRUE',  'TRUE',  1],
    ['In Progress', 'TRUE', 'FALSE', 'FALSE', 2],
    ['Pending',     'TRUE', 'FALSE', 'FALSE', 3],
    ['Blocked',     'TRUE', 'FALSE', 'FALSE', 4],
    ['Not Started', 'TRUE', 'FALSE', 'FALSE', 5],
    ['Cancelled',   'TRUE', 'FALSE', 'TRUE',  6]
  ]);
}

/** Alias -> canonical status. Extend by adding rows to the sheet, not code. */
function seedStatusAliases_() {
  const sh = sheet_(SHEETS.STATUS_ALIAS);
  if (sh.getLastRow() > 1) return;
  const map = {
    'completed': 'Completed', 'complete': 'Completed', 'done': 'Completed',
    'finished': 'Completed', 'closed': 'Completed', 'delivered': 'Completed',
    'completd': 'Completed', 'compeleted': 'Completed', 'yes': 'Completed',
    'ok': 'Completed', 'over': 'Completed', '100%': 'Completed', 'c': 'Completed',
    'in progress': 'In Progress', 'inprogress': 'In Progress', 'in-progress': 'In Progress',
    'progress': 'In Progress', 'ongoing': 'In Progress', 'wip': 'In Progress',
    'working': 'In Progress', 'started': 'In Progress', 'doing': 'In Progress',
    'partially done': 'In Progress', 'partial': 'In Progress', 'ip': 'In Progress',
    'pending': 'Pending', 'waiting': 'Pending', 'not done': 'Pending',
    'incomplete': 'Pending', 'open': 'Pending', 'todo': 'Pending',
    'to do': 'Pending', 'hold': 'Pending', 'on hold': 'Pending', 'p': 'Pending',
    'blocked': 'Blocked', 'stuck': 'Blocked', 'blocker': 'Blocked',
    'dependency': 'Blocked', 'waiting on client': 'Blocked', 'awaiting approval': 'Blocked',
    'not started': 'Not Started', 'notstarted': 'Not Started', 'new': 'Not Started',
    'yet to start': 'Not Started', 'not yet started': 'Not Started', 'ns': 'Not Started',
    'cancelled': 'Cancelled', 'canceled': 'Cancelled', 'dropped': 'Cancelled',
    'not required': 'Cancelled', 'na': 'Cancelled', 'n/a': 'Cancelled'
  };
  appendRows_(SHEETS.STATUS_ALIAS, Object.keys(map).map(function (k) { return [k, map[k]]; }));
}

/** Table header text -> canonical field. Extend via the sheet. */
function seedHeaderAliases_() {
  const sh = sheet_(SHEETS.HEADER_ALIAS);
  if (sh.getLastRow() > 1) return;
  const map = {
    'date': FIELDS.DATE, 'task date': FIELDS.DATE, 'report date': FIELDS.DATE,
    'dt': FIELDS.DATE, 'day': FIELDS.DATE, 'work date': FIELDS.DATE,
    'employee': FIELDS.EMPLOYEE, 'employee name': FIELDS.EMPLOYEE, 'name': FIELDS.EMPLOYEE,
    'staff': FIELDS.EMPLOYEE, 'team member': FIELDS.EMPLOYEE, 'member': FIELDS.EMPLOYEE,
    'assigned to': FIELDS.EMPLOYEE, 'owner': FIELDS.EMPLOYEE, 'resource': FIELDS.EMPLOYEE,
    'emp name': FIELDS.EMPLOYEE, 'person': FIELDS.EMPLOYEE,
    'employee id': FIELDS.EMPLOYEE_ID, 'emp id': FIELDS.EMPLOYEE_ID, 'empid': FIELDS.EMPLOYEE_ID,
    'department': FIELDS.DEPARTMENT, 'dept': FIELDS.DEPARTMENT, 'team': FIELDS.DEPARTMENT,
    'division': FIELDS.DEPARTMENT, 'function': FIELDS.DEPARTMENT,
    'task': FIELDS.TASK, 'task name': FIELDS.TASK, 'work': FIELDS.TASK,
    'work done': FIELDS.TASK, 'activity': FIELDS.TASK, 'description': FIELDS.TASK,
    'task description': FIELDS.TASK, 'details': FIELDS.TASK, 'particulars': FIELDS.TASK,
    'job': FIELDS.TASK, 'work item': FIELDS.TASK, 'today task': FIELDS.TASK,
    "today's task": FIELDS.TASK, 'tasks': FIELDS.TASK,
    'category': FIELDS.CATEGORY, 'task category': FIELDS.CATEGORY, 'type': FIELDS.CATEGORY,
    'task type': FIELDS.CATEGORY,
    'status': FIELDS.STATUS, 'task status': FIELDS.STATUS, 'current status': FIELDS.STATUS,
    'progress': FIELDS.STATUS, 'state': FIELDS.STATUS, 'completion': FIELDS.STATUS,
    'priority': FIELDS.PRIORITY, 'urgency': FIELDS.PRIORITY,
    'start date': FIELDS.START_DATE, 'started on': FIELDS.START_DATE,
    'start time': FIELDS.START_TIME, 'start': FIELDS.START_TIME, 'from': FIELDS.START_TIME,
    'completion date': FIELDS.COMPLETION_DATE, 'end date': FIELDS.COMPLETION_DATE,
    'completed on': FIELDS.COMPLETION_DATE,
    'completion time': FIELDS.COMPLETION_TIME, 'end time': FIELDS.COMPLETION_TIME,
    'finish time': FIELDS.COMPLETION_TIME, 'to': FIELDS.COMPLETION_TIME,
    'expected duration': FIELDS.EXPECTED_DURATION, 'estimated hours': FIELDS.EXPECTED_DURATION,
    'estimate': FIELDS.EXPECTED_DURATION, 'planned hours': FIELDS.EXPECTED_DURATION,
    'actual duration': FIELDS.ACTUAL_DURATION, 'hours spent': FIELDS.ACTUAL_DURATION,
    'time taken': FIELDS.ACTUAL_DURATION, 'hours': FIELDS.ACTUAL_DURATION,
    'link': FIELDS.LINK, 'links': FIELDS.LINK, 'url': FIELDS.LINK, 'reference': FIELDS.LINK,
    'attachment': FIELDS.LINK, 'proof': FIELDS.LINK, 'doc link': FIELDS.LINK,
    'remarks': FIELDS.NOTES, 'notes': FIELDS.NOTES, 'comment': FIELDS.NOTES,
    'comments': FIELDS.NOTES, 'observation': FIELDS.NOTES
  };
  appendRows_(SHEETS.HEADER_ALIAS, Object.keys(map).map(function (k) { return [k, map[k]]; }));
}

function seedDepartments_() {
  const sh = sheet_(SHEETS.DEPARTMENTS);
  if (sh.getLastRow() > 1) return;
  appendRows_(SHEETS.DEPARTMENTS, [
    ['DEP-01', 'Sales',      'sales team,bd,business development', 'Anita Rao',   '', '', 'TRUE'],
    ['DEP-02', 'Marketing',  'mktg,growth,brand',                  'Vikram Shah', '', '', 'TRUE'],
    ['DEP-03', 'Operations', 'ops,operation,service delivery',     'Farhan Ali',  '', '', 'TRUE'],
    ['DEP-99', 'Unassigned', '',                                   '',            '', '', 'TRUE']
  ]);
}

function seedCategories_() {
  const sh = sheet_(SHEETS.CATEGORIES);
  if (sh.getLastRow() > 1) return;
  // Expected_Duration is in HOURS. Leave blank when you genuinely do not know —
  // the system reports "Insufficient Data" rather than inventing a number.
  appendRows_(SHEETS.CATEGORIES, [
    ['CAT-01', 'CRM Update',        'crm,salesforce,zoho,pipeline update',        0.5, 'TRUE', ''],
    ['CAT-02', 'Client Call',       'client call,customer call,demo call,meeting with client', 1, 'TRUE', ''],
    ['CAT-03', 'Proposal',          'proposal,quotation,quote,estimate,pitch deck', 3, 'TRUE', ''],
    ['CAT-04', 'Reporting',         'daily report,mis,report preparation,dashboard update', 1, 'TRUE', ''],
    ['CAT-05', 'Content Creation',  'blog,social post,creative,copy,newsletter',   4, 'TRUE', ''],
    ['CAT-06', 'Campaign Setup',    'campaign,ads,adwords,meta ads,google ads',    2.5, 'TRUE', ''],
    ['CAT-07', 'Order Processing',  'order,dispatch,invoice,shipment,packing',     0.75, 'TRUE', ''],
    ['CAT-08', 'Vendor Coordination','vendor,supplier,procurement,purchase order', 1.5, 'TRUE', ''],
    ['CAT-09', 'Support Ticket',    'ticket,support,complaint,escalation',         1, 'TRUE', ''],
    ['CAT-10', 'Internal Meeting',  'standup,internal meeting,review meeting,sync', 1, 'TRUE', ''],
    ['CAT-11', 'Documentation',     'sop,documentation,process doc,manual',        2, 'TRUE', ''],
    ['CAT-12', 'Data Entry',        'data entry,excel,sheet update,upload',        1, 'TRUE', ''],
    ['CAT-99', 'Uncategorised',     '',                                            '',  'TRUE',
      'Blank expected duration on purpose: unknown work must not be judged slow.']
  ]);
}

function ensureGmailLabels_() {
  const cfg = getConfig();
  [cfg.REPORT_LABEL, cfg.PROCESSED_LABEL, cfg.ERROR_LABEL, cfg.REVIEW_LABEL]
    .filter(function (n) { return n; })
    .forEach(function (name) {
      try {
        if (!GmailApp.getUserLabelByName(name)) GmailApp.createLabel(name);
      } catch (e) {
        logWarn('Setup', 'ensureGmailLabels', 'Could not create label ' + name + ': ' + e.message);
      }
    });
}

function addDataValidation_() {
  const ss = openSpreadsheet_();
  const rej = ss.getSheetByName(SHEETS.DATA_QUALITY);
  const c = col(SHEETS.DATA_QUALITY, 'Resolution_Status') + 1;
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Open', 'Fixed in source', 'Re-imported', 'Ignored'], true)
    .setAllowInvalid(true).build();
  rej.getRange(2, c, Math.max(rej.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

/** Deletes demo/transactional rows. Master data and Config are preserved. */
function clearTransactionalData() {
  var ok = true;
  try {
    ok = SpreadsheetApp.getUi().alert(
      'Clear Tasks, Reports, Data_Quality, all summaries and AI outputs?\n' +
      'Master data and Config are kept.',
      SpreadsheetApp.getUi().ButtonSet.YES_NO) === SpreadsheetApp.getUi().Button.YES;
  } catch (e) { /* headless */ }
  if (!ok) return;
  [SHEETS.TASKS, SHEETS.REPORTS, SHEETS.DATA_QUALITY, SHEETS.DAILY, SHEETS.WEEKLY,
   SHEETS.MONTHLY, SHEETS.DEPT_SUMMARY, SHEETS.EMP_SUMMARY, SHEETS.REPEATED,
   SHEETS.SLOW, SHEETS.AI_REPORTS, SHEETS.AI_DATASET].forEach(function (n) {
    replaceAll_(n, []);
  });
  PropertiesService.getScriptProperties().deleteProperty('PROCESSED_EMAIL_IDS');
  logWarn('Setup', 'clearTransactionalData', 'Transactional data cleared by operator');
  flushLog();
}
