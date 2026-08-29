/**
 * ============================================================================
 * 04_Gmail.gs — the Gmail transport layer.
 * ============================================================================
 * Everything that knows about Gmail lives here and nowhere else:
 *   - searching for candidate report emails
 *   - applying the configurable detection rules
 *   - managing the DAILY_REPORT / REPORT_PROCESSED / REPORT_ERROR labels
 *   - turning a GmailMessage into the generic "document" that 06_Ingest.gs
 *     understands
 *
 * That boundary is what lets the whole parser be tested locally without
 * sending a single email, and what would let a Google Form or a webhook feed
 * the same pipeline later with no downstream changes.
 * ============================================================================
 */

const GMAIL_COMPONENT = 'Gmail';

/** MAIN ENTRY POINT. Safe to run repeatedly; see the idempotency notes below. */
function processIncomingReports() {
  const t0 = new Date();
  const cfg = getConfig();
  Masters.load(true);

  const state = loadIngestState_();
  var threads = [];
  try {
    threads = GmailApp.search(cfg.SEARCH_QUERY, 0, cfg.MAX_EMAILS_PER_RUN);
  } catch (e) {
    logError(GMAIL_COMPONENT, 'search', 'Gmail search failed: ' + e.message,
      { details: cfg.SEARCH_QUERY });
    flushLog();
    throw e;
  }
  logInfo(GMAIL_COMPONENT, 'search', 'Query matched ' + threads.length + ' thread(s)',
    { details: cfg.SEARCH_QUERY });

  const labels = getLabels_(cfg);
  var processed = 0, inserted = 0, rejected = 0, skipped = 0, examined = 0;

  outer:
  for (var t = 0; t < threads.length; t++) {
    const msgs = threads[t].getMessages();
    for (var i = 0; i < msgs.length; i++) {
      if (new Date() - t0 > cfg.MAX_RUNTIME_MS) {
        logWarn(GMAIL_COMPONENT, 'timeboxed',
          'Stopped early after ' + processed + ' email(s) to stay inside the execution limit. ' +
          'The next scheduled run continues where this one stopped.');
        break outer;
      }
      if (processed >= cfg.MAX_EMAILS_PER_RUN) break outer;
      examined++;
      const msg = msgs[i];
      const emailId = msg.getId();

      if (state.terminalEmailIds[emailId]) { continue; }

      const gate = shouldProcessMessage_(msg, cfg);
      if (!gate.ok) {
        logDebug(GMAIL_COMPONENT, 'filter', 'Skipped: ' + gate.reason, { emailId: emailId });
        continue;
      }

      var result;
      try {
        result = processOneMessage_(msg, threads[t], state, cfg);
      } catch (e) {
        result = {
          status: 'FAILED', inserted: 0, rejected: 0, skipped: 0,
          tables: 0, extracted: 0, error: e.message + (e.stack ? ' | ' + e.stack.split('\n')[1] : '')
        };
        logError(GMAIL_COMPONENT, 'processOneMessage', e.message,
          { emailId: emailId, details: e.stack });
        try { if (labels.error) threads[t].addLabel(labels.error); } catch (e2) {}
      }

      processed++;
      inserted += result.inserted; rejected += result.rejected; skipped += result.skipped;

      // Labels reflect the outcome; they are advisory, never the dedupe key.
      try {
        if (result.status === 'SUCCESS' || result.status === 'PARTIAL' || result.status === 'NO_DATA') {
          if (labels.processed) threads[t].addLabel(labels.processed);
          if (result.rejected > 0 && labels.review) threads[t].addLabel(labels.review);
          if (labels.error && result.status !== 'FAILED') threads[t].removeLabel(labels.error);
        } else if (labels.error) {
          threads[t].addLabel(labels.error);
        }
      } catch (e) {
        logWarn(GMAIL_COMPONENT, 'label', 'Labelling failed: ' + e.message, { emailId: emailId });
      }
    }
  }

  Masters.flushNewMasters();

  logInfo(GMAIL_COMPONENT, 'summary',
    'Examined ' + examined + ', processed ' + processed + ' email(s): ' +
    inserted + ' rows inserted, ' + skipped + ' already-present rows skipped, ' +
    rejected + ' rows rejected. Elapsed ' + (new Date() - t0) + 'ms');
  flushLog();

  return { processed: processed, inserted: inserted, rejected: rejected, skipped: skipped };
}


/* ---------------------------------------------------------------------------
 * Labels
 * ------------------------------------------------------------------------- */
function getLabels_(cfg) {
  function lab(name) {
    if (!name) return null;
    try { return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); }
    catch (e) { return null; }
  }
  return {
    processed: lab(cfg.PROCESSED_LABEL),
    error: lab(cfg.ERROR_LABEL),
    review: lab(cfg.REVIEW_LABEL)
  };
}

/* ---------------------------------------------------------------------------
 * Detection rules (all configurable, none hard-coded)
 * ------------------------------------------------------------------------- */
function shouldProcessMessage_(msg, cfg) {
  const from = msg.getFrom() || '';
  const addr = (from.match(/<([^>]+)>/) || [null, from]).slice(1)[0].toLowerCase().trim();
  const domain = addr.indexOf('@') >= 0 ? addr.split('@')[1] : '';
  const subject = (msg.getSubject() || '').toLowerCase();

  if (cfg.ALLOWED_SENDERS.length &&
      cfg.ALLOWED_SENDERS.map(function (s) { return s.toLowerCase(); }).indexOf(addr) < 0) {
    return { ok: false, reason: 'sender not in ALLOWED_SENDERS (' + addr + ')' };
  }
  if (cfg.ALLOWED_SENDER_DOMAINS.length &&
      cfg.ALLOWED_SENDER_DOMAINS.map(function (s) { return s.toLowerCase().replace(/^@/, ''); })
        .indexOf(domain) < 0) {
    return { ok: false, reason: 'domain not in ALLOWED_SENDER_DOMAINS (' + domain + ')' };
  }
  if (cfg.SUBJECT_MUST_CONTAIN_ANY.length) {
    var hit = cfg.SUBJECT_MUST_CONTAIN_ANY.some(function (p) {
      return subject.indexOf(String(p).toLowerCase()) >= 0;
    });
    if (!hit) return { ok: false, reason: 'subject filter not matched' };
  }
  return { ok: true, addr: addr, domain: domain };
}


/* ---------------------------------------------------------------------------
 * Gmail message -> generic document
 * ------------------------------------------------------------------------- */
function processOneMessage_(msg, thread, state, cfg) {
  var html = '', plain = '';
  try { html = msg.getBody() || ''; } catch (e) {}
  try { plain = msg.getPlainBody() || ''; } catch (e) {}
  return ingestDocument_({
    emailId: msg.getId(),
    threadId: thread ? thread.getId() : '',
    subject: msg.getSubject() || '',
    from: msg.getFrom() || '',
    received: msg.getDate(),
    html: html,
    plain: plain
  }, state, cfg);
}



/**
 * Backwards-compatible alias. `processIncomingReports` is the name used in the
 * documentation, the menu and the triggers; this alias exists so an older
 * trigger created against the previous name keeps working.
 */
function processReportEmails() { return processIncomingReports(); }
