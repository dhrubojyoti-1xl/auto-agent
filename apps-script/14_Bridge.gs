/**
 * ============================================================================
 * 14_Bridge.gs — OPTIONAL: forward Gmail reports to the hosted web app.
 * ============================================================================
 * The Apps Script system is complete on its own. This file exists for the
 * hybrid setup:
 *
 *     Gmail  ->  Apps Script (has Gmail access)  ->  HTTPS POST  ->  Vercel
 *                                                                     |
 *                                                                  Supabase
 *
 * Why this shape: only Google can read a Gmail inbox, and only after YOU grant
 * consent. Rather than asking you to grant a second app that access, the script
 * you have already authorised forwards the raw email to the web app's /api/ingest
 * endpoint. Nothing else changes.
 *
 * Configure on the Config sheet:
 *   BRIDGE_ENABLED   TRUE
 *   BRIDGE_URL       https://<your-app>.vercel.app/api/ingest
 * and store the shared secret once, from the editor:
 *   setBridgeToken()          (it goes into Script Properties, never a cell)
 *
 * The bridge is additive: rows still land in the Sheet as normal. Set
 * BRIDGE_ONLY = TRUE if you want the web app to be the only database.
 * ============================================================================
 */

const BRIDGE_TOKEN_PROPERTY = 'BRIDGE_INGEST_TOKEN';

/** Run once from the editor. The token never touches the spreadsheet. */
function setBridgeToken() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Ingest token',
    'Paste the INGEST_TOKEN configured in the web app. Stored in Script Properties.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const t = res.getResponseText().trim();
  if (!t) return;
  PropertiesService.getScriptProperties().setProperty(BRIDGE_TOKEN_PROPERTY, t);
  ui.alert('Stored. Set BRIDGE_ENABLED=TRUE and BRIDGE_URL on the Config sheet.');
}

function clearBridgeToken() {
  PropertiesService.getScriptProperties().deleteProperty(BRIDGE_TOKEN_PROPERTY);
}

function getBridgeToken_() {
  return PropertiesService.getScriptProperties().getProperty(BRIDGE_TOKEN_PROPERTY) || '';
}

/**
 * Posts one email to the web app. Returns the parsed response, or null when
 * the bridge is disabled or the call fails — a bridge failure must never stop
 * the Sheet from being updated.
 */
function bridgeSendDocument_(doc) {
  const cfg = getConfig();
  if (!cfg.BRIDGE_ENABLED || !cfg.BRIDGE_URL) return null;
  const token = getBridgeToken_();
  if (!token) {
    logWarn('Bridge', 'send', 'BRIDGE_ENABLED is TRUE but no token is stored. Run setBridgeToken().');
    return null;
  }
  try {
    const res = UrlFetchApp.fetch(cfg.BRIDGE_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        documentId: doc.emailId,          // the Gmail message id keeps it idempotent
        subject: doc.subject,
        sender: doc.from,
        receivedAt: doc.received ? doc.received.toISOString() : new Date().toISOString(),
        source: 'email',
        html: doc.html || '',
        text: doc.plain || ''
      }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    if (code !== 200) {
      logError('Bridge', 'send', 'HTTP ' + code + ': ' + truncate_(body, 300),
        { emailId: doc.emailId });
      return null;
    }
    const parsed = JSON.parse(body);
    logInfo('Bridge', 'send',
      'Web app imported ' + parsed.rowsInserted + ' row(s), ' +
      parsed.rowsSkippedIdempotent + ' already present, ' +
      parsed.rowsRejected + ' rejected',
      { emailId: doc.emailId, reportId: parsed.reportId });
    return parsed;
  } catch (e) {
    logError('Bridge', 'send', e.message, { emailId: doc.emailId });
    return null;
  }
}

/**
 * Forwards every email the Gmail search finds to the web app, WITHOUT writing
 * to this spreadsheet. Use this when the web app is your only database.
 *
 * Idempotency still holds end to end: the Gmail message id is the document id,
 * and the web app rejects fingerprints it already owns.
 */
function bridgeForwardNewReports() {
  const cfg = getConfig();
  if (!cfg.BRIDGE_ENABLED || !cfg.BRIDGE_URL) {
    logWarn('Bridge', 'forward', 'Bridge is disabled; nothing forwarded.');
    flushLog();
    return { forwarded: 0 };
  }
  const threads = GmailApp.search(cfg.SEARCH_QUERY, 0, cfg.MAX_EMAILS_PER_RUN);
  const labels = getLabels_(cfg);
  var forwarded = 0, failed = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      const gate = shouldProcessMessage_(msg, cfg);
      if (!gate.ok) return;
      var html = '', plain = '';
      try { html = msg.getBody() || ''; } catch (e) {}
      try { plain = msg.getPlainBody() || ''; } catch (e) {}
      const result = bridgeSendDocument_({
        emailId: msg.getId(), subject: msg.getSubject() || '', from: msg.getFrom() || '',
        received: msg.getDate(), html: html, plain: plain
      });
      if (result) {
        forwarded++;
        try {
          if (labels.processed) thread.addLabel(labels.processed);
          if (result.rowsRejected > 0 && labels.review) thread.addLabel(labels.review);
        } catch (e) { /* labelling is advisory */ }
      } else {
        failed++;
        try { if (labels.error) thread.addLabel(labels.error); } catch (e) {}
      }
    });
  });

  logInfo('Bridge', 'forward', 'Forwarded ' + forwarded + ' email(s), ' + failed + ' failed');
  flushLog();
  return { forwarded: forwarded, failed: failed };
}

/** Verifies the bridge without sending real mail. Safe to run any time. */
function testBridge() {
  const cfg = getConfig();
  const out = bridgeSendDocument_({
    emailId: 'BRIDGE-SELFTEST',
    subject: 'Daily Report - bridge self test',
    from: 'bridge@selftest.local',
    received: new Date(),
    html: '<table><tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th></tr>' +
          '<tr><td>' + fmtDate_(todayLocal_()) + '</td><td>Bridge Selftest</td>' +
          '<td>Verify bridge connectivity</td><td>Completed</td></tr></table>',
    plain: ''
  });
  const msg = out
    ? 'Bridge OK. The web app returned: ' + JSON.stringify(out) +
      '\n\nThis inserted ONE test row named "Bridge Selftest". Delete it from the ' +
      'web app once you are satisfied.'
    : 'Bridge FAILED. Check BRIDGE_URL on the Config sheet, the stored token ' +
      '(setBridgeToken), and System_Log for the HTTP status.';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  flushLog();
  return out;
}
