/**
 * ============================================================================
 * 13_Tests.gs — self-tests, email fixtures and the sample-data loader.
 * ============================================================================
 * These tests are DRY-RUN: they exercise the real extraction, normalisation,
 * validation and deduplication code paths but write nothing to Tasks,
 * Reports or Data_Quality. Results go to the execution log and a dialog.
 * ============================================================================
 */

function runAllTests() {
  Masters.load(true);
  const cfg = getConfig();
  const R = [];
  function test(name, fn) {
    try { fn(); R.push({ name: name, pass: true }); }
    catch (e) { R.push({ name: name, pass: false, error: e.message }); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function eq(a, b, msg) {
    if (String(a) !== String(b)) throw new Error((msg || 'expected') + ' "' + b + '" but got "' + a + '"');
  }

  /* ---------------- unit: dates ---------------- */
  test('parseDate: ISO', function () { eq(fmtDate_(parseDate_('2026-08-29')), '2026-08-29'); });
  test('parseDate: 29 Aug 2026', function () { eq(fmtDate_(parseDate_('29 Aug 2026')), '2026-08-29'); });
  test('parseDate: Aug 29, 2026', function () { eq(fmtDate_(parseDate_('Aug 29, 2026')), '2026-08-29'); });
  test('parseDate: 29/08/2026 as DMY', function () { eq(fmtDate_(parseDate_('29/08/2026', 'DMY')), '2026-08-29'); });
  test('parseDate: 08/29/2026 disambiguates itself', function () { eq(fmtDate_(parseDate_('08/29/2026', 'DMY')), '2026-08-29'); });
  test('parseDate: 04/05/2026 honours MDY', function () { eq(fmtDate_(parseDate_('04/05/2026', 'MDY')), '2026-04-05'); });
  test('parseDate: 29th Aug 2026', function () { eq(fmtDate_(parseDate_('29th Aug 2026')), '2026-08-29'); });
  test('parseDate: rejects 32 Aug', function () { assert(parseDate_('32 Aug 2026') === null); });
  test('parseDate: rejects garbage', function () { assert(parseDate_('sometime next week') === null); });
  test('parseTime: 9:30 AM', function () { eq(parseTime_('9:30 AM'), '09:30'); });
  test('parseTime: 17.45', function () { eq(parseTime_('17.45'), '17:45'); });

  /* ---------------- unit: statuses ---------------- */
  test('status: Done -> Completed', function () { eq(Masters.normalizeStatus('Done'), 'Completed'); });
  test('status: finished -> Completed', function () { eq(Masters.normalizeStatus('  FINISHED '), 'Completed'); });
  test('status: WIP -> In Progress', function () { eq(Masters.normalizeStatus('WIP'), 'In Progress'); });
  test('status: Waiting -> Pending', function () { eq(Masters.normalizeStatus('Waiting'), 'Pending'); });
  test('status: Not Done -> Pending', function () { eq(Masters.normalizeStatus('Not Done'), 'Pending'); });
  test('status: unknown returns null', function () { assert(Masters.normalizeStatus('Compleeted!!') === null); });

  /* ---------------- unit: task normalisation ---------------- */
  test('task normalise: case + punctuation', function () {
    eq(normalizeTask_('Update CRM!!'), normalizeTask_('update crm'));
  });
  test('task normalise: keeps different tasks apart', function () {
    assert(normalizeTask_('Update CRM') !== normalizeTask_('Update website'));
  });
  test('task similarity: word order tolerant', function () {
    assert(tokenSimilarity_(taskTokens_(normalizeTask_('Prepare daily report')),
                            taskTokens_(normalizeTask_('Daily report preparation'))) < 1);
  });

  /* ---------------- unit: HTML tables ---------------- */
  test('T1 perfect report parses 3 rows', function () {
    const t = extractTables_(TEST_EMAILS.T1_PERFECT);
    const rt = t.filter(function (x) { return mapHeaderRow_(x.rows); });
    assert(rt.length >= 1, 'no report table found');
    const h = mapHeaderRow_(rt[0].rows);
    eq(rt[0].rows.length - h.headerRowIndex - 1, 3, 'data row count');
  });
  test('T2 reordered columns map correctly', function () {
    const t = extractTables_(TEST_EMAILS.T2_REORDERED);
    const h = mapHeaderRow_(t[0].rows);
    assert(h, 'header not detected');
    assert(h.mapping[FIELDS.EMPLOYEE] === 0 && h.mapping[FIELDS.DATE] === 1, 'mapping wrong');
  });
  test('T6 multiple tables: both report tables found, signature ignored', function () {
    const t = extractTables_(TEST_EMAILS.T6_MULTI_TABLE);
    const rt = t.filter(function (x) { return mapHeaderRow_(x.rows); });
    eq(rt.length, 2, 'report table count');
  });
  test('nested layout table does not duplicate rows', function () {
    const t = extractTables_(TEST_EMAILS.T1_PERFECT);
    var totalDataRows = 0;
    t.forEach(function (x) {
      const h = mapHeaderRow_(x.rows);
      if (h) totalDataRows += x.rows.length - h.headerRowIndex - 1;
    });
    eq(totalDataRows, 3, 'rows counted once');
  });
  test('colspan/rowspan grid stays aligned', function () {
    const t = extractTables_(TEST_EMAILS.T11_SPANS);
    const h = mapHeaderRow_(t[0].rows);
    assert(h, 'header not detected with spans');
    const row = t[0].rows[h.headerRowIndex + 1];
    eq(row[h.mapping[FIELDS.EMPLOYEE]].text, 'Rahul Mehta');
  });
  test('plain-text pipe table parses', function () {
    const t = extractPipeTables_(TEST_EMAILS.T12_PIPE_TEXT);
    assert(t.length === 1, 'expected one pipe table');
    const h = mapHeaderRow_(t[0].rows);
    assert(h, 'pipe header not mapped');
    eq(t[0].rows.length - h.headerRowIndex - 1, 2);
  });

  /* ---------------- integration: dry-run ingestion ---------------- */
  function dry(id, html, subject) {
    const state = { fingerprints: {}, terminalEmailIds: {} };
    return {
      state: state,
      result: ingestDocument_({
        emailId: id, threadId: id, subject: subject || 'Daily Report',
        from: 'Tester <tester@example.com>', received: new Date(),
        html: html, plain: '', dryRun: true
      }, state, cfg)
    };
  }

  test('T1 imports 3 valid rows, rejects none', function () {
    const r = dry('T1', TEST_EMAILS.T1_PERFECT).result;
    eq(r.inserted, 3, 'inserted'); eq(r.rejected, 0, 'rejected');
  });
  test('T3 missing optional Link still imports', function () {
    const r = dry('T3', TEST_EMAILS.T3_MISSING_OPTIONAL).result;
    eq(r.inserted, 2, 'inserted'); eq(r.rejected, 0, 'rejected');
  });
  test('T4 one missing required field rejects only that row', function () {
    const r = dry('T4', TEST_EMAILS.T4_MISSING_REQUIRED).result;
    eq(r.inserted, 2, 'valid rows still imported');
    eq(r.rejected, 1, 'bad row rejected');
    eq(r.rejectedRows[0][7], 'MISSING_REQUIRED_FIELD');
  });
  test('T8 invalid status is rejected with a precise reason', function () {
    const r = dry('T8', TEST_EMAILS.T8_INVALID_STATUS).result;
    eq(r.rejected, 1); eq(r.rejectedRows[0][7], 'UNKNOWN_STATUS');
  });
  test('T9 invalid date is rejected with a precise reason', function () {
    const r = dry('T9', TEST_EMAILS.T9_INVALID_DATE).result;
    eq(r.rejected, 1); eq(r.rejectedRows[0][7], 'INVALID_DATE');
  });
  test('T7 legitimate same-day repeats are ALL kept', function () {
    const r = dry('T7', TEST_EMAILS.T7_REPEATED).result;
    eq(r.inserted, 4, 'three identical client calls plus one other must all import');
    eq(r.rejected, 0);
  });
  test('IDEMPOTENCY: same email twice inserts nothing the second time', function () {
    const state = { fingerprints: {}, terminalEmailIds: {} };
    const doc = { emailId: 'IDEM', threadId: 'IDEM', subject: 'Daily Report',
                  from: 'a@b.com', received: new Date(), html: TEST_EMAILS.T1_PERFECT,
                  plain: '', dryRun: true };
    const first = ingestDocument_(doc, state, cfg);
    const second = ingestDocument_(doc, state, cfg);
    eq(first.inserted, 3, 'first run');
    eq(second.inserted, 0, 'second run must insert nothing');
    eq(second.skipped, 3, 'second run must skip 3 as already present');
    eq(second.rejected, 0, 'a re-run is not an error');
  });
  test('DUPLICATE: same rows re-sent from a DIFFERENT email are rejected', function () {
    const state = { fingerprints: {}, terminalEmailIds: {} };
    const base = { threadId: 'X', subject: 'Daily Report', from: 'a@b.com',
                   received: new Date(), html: TEST_EMAILS.T1_PERFECT, plain: '', dryRun: true };
    base.emailId = 'ORIG';
    const first = ingestDocument_(base, state, cfg);
    const resend = { emailId: 'RESEND', threadId: 'Y', subject: 'Fwd: Daily Report',
                     from: 'c@d.com', received: new Date(), html: TEST_EMAILS.T1_PERFECT,
                     plain: '', dryRun: true };
    const second = ingestDocument_(resend, state, cfg);
    eq(first.inserted, 3);
    eq(second.inserted, 0, 'nothing should import from the resend');
    eq(second.rejected, 3, 'all three should be flagged duplicate');
    eq(second.rejectedRows[0][7], 'DUPLICATE_ACROSS_EMAILS');
  });
  test('T5 duplicate email content is caught, distinct rows still import', function () {
    const state = { fingerprints: {}, terminalEmailIds: {} };
    ingestDocument_({ emailId: 'T5A', threadId: 'T', subject: 'Daily Report', from: 'a@b.com',
      received: new Date(), html: TEST_EMAILS.T1_PERFECT, plain: '', dryRun: true }, state, cfg);
    const r = ingestDocument_({ emailId: 'T5B', threadId: 'T', subject: 'Daily Report (corrected)',
      from: 'a@b.com', received: new Date(), html: TEST_EMAILS.T5_DUPLICATE_PLUS_NEW,
      plain: '', dryRun: true }, state, cfg);
    eq(r.rejected, 3, 'the three repeated rows');
    eq(r.inserted, 1, 'the one genuinely new row');
  });
  test('T10 large report imports every row', function () {
    const r = dry('T10', TEST_EMAILS.T10_LARGE()).result;
    eq(r.inserted, 60); eq(r.rejected, 0);
  });
  test('non-report email yields NO_DATA, not an error', function () {
    const r = dry('NOISE', '<div><p>Hi, see attached.</p>' +
      '<table><tr><td>Regards</td><td>Ops</td></tr></table></div>').result;
    eq(r.status, 'NO_DATA'); eq(r.inserted, 0); eq(r.rejected, 0);
  });
  test('duration: derived from start/end times', function () {
    const d = computeDuration_(todayLocal_(), null, '09:00', null, '11:30', null);
    eq(d.hours, 2.5); eq(d.basis, 'Derived');
  });
  test('duration: no timestamps -> Insufficient Data, never a guess', function () {
    const d = computeDuration_(todayLocal_(), null, null, null, null, null);
    eq(d.basis, 'Insufficient Data'); assert(d.hours === null);
  });
  test('slow task needs BOTH expected and actual', function () {
    const rows = [['id', todayLocal_(), 'Sales', 'A', 'T', 'C', 'Completed', '', 5, '', '']];
    // build a Tasks-shaped row via the real writer to avoid index drift
    const rec = { taskId: 'x', reportId: 'r', date: todayLocal_(), department: 'Sales',
      employeeName: 'A', employeeId: 'E', task: 'T', taskNormalized: 't', category: '',
      status: 'Completed', priority: '', startDate: null, startTime: null, compDate: null,
      compTime: null, expected: null, actual: 5, durationBasis: 'Reported', link: '',
      emailId: 'e', emailDate: new Date(), quality: 'OK', qualityNotes: '',
      fingerprint: 'f', notes: '' };
    const out = analyzeSlowTasks_([taskRecordToRow_(rec)]);
    eq(out.flags[0], 'INSUFFICIENT_DATA');
  });
  test('AI validation rejects an invented department', function () {
    const ds = { totals: { completion_rate: 80 }, departments: [{ department: 'Sales' }],
                 slow_tasks: [], repeated_tasks: [] };
    const v = validateAiJson_({ summary: 's', overall_completion_rate: 80,
      department_observations: [{ department: 'Atlantis', observation: 'x' }],
      attention_items: [], slow_tasks: [], repeated_tasks: [], trends: [], data_quality: [] }, ds);
    assert(!v.ok, 'should not validate');
    eq(v.clean.department_observations.length, 0, 'invented department must be dropped');
  });
  test('AI validation overrides a wrong completion rate', function () {
    const ds = { totals: { completion_rate: 62.5 }, departments: [], slow_tasks: [], repeated_tasks: [] };
    const v = validateAiJson_({ summary: 's', overall_completion_rate: 91,
      department_observations: [], attention_items: [], slow_tasks: [],
      repeated_tasks: [], trends: [], data_quality: [] }, ds);
    eq(v.clean.overall_completion_rate, 62.5);
    assert(v.errors.length > 0);
  });
  test('percentage points are not percentages', function () { eq(ppChange_(85, 80), 5); });


  test('T13 extra/irrelevant columns are ignored, real ones still map', function () {
    const r = dry('T13', TEST_EMAILS.T13_EXTRA_COLUMNS).result;
    eq(r.inserted, 2, 'inserted'); eq(r.rejected, 0, 'rejected');
    eq(r.records[0].department, 'Operations', 'department column honoured');
    eq(r.records[0].priority, 'High', 'P1 normalised to High');
    eq(r.records[1].status, 'In Progress', 'WIP normalised');
    eq(r.records[0].notes, 'All dispatched', 'Remarks mapped to Notes');
  });
  test('T14 forwarded report imports, and "Fwd" is NOT treated as a department', function () {
    const r = ingestDocument_({
      emailId: 'FWD-1', threadId: 'FWD-1', subject: 'Fwd: Daily Report - Sales',
      from: 'Assistant <assistant@example.com>', received: new Date(),
      html: TEST_EMAILS.T14_FORWARDED, plain: '', dryRun: true
    }, { fingerprints: {}, terminalEmailIds: {} }, cfg);
    eq(r.inserted, 2, 'inserted');
    eq(r.records[0].department, 'Sales', 'department from the subject, not "Fwd"');
  });
  test('"FW:" and "Re:" prefixes are also ignored', function () {
    ['FW: Daily Report - Operations', 'Re: Daily Report - Operations',
     'RE: FW: Fwd: Daily Report - Operations'].forEach(function (subj) {
      const r = ingestDocument_({
        emailId: 'PFX-' + subj, threadId: 'x', subject: subj, from: 'a@b.com',
        received: new Date(), html: TEST_EMAILS.T14_FORWARDED, plain: '', dryRun: true
      }, { fingerprints: {}, terminalEmailIds: {} }, cfg);
      eq(r.records[0].department, 'Operations', 'subject "' + subj + '"');
    });
  });
  test('a subject with no known department never invents one', function () {
    const r = ingestDocument_({
      emailId: 'NODEPT', threadId: 'x', subject: 'Fwd: EOD update', from: 'a@b.com',
      received: new Date(), html: TEST_EMAILS.T14_FORWARDED, plain: '', dryRun: true
    }, { fingerprints: {}, terminalEmailIds: {} }, cfg);
    assert(r.records[0].department !== 'Fwd' && r.records[0].department !== 'EOD',
      'got department "' + r.records[0].department + '"');
  });
  test('T15 duration-based slow task is detected from timestamps', function () {
    const r = dry('T15', TEST_EMAILS.T15_DURATION_SLOW).result;
    eq(r.inserted, 2, 'inserted');
    eq(r.records[0].actual, 2.75, 'actual hours derived');
    eq(r.records[0].expected, 1, 'expected hours from Task_Categories');
    eq(r.records[0].durationBasis, 'Derived');
    const out = analyzeSlowTasks_(r.records.map(taskRecordToRow_));
    eq(out.flags[0], 'TRUE', '2.75h vs 1h expected exceeds the 1.5x threshold');
    eq(out.flags[1], 'FALSE', '1h vs 1h expected is not slow');
    eq(out.variances[0], 1.75, 'variance hours');
  });
  test('slow-task flag uses INSUFFICIENT_DATA when duration is unknown', function () {
    const r = dry('T15b', TEST_EMAILS.T1_PERFECT).result;
    const out = analyzeSlowTasks_(r.records.map(taskRecordToRow_));
    eq(out.flags[0], 'INSUFFICIENT_DATA');
  });
  test('repeat classification uses the documented labels', function () {
    const labels = ['Recurring / Legitimate', 'Potential Duplication',
                    'Highly Repetitive', 'Needs Review'];
    const state = { fingerprints: {}, terminalEmailIds: {} };
    const r = ingestDocument_({ emailId: 'RPT', threadId: 'x', subject: 'Daily Report',
      from: 'a@b.com', received: new Date(), html: TEST_EMAILS.T7_REPEATED,
      plain: '', dryRun: true }, state, cfg);
    const out = analyzeRepeatedTasks_(r.records.map(taskRecordToRow_));
    out.classes.filter(Boolean).forEach(function (c) {
      assert(labels.indexOf(c) >= 0, 'unexpected classification "' + c + '"');
    });
    assert(out.summaryRows.length > 0, 'expected at least one repeat group');
  });

  /* ---------------- report ---------------- */
  const passed = R.filter(function (r) { return r.pass; }).length;
  const failed = R.filter(function (r) { return !r.pass; });
  const lines = R.map(function (r) {
    return (r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '  -> ' + r.error);
  });
  const summary = passed + '/' + R.length + ' tests passed' +
    (failed.length ? ', ' + failed.length + ' FAILED' : '');
  console.log(summary + '\n' + lines.join('\n'));
  logEvent(failed.length ? 'ERROR' : 'INFO', 'Tests', 'runAllTests',
    failed.length ? 'FAIL' : 'OK', summary, { details: lines.join('\n') });
  flushLog();
  try {
    SpreadsheetApp.getUi().alert('Self-tests: ' + summary + '\n\n' +
      (failed.length ? failed.map(function (f) { return '• ' + f.name + ': ' + f.error; }).join('\n')
                     : 'All good. Nothing was written to Tasks/Reports.'));
  } catch (e) {}
  return { passed: passed, total: R.length, failures: failed };
}

/* ===========================================================================
 * TEST FIXTURES — realistic email bodies
 * =========================================================================*/
const TEST_EMAILS = {

  // 1. Perfect report, wrapped in a Gmail-style layout table + signature table
  T1_PERFECT:
  '<div dir="ltr"><table width="100%"><tr><td>' +
  '<p>Hi Sir,</p><p>Please find today\'s report.</p>' +
  '<table border="1" style="border-collapse:collapse">' +
  '<tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th><th>Link</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Rahul Mehta</td><td>Update CRM</td><td>Completed</td>' +
  '<td><a href="https://crm.example.com/1">link</a></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Priya Sharma</td><td>Follow up with Acme</td><td>In Progress</td><td></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Imran Khan</td><td>Send quotation to Delta</td><td>Pending</td><td></td></tr>' +
  '</table><p>Regards,<br>Sales</p>' +
  '<table><tr><td>Mobile</td><td>+91 00000 00000</td></tr><tr><td>Email</td><td>sales@example.com</td></tr></table>' +
  '</td></tr></table></div>',

  // 2. Different column order, different header wording
  T2_REORDERED:
  '<table><tr><th>Employee</th><th>Date</th><th>Work Done</th><th>Current Status</th><th>Reference</th></tr>' +
  '<tr><td>Neha Gupta</td><td>2026-08-29</td><td>Write blog post</td><td>Done</td><td>https://blog.example.com/1</td></tr>' +
  '<tr><td>Arjun Patel</td><td>2026-08-29</td><td>Google Ads optimisation</td><td>WIP</td><td></td></tr>' +
  '</table>',

  // 3. Optional field (Link) absent entirely
  T3_MISSING_OPTIONAL:
  '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th></tr>' +
  '<tr><td>29/08/2026</td><td>Vikas Nair</td><td>Process customer orders</td><td>Completed</td></tr>' +
  '<tr><td>29/08/2026</td><td>Deepa Iyer</td><td>Prepare daily report</td><td>done</td></tr>' +
  '</table>',

  // 4. One row missing a REQUIRED field
  T4_MISSING_REQUIRED:
  '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th><th>Link</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Rahul Mehta</td><td>Update CRM records</td><td>Completed</td><td></td></tr>' +
  '<tr><td>29 Aug 2026</td><td></td><td>Unowned cleanup task</td><td>Pending</td><td></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Imran Khan</td><td>Client call with Borex</td><td>Completed</td><td></td></tr>' +
  '</table>',

  // 5. Three rows identical to T1 plus one new row
  T5_DUPLICATE_PLUS_NEW:
  '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th><th>Link</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Rahul Mehta</td><td>Update CRM</td><td>Completed</td><td></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Priya Sharma</td><td>Follow up with Acme</td><td>In Progress</td><td></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Imran Khan</td><td>Send quotation to Delta</td><td>Pending</td><td></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Imran Khan</td><td>Prepare site visit plan</td><td>Not Started</td><td></td></tr>' +
  '</table>',

  // 6. Two report tables (two departments) plus an unrelated table
  T6_MULTI_TABLE:
  '<h3>Sales</h3><table><tr><th>Date</th><th>Employee</th><th>Task</th><th>Status</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Rahul Mehta</td><td>Update CRM</td><td>Completed</td></tr></table>' +
  '<h3>Attendance (ignore)</h3><table><tr><th>Present</th><th>Absent</th></tr>' +
  '<tr><td>18</td><td>2</td></tr></table>' +
  '<h3>Marketing</h3><table><tr><th>Date</th><th>Employee</th><th>Task</th><th>Status</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Neha Gupta</td><td>Write blog post</td><td>In Progress</td></tr></table>',

  // 7. Legitimate repeated tasks on the same day
  T7_REPEATED:
  '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Priya Sharma</td><td>Client call</td><td>Completed</td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Priya Sharma</td><td>Client call</td><td>Completed</td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Priya Sharma</td><td>Client call</td><td>Completed</td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Priya Sharma</td><td>Update CRM</td><td>Completed</td></tr>' +
  '</table>',

  // 8. Unmappable status
  T8_INVALID_STATUS:
  '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Rohit Verma</td><td>Stock audit</td><td>Compleeted!!</td></tr>' +
  '</table>',

  // 9. Unparseable date
  T9_INVALID_DATE:
  '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th></tr>' +
  '<tr><td>32 Aug 2026</td><td>Vikas Nair</td><td>Reconcile dispatch log</td><td>Completed</td></tr>' +
  '</table>',


  // 3. Extra/irrelevant columns around the real ones
  T13_EXTRA_COLUMNS:
  '<table><tr><th>S.No</th><th>Date</th><th>Department</th><th>Employee Name</th>' +
  '<th>Task</th><th>Task Category</th><th>Priority</th><th>Status</th>' +
  '<th>Link</th><th>Remarks</th><th>Approved By</th><th>Cost Centre</th></tr>' +
  '<tr><td>1</td><td>29 Aug 2026</td><td>Operations</td><td>Vikas Nair</td>' +
  '<td>Process customer orders</td><td>Order Processing</td><td>P1</td><td>Completed</td>' +
  '<td>https://ops.example.com/1</td><td>All dispatched</td><td>Deepa</td><td>CC-114</td></tr>' +
  '<tr><td>2</td><td>29 Aug 2026</td><td>Operations</td><td>Rohit Verma</td>' +
  '<td>Dispatch shipments</td><td>Order Processing</td><td>High</td><td>WIP</td>' +
  '<td></td><td>Awaiting vehicle</td><td>Deepa</td><td>CC-114</td></tr>' +
  '</table>',

  // 7. Forwarded report — "Fwd:", "FW:" and "Re:" must NEVER become a department
  T14_FORWARDED:
  '<div dir="ltr"><p>FYI, forwarding the sales report below.</p>' +
  '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid">' +
  '<div dir="ltr"><p>Hi Sir,</p>' +
  '<table border="1"><tr><th>Date</th><th>Employee Name</th><th>Task</th>' +
  '<th>Status</th><th>Link</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Rahul Mehta</td><td>Update CRM</td><td>Completed</td><td></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Priya Sharma</td><td>Follow up with Acme</td><td>Pending</td><td></td></tr>' +
  '</table><p>Regards,<br>Sales</p></div></blockquote></div>',

  // 12. Duration-based slow task — real timestamps, so it CAN be measured
  T15_DURATION_SLOW:
  '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th>' +
  '<th>Start Time</th><th>End Time</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Imran Khan</td><td>Client call - Corvin onboarding</td>' +
  '<td>Completed</td><td>15:00</td><td>17:45</td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Imran Khan</td><td>Client call - Borex renewal</td>' +
  '<td>Completed</td><td>11:00</td><td>12:00</td></tr>' +
  '</table>',

  // 11. colspan / rowspan
  T11_SPANS:
  '<table><tr><th colspan="2">Report</th><th></th><th></th></tr>' +
  '<tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th></tr>' +
  '<tr><td rowspan="2">29 Aug 2026</td><td>Rahul Mehta</td><td>Update CRM</td><td>Completed</td></tr>' +
  '<tr><td>Priya Sharma</td><td>Follow up with Acme</td><td>Pending</td></tr>' +
  '</table>',

  // 12. Plain-text pipe table (the exact acceptance-test shape)
  T12_PIPE_TEXT:
  'Hi team, todays report:\n\n' +
  'Date | Employee | Task | Status | Link\n' +
  '29 Aug 2026 | Rahul Mehta | Update CRM | Completed | https://crm.example.com/1\n' +
  '29 Aug 2026 | Priya Sharma | Follow up with Acme | Pending |\n\n' +
  'Regards\n',

  // 10. Large report — generated so the fixture stays readable
  T10_LARGE: function () {
    const people = ['Rahul Mehta', 'Priya Sharma', 'Imran Khan', 'Neha Gupta', 'Arjun Patel',
                    'Sana Qureshi', 'Vikas Nair', 'Deepa Iyer', 'Rohit Verma', 'Ayesha Siddiqui'];
    const statuses = ['Completed', 'In Progress', 'Pending', 'Done', 'WIP', 'Blocked'];
    var rows = '';
    for (var i = 0; i < 60; i++) {
      rows += '<tr><td>' + (20 + (i % 5)) + ' Aug 2026</td><td>' + people[i % 10] +
        '</td><td>Task item number ' + i + '</td><td>' + statuses[i % 6] + '</td><td></td></tr>';
    }
    return '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th><th>Link</th></tr>' +
      rows + '</table>';
  }
};


/* ===========================================================================
 * SAMPLE DATA
 * ---------------------------------------------------------------------------
 * loadSampleData() does NOT write to Tasks directly. It builds real HTML
 * emails and pushes them through ingestDocument_() — the same parser,
 * validator, normaliser and deduplicator that live email uses.
 * =========================================================================*/

function loadSampleData() {
  const cfg = getConfig();
  Masters.load(true);
  seedSampleEmployees_();
  Masters.load(true);

  const state = loadIngestState_();
  const docs = buildSampleDocuments_();
  var inserted = 0, rejected = 0, skipped = 0;

  docs.forEach(function (doc) {
    if (state.terminalEmailIds[doc.emailId]) return;
    const r = ingestDocument_(doc, state, cfg);
    inserted += r.inserted; rejected += r.rejected; skipped += r.skipped;
  });

  Masters.flushNewMasters();
  rebuildMetrics();

  const msg = 'Sample data loaded: ' + inserted + ' task rows inserted, ' +
    rejected + ' rows rejected on purpose (see ' + SHEETS.REJECTED + '), ' +
    skipped + ' skipped as already present.';
  logInfo('SampleData', 'load', msg);
  flushLog();
  try { SpreadsheetApp.getUi().alert(msg + '\n\nRun it again — nothing will be duplicated.'); } catch (e) {}
  return { inserted: inserted, rejected: rejected, skipped: skipped };
}

function seedSampleEmployees_() {
  const sh = sheet_(SHEETS.EMPLOYEES);
  if (sh.getLastRow() > 1) return;
  appendRows_(SHEETS.EMPLOYEES, [
    ['EMP-001', 'Rahul Mehta',    'rahul,rahul m',      'Sales',      'TRUE', '2024-04-01', 'Sales Executive',   ''],
    ['EMP-002', 'Priya Sharma',   'priya',              'Sales',      'TRUE', '2023-11-15', 'Key Account Manager', ''],
    ['EMP-003', 'Imran Khan',     'imran',              'Sales',      'TRUE', '2025-01-06', 'Sales Executive',   ''],
    ['EMP-004', 'Neha Gupta',     'neha',               'Marketing',  'TRUE', '2024-07-22', 'Content Lead',      ''],
    ['EMP-005', 'Arjun Patel',    'arjun,arjun p',      'Marketing',  'TRUE', '2025-03-03', 'Performance Marketer', ''],
    ['EMP-006', 'Sana Qureshi',   'sana',               'Marketing',  'TRUE', '2024-09-09', 'Designer',          ''],
    ['EMP-007', 'Vikas Nair',     'vikas',              'Operations', 'TRUE', '2022-06-13', 'Ops Executive',     ''],
    ['EMP-008', 'Deepa Iyer',     'deepa',              'Operations', 'TRUE', '2023-02-20', 'Ops Coordinator',   ''],
    ['EMP-009', 'Rohit Verma',    'rohit',              'Operations', 'TRUE', '2025-05-05', 'Dispatch Executive', ''],
    ['EMP-010', 'Ayesha Siddiqui','ayesha,ayesha s',    'Operations', 'TRUE', '2024-12-01', 'Support Executive', '']
  ]);
}

/** d0 = most recent business day used by the demo (today). */
function sampleDates_() {
  const out = [];
  var d = todayLocal_();
  while (out.length < 5) {
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(new Date(d.getTime()));
    d = addDays_(d, -1);
  }
  return out.reverse();      // oldest first
}

function fmtSample_(d) { return Utilities.formatDate(d, tz_(), 'dd MMM yyyy'); }

/**
 * Rows are [date, employee, task, status, link, startTime, endTime].
 * Times are only supplied where a genuine duration is being demonstrated.
 */
function buildSampleDocuments_() {
  const D = sampleDates_();
  const docs = [];

  // ---------------- SALES ----------------
  const sales = [];
  D.forEach(function (d, i) {
    sales.push([d, 'Rahul Mehta', 'Update CRM with new leads', 'Completed', 'https://crm.example.com/leads/' + (100 + i), '09:15', '09:50']);
    sales.push([d, 'Priya Sharma', 'Follow up with key account ' + ['Acme', 'Borex', 'Corvin', 'Delta', 'Everest'][i], i % 3 === 0 ? 'Completed' : 'In Progress', '', '', '']);
  });
  sales.push([D[0], 'Rahul Mehta', 'Prepare proposal for Acme Ltd', 'In Progress', 'https://docs.example.com/prop-acme', '10:00', '17:30']); // slow: 7.5h vs 3h
  sales.push([D[1], 'Imran Khan', 'Client call - Borex renewal', 'Completed', '', '11:00', '12:00']);
  sales.push([D[2], 'Imran Khan', 'Client call - Corvin onboarding', 'Completed', '', '15:00', '17:45']);   // slow: 2.75h vs 1h
  sales.push([D[3], 'Imran Khan', 'Send quotation to Delta Industries', 'Pending', '', '', '']);
  sales.push([D[4], 'Imran Khan', 'Send quotation to Delta Industries', 'Blocked', '', '', '']);
  // Same-day repeats — legitimate multiple client calls, must NOT be dropped
  sales.push([D[4], 'Priya Sharma', 'Client call', 'Completed', '', '', '']);
  sales.push([D[4], 'Priya Sharma', 'Client call', 'Completed', '', '', '']);
  sales.push([D[4], 'Priya Sharma', 'Client call', 'In Progress', '', '', '']);
  docs.push(sampleDoc_('SAMPLE-SALES-01', 'Sales - Daily Report ' + fmtSample_(D[4]),
    'Rahul Mehta <rahul.mehta@example.com>', D[4], sales, { department: 'Sales' }));

  // ---------------- MARKETING (different column order + a category column) ----
  const mkt = [];
  D.forEach(function (d, i) {
    mkt.push([d, 'Neha Gupta', 'Write blog post: ' + ['SEO basics', 'Case study Acme', 'Product update', 'Customer story', 'Industry roundup'][i], i < 3 ? 'Completed' : 'In Progress', '', '', '']);
    mkt.push([d, 'Arjun Patel', 'Google Ads campaign optimisation', i % 2 ? 'Completed' : 'In Progress', 'https://ads.example.com/c/' + i, '', '']);
  });
  mkt.push([D[0], 'Sana Qureshi', 'Design creatives for festive campaign', 'In Progress', '', '09:30', '18:00']); // slow vs 4h
  mkt.push([D[1], 'Sana Qureshi', 'Design social post pack', 'Completed', '', '10:00', '13:00']);
  mkt.push([D[2], 'Sana Qureshi', 'Design social post pack', 'Completed', '', '10:00', '12:30']);
  mkt.push([D[3], 'Neha Gupta', 'Newsletter draft', 'Not Started', '', '', '']);
  mkt.push([D[4], 'Arjun Patel', 'Meta ads budget review', 'Cancelled', '', '', '']);
  docs.push(sampleDoc_('SAMPLE-MKT-01', 'Daily Report - Marketing ' + fmtSample_(D[4]),
    'Neha Gupta <neha.gupta@example.com>', D[4], mkt, { department: 'Marketing', order: 'alt' }));

  // ---------------- OPERATIONS (messy statuses + repetitive reporting task) ---
  const ops = [];
  D.forEach(function (d, i) {
    ops.push([d, 'Deepa Iyer', 'Prepare daily report', 'Done', '', '', '']);
    ops.push([d, 'Deepa Iyer', 'Prepare Daily Report', 'done', '', '', '']);
    ops.push([d, 'Vikas Nair', 'Process customer orders', i === 2 ? 'Waiting' : 'Completed',
              '', '08:45', i === 2 ? '' : (i === 0 ? '10:15' : '09:15')]);
    ops.push([d, 'Rohit Verma', 'Dispatch shipments', i === 4 ? 'In progress' : 'Complete', '', '', '']);
  });
  ops.push([D[0], 'Ayesha Siddiqui', 'Resolve support ticket #4412', 'Completed', 'https://help.example.com/t/4412', '09:00', '11:30']);
  ops.push([D[1], 'Ayesha Siddiqui', 'Resolve support ticket #4419', 'Blocked', 'https://help.example.com/t/4419', '', '']);
  ops.push([D[2], 'Ayesha Siddiqui', 'Vendor coordination for packaging', 'WIP', '', '', '']);
  ops.push([D[3], 'Vikas Nair', 'Update SOP documentation', 'Not started', '', '', '']);
  docs.push(sampleDoc_('SAMPLE-OPS-01', 'Operations Department Report ' + fmtSample_(D[4]),
    'Deepa Iyer <deepa.iyer@example.com>', D[4], ops, { department: 'Operations' }));

  // ---------------- DELIBERATELY INVALID ROWS ----------------
  const bad = [
    [D[2], 'Rohit Verma', 'Stock audit', 'Compleeted!!', '', '', ''],        // unknown status
    ['32 Aug 2026', 'Vikas Nair', 'Reconcile dispatch log', 'Completed', '', '', ''], // invalid date
    [D[2], '', 'Unassigned housekeeping task', 'Pending', '', '', ''],        // missing employee
    [D[2], 'Deepa Iyer', '', 'Completed', '', '', ''],                        // missing task
    [D[2], 'Deepa Iyer', 'Verify invoices', '', '', '', '']                   // missing status
  ];
  docs.push(sampleDoc_('SAMPLE-BAD-01', 'Operations Report - problem rows ' + fmtSample_(D[2]),
    'Deepa Iyer <deepa.iyer@example.com>', D[2], bad, { department: 'Operations' }));

  // ---------------- RE-SENT SALES EMAIL (duplicate protection demo) ----------
  docs.push(sampleDoc_('SAMPLE-SALES-01-RESEND', 'Fwd: Sales - Daily Report ' + fmtSample_(D[4]),
    'Assistant <assistant@example.com>', D[4], sales, { department: 'Sales' }));

  return docs;
}

function sampleDoc_(id, subject, from, received, rows, opts) {
  return {
    emailId: id, threadId: id + '-T', subject: subject, from: from,
    received: received, html: sampleHtml_(rows, opts || {}), plain: ''
  };
}

/** Renders rows as an email-realistic HTML table wrapped in a layout table. */
function sampleHtml_(rows, opts) {
  const alt = opts.order === 'alt';
  const head = alt
    ? ['Employee Name', 'Date', 'Task Description', 'Status', 'Start Time', 'End Time', 'Link']
    : ['Date', 'Employee Name', 'Task', 'Status', 'Link', 'Start Time', 'End Time'];
  const body = rows.map(function (r) {
    const dateCell = (Object.prototype.toString.call(r[0]) === '[object Date]') ? fmtSample_(r[0]) : String(r[0]);
    const cells = alt
      ? [r[1], dateCell, r[2], r[3], r[5] || '', r[6] || '', r[4] ? '<a href="' + r[4] + '">link</a>' : '']
      : [dateCell, r[1], r[2], r[3], r[4] ? '<a href="' + r[4] + '">link</a>' : '', r[5] || '', r[6] || ''];
    return '<tr>' + cells.map(function (c) { return '<td style="border:1px solid #ccc;padding:6px">' + c + '</td>'; }).join('') + '</tr>';
  }).join('\n');

  return '<div dir="ltr"><table cellpadding="0" cellspacing="0" width="100%"><tr><td>' +
    '<p>Hi Team,</p><p>Please find below the report for ' +
    (opts.department || '') + '.</p>' +
    '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse">' +
    '<thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>' +
    '<tbody>' + body + '</tbody></table>' +
    '<p>Regards,<br>' + (opts.department || 'Team') + '</p>' +
    // A signature block that is itself a table — the parser must ignore it.
    '<table><tr><td><b>Contact</b></td><td>Phone</td></tr>' +
    '<tr><td>Office</td><td>+91 00000 00000</td></tr></table>' +
    '</td></tr></table></div>';
}
