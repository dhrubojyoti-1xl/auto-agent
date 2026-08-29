/**
 * ============================================================================
 * 09_AI.gs — the OPTIONAL interpretation layer.
 * ============================================================================
 * Hard rules enforced in code, not just in the prompt:
 *   1. Every number in the final report comes from the deterministic dataset.
 *      The AI is never asked to count anything.
 *   2. The AI's JSON is schema-validated AND fact-checked against the dataset
 *      (departments, employees, task ids, rates). Anything it invents is
 *      dropped and recorded in Validation_Error.
 *   3. If the AI is disabled, unavailable, or returns garbage twice, the report
 *      is still produced — with deterministic sections and an explicit
 *      "AI commentary unavailable" note. Nothing downstream breaks.
 *
 * Three providers:
 *   'manual'      — zero dependency. Writes the exact prompt + dataset to the
 *                   AI_Dataset sheet; you paste it into any free chatbot and
 *                   paste the JSON back. Honest about being semi-manual.
 *   'gemini'      — Google AI Studio API key (has a free tier; treat any free
 *                   tier as revocable, never as guaranteed).
 *   'custom_http' — any OpenAI-compatible /chat/completions endpoint that is
 *                   reachable from the public internet. Apps Script CANNOT
 *                   reach localhost, so a local Ollama needs a tunnel; see
 *                   docs/AI_LAYER.md for the free local-model route.
 * ============================================================================
 */

const AI_KEY_PROPERTY = 'AI_API_KEY';

/** Run once from the editor, then DELETE the key from the function body. */
function setApiKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('AI API key',
    'Paste the API key. It is stored in Script Properties, never in a cell.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!key) return;
  PropertiesService.getScriptProperties().setProperty(AI_KEY_PROPERTY, key);
  ui.alert('Stored. Set AI_ENABLED=TRUE and AI_PROVIDER on the Config sheet to use it.');
}

function clearApiKey() {
  PropertiesService.getScriptProperties().deleteProperty(AI_KEY_PROPERTY);
}

function getApiKey_() {
  return PropertiesService.getScriptProperties().getProperty(AI_KEY_PROPERTY) || '';
}

/* ---------------------------------------------------------------------------
 * DATASET — the only thing the AI is ever allowed to see.
 * ------------------------------------------------------------------------- */
function buildAiDataset_(reportType, periodStart, periodEnd) {
  const idx = taskIndexes_();
  const tasks = readAll_(SHEETS.TASKS).filter(function (t) {
    const d = parseDate_(t[idx.date]);
    return d && d >= periodStart && d <= periodEnd;
  });

  const iTask = col(SHEETS.TASKS, 'Task');
  const iCat  = col(SHEETS.TASKS, 'Task_Category');
  const iQual = col(SHEETS.TASKS, 'Data_Quality_Status');
  const iBasis = col(SHEETS.TASKS, 'Duration_Basis');
  const iTid  = col(SHEETS.TASKS, 'Task_ID');
  const iExp  = col(SHEETS.TASKS, 'Expected_Duration');
  const iAct  = col(SHEETS.TASKS, 'Actual_Duration');
  const iVar  = col(SHEETS.TASKS, 'Slow_Variance_Hours');
  const iClass = col(SHEETS.TASKS, 'Repeat_Classification');

  const overall = newBucket_();
  const byDept = {}, byEmp = {}, byCat = {};
  var slowRows = [], insufficientDuration = 0, missingLink = 0, reviewRows = 0;

  tasks.forEach(function (t) {
    accumulate_(overall, t, idx);
    const dept = String(t[idx.dept] || 'Unassigned');
    const emp = String(t[idx.emp] || 'Unknown');
    const cat = String(t[iCat] || 'Uncategorised');
    if (!byDept[dept]) byDept[dept] = newBucket_();
    if (!byEmp[emp]) byEmp[emp] = { b: newBucket_(), dept: dept };
    if (!byCat[cat]) byCat[cat] = newBucket_();
    accumulate_(byDept[dept], t, idx);
    accumulate_(byEmp[emp].b, t, idx);
    accumulate_(byCat[cat], t, idx);
    if (String(t[iBasis]) === 'Insufficient Data') insufficientDuration++;
    if (!String(t[col(SHEETS.TASKS, 'Link')] || '')) missingLink++;
    if (String(t[iQual]) === 'Review') reviewRows++;
    if (String(t[idx.slow]) === 'TRUE') {
      slowRows.push({
        task_id: String(t[iTid]), task: String(t[iTask]), employee: emp, department: dept,
        category: cat, expected_hours: Number(t[iExp]), actual_hours: Number(t[iAct]),
        variance_hours: Number(t[iVar])
      });
    }
  });
  slowRows.sort(function (a, b) { return b.variance_hours - a.variance_hours; });

  // Repeated groups already computed deterministically.
  const repeated = readObjects_(SHEETS.REPEATED)
    .filter(function (r) {
      const d = parseDate_(r['Last_Date']);
      return d && d >= periodStart && d <= periodEnd;
    })
    .slice(0, 25)
    .map(function (r) {
      return {
        employee: r['Employee'], department: r['Department'],
        task: r['Task'], occurrences: Number(r['Occurrence_Count']),
        distinct_dates: Number(r['Distinct_Dates']),
        classification: r['Classification']
      };
    });

  // Comparison window of equal length, immediately before the period.
  const spanDays = Math.round((periodEnd - periodStart) / 86400000) + 1;
  const prevEnd = addDays_(periodStart, -1);
  const prevStart = addDays_(prevEnd, -(spanDays - 1));
  const prev = newBucket_();
  readAll_(SHEETS.TASKS).forEach(function (t) {
    const d = parseDate_(t[idx.date]);
    if (d && d >= prevStart && d <= prevEnd) accumulate_(prev, t, idx);
  });

  const rate = pct_(overall['Completed'] || 0, overall.total);
  const prevRate = pct_(prev['Completed'] || 0, prev.total);

  function bucketOut(b) {
    return {
      total: b.total, completed: b['Completed'] || 0, in_progress: b['In Progress'] || 0,
      pending: b['Pending'] || 0, blocked: b['Blocked'] || 0,
      cancelled: b['Cancelled'] || 0, not_started: b['Not Started'] || 0,
      completion_rate: pct_(b['Completed'] || 0, b.total),
      slow_tasks: b.slow, repeated_tasks: b.repeated,
      employees_reporting: Object.keys(b.employees).length
    };
  }

  // A rejected row belongs to the business date it CLAIMS, so a daily report
  // is not polluted by rejections from a backfill of older reports. When the
  // claimed date is itself unparseable, fall back to when it was logged.
  const rejected = readObjects_(SHEETS.DATA_QUALITY).filter(function (r) {
    const d = parseDate_(r['Raw_Date']) || atMidnight_(new Date(r['Logged_At']));
    return d && d >= periodStart && d <= periodEnd;
  });
  const rejectReasons = {};
  rejected.forEach(function (r) {
    rejectReasons[r['Rejection_Reason']] = (rejectReasons[r['Rejection_Reason']] || 0) + 1;
  });

  return {
    meta: {
      report_type: reportType,
      period_start: fmtDate_(periodStart),
      period_end: fmtDate_(periodEnd),
      comparison_period_start: fmtDate_(prevStart),
      comparison_period_end: fmtDate_(prevEnd),
      generated_at: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm'),
      note: 'All figures are pre-computed. Do not recalculate them.'
    },
    totals: bucketOut(overall),
    comparison_totals: bucketOut(prev),
    completion_rate_change_percentage_points: prev.total ? ppChange_(rate, prevRate) : null,
    departments: Object.keys(byDept).sort().map(function (d) {
      const o = bucketOut(byDept[d]); o.department = d; return o;
    }),
    employees: Object.keys(byEmp).sort().map(function (e) {
      const o = bucketOut(byEmp[e].b);
      o.employee = e; o.department = byEmp[e].dept;
      o.data_sufficiency = o.total >= 10 ? 'Indicative' : 'Insufficient — do not rank';
      return o;
    }),
    categories: Object.keys(byCat).sort().map(function (c) {
      const o = bucketOut(byCat[c]); o.category = c; return o;
    }),
    slow_tasks: slowRows.slice(0, 25),
    slow_task_note: insufficientDuration + ' of ' + overall.total +
      ' task(s) have no usable start/completion timestamps, so their duration is unknown ' +
      'and they are excluded from slow-task analysis.',
    repeated_tasks: repeated,
    data_quality: {
      tasks_in_period: overall.total,
      rows_rejected_in_period: rejected.length,
      rejection_reasons: rejectReasons,
      tasks_missing_link: missingLink,
      tasks_flagged_for_review: reviewRows,
      tasks_without_duration_data: insufficientDuration,
      uncategorised_tasks: (byCat['Uncategorised'] ? byCat['Uncategorised'].total : 0) +
                           (byCat[''] ? byCat[''].total : 0)
    }
  };
}

/* ---------------------------------------------------------------------------
 * PROMPTS
 * ------------------------------------------------------------------------- */
const AI_SYSTEM_PROMPT =
'You are a management reporting analyst. You interpret a pre-computed dataset about ' +
'departmental task reporting. You never compute or estimate numbers yourself.\n' +
'\n' +
'ABSOLUTE RULES\n' +
'1. Use ONLY the JSON dataset provided. Nothing else exists.\n' +
'2. Never invent or alter a task count, completion rate, employee, department, ' +
'category, task, or duration. Every number you write must appear verbatim in the dataset.\n' +
'3. Never call a task slow unless it appears in dataset.slow_tasks.\n' +
'4. Never call an employee underperforming. Task counts measure reported activity, not ' +
'value or complexity. Where data_sufficiency says "Insufficient — do not rank", do not ' +
'compare that person to anyone.\n' +
'5. Repetition is not automatically waste. Respect the classification already assigned to ' +
'each repeated task group.\n' +
'6. Express changes in completion rate as percentage POINTS (e.g. "80% to 85% is +5 ' +
'percentage points"), never as a percentage change.\n' +
'7. Separate FACT (restating dataset values) from INTERPRETATION (your inference). Mark ' +
'interpretation with the "interpretation" field where the schema provides one.\n' +
'8. If the dataset cannot support a section, write exactly "Insufficient data." for it.\n' +
'9. Output ONE JSON object and nothing else. No prose, no markdown, no code fences.\n' +
'\n' +
'OUTPUT SCHEMA (all keys required)\n' +
'{\n' +
'  "summary": "3-5 sentence executive summary. Facts first, interpretation clearly hedged.",\n' +
'  "overall_completion_rate": <copy dataset.totals.completion_rate exactly>,\n' +
'  "department_observations": [\n' +
'     {"department": "<must exist in dataset.departments>", "observation": "...", ' +
'"interpretation": "...", "confidence": "high|medium|low"}\n' +
'  ],\n' +
'  "attention_items": [\n' +
'     {"item": "...", "why_it_matters": "...", "supporting_data": "<quote the dataset ' +
'numbers you relied on>", "suggested_action": "..."}\n' +
'  ],\n' +
'  "slow_tasks": [\n' +
'     {"task_id": "<must exist in dataset.slow_tasks>", "comment": "..."}\n' +
'  ],\n' +
'  "repeated_tasks": [\n' +
'     {"employee": "<must exist>", "task": "<must exist>", "classification": "<copy from ' +
'dataset>", "comment": "..."}\n' +
'  ],\n' +
'  "trends": ["...", "..."],\n' +
'  "data_quality": ["...", "..."]\n' +
'}\n';

function buildAiUserPrompt_(dataset) {
  return 'DATASET (authoritative, pre-computed):\n' +
    JSON.stringify(dataset, null, 1) +
    '\n\nProduce the JSON object described in the system rules for the ' +
    dataset.meta.report_type + ' period ' + dataset.meta.period_start + ' to ' +
    dataset.meta.period_end + '. Output JSON only.';
}

/* ---------------------------------------------------------------------------
 * PROVIDERS
 * ------------------------------------------------------------------------- */
function callAi_(dataset) {
  const cfg = getConfig();
  if (!cfg.AI_ENABLED) return { ok: false, reason: 'AI_DISABLED' };
  const prompt = buildAiUserPrompt_(dataset);
  var attempt = 0, lastErr = '';
  while (attempt <= cfg.AI_MAX_RETRIES) {
    attempt++;
    try {
      var text;
      if (cfg.AI_PROVIDER === 'gemini') text = callGemini_(prompt, cfg);
      else if (cfg.AI_PROVIDER === 'custom_http') text = callCustomHttp_(prompt, cfg);
      else return { ok: false, reason: 'MANUAL_MODE' };
      const parsed = parseJsonLoose_(text);
      if (!parsed) { lastErr = 'Response was not valid JSON'; continue; }
      return { ok: true, json: parsed, raw: text, attempts: attempt };
    } catch (e) {
      lastErr = e.message;
      logWarn('AI', 'call', 'Attempt ' + attempt + ' failed: ' + e.message);
      Utilities.sleep(1500);
    }
  }
  return { ok: false, reason: 'AI_FAILED', error: lastErr };
}

function callGemini_(prompt, cfg) {
  const key = getApiKey_();
  if (!key) throw new Error('No API key stored. Run setApiKey() first.');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(cfg.AI_MODEL) + ':generateContent?key=' + encodeURIComponent(key);
  const payload = {
    systemInstruction: { parts: [{ text: AI_SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('Gemini HTTP ' + code + ': ' + truncate_(res.getContentText(), 300));
  const body = JSON.parse(res.getContentText());
  const cand = body.candidates && body.candidates[0];
  const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
  if (!part || !part.text) throw new Error('Empty Gemini response');
  return part.text;
}

function callCustomHttp_(prompt, cfg) {
  if (!cfg.AI_ENDPOINT) throw new Error('AI_ENDPOINT is empty on the Config sheet.');
  const key = getApiKey_();
  const headers = key ? { Authorization: 'Bearer ' + key } : {};
  const res = UrlFetchApp.fetch(cfg.AI_ENDPOINT, {
    method: 'post', contentType: 'application/json', headers: headers,
    payload: JSON.stringify({
      model: cfg.AI_MODEL, temperature: 0.2,
      messages: [{ role: 'system', content: AI_SYSTEM_PROMPT },
                 { role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('HTTP ' + res.getResponseCode() + ': ' + truncate_(res.getContentText(), 300));
  }
  const body = JSON.parse(res.getContentText());
  const msg = body.choices && body.choices[0] && body.choices[0].message;
  if (!msg || !msg.content) throw new Error('Empty response from AI_ENDPOINT');
  return msg.content;
}

function parseJsonLoose_(text) {
  if (!text) return null;
  var s = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.substring(first, last + 1)); } catch (e2) {}
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * VALIDATION — the anti-hallucination gate.
 * ------------------------------------------------------------------------- */
function validateAiJson_(json, dataset) {
  const errors = [];
  const clean = {
    summary: '', overall_completion_rate: dataset.totals.completion_rate,
    department_observations: [], attention_items: [], slow_tasks: [],
    repeated_tasks: [], trends: [], data_quality: []
  };
  if (!json || typeof json !== 'object') {
    return { ok: false, errors: ['Response was not a JSON object'], clean: clean };
  }

  clean.summary = typeof json.summary === 'string' ? json.summary.trim() : '';
  if (!clean.summary) errors.push('summary missing');

  const stated = Number(json.overall_completion_rate);
  if (isNaN(stated) || Math.abs(stated - dataset.totals.completion_rate) > 0.11) {
    errors.push('overall_completion_rate was "' + json.overall_completion_rate +
      '" but the dataset says ' + dataset.totals.completion_rate + '. Dataset value kept.');
  }

  const deptSet = {};
  dataset.departments.forEach(function (d) { deptSet[d.department] = true; });
  asArray_(json.department_observations).forEach(function (o) {
    if (!o || !deptSet[o.department]) {
      errors.push('Dropped observation for unknown department "' +
        (o && o.department) + '"');
      return;
    }
    clean.department_observations.push({
      department: o.department,
      observation: String(o.observation || '').trim(),
      interpretation: String(o.interpretation || '').trim(),
      confidence: ['high', 'medium', 'low'].indexOf(String(o.confidence).toLowerCase()) >= 0
        ? String(o.confidence).toLowerCase() : 'low'
    });
  });

  asArray_(json.attention_items).slice(0, 10).forEach(function (a) {
    if (!a || !a.item) return;
    clean.attention_items.push({
      item: String(a.item).trim(),
      why_it_matters: String(a.why_it_matters || '').trim(),
      supporting_data: String(a.supporting_data || '').trim(),
      suggested_action: String(a.suggested_action || '').trim()
    });
  });

  const slowById = {};
  dataset.slow_tasks.forEach(function (s) { slowById[s.task_id] = s; });
  asArray_(json.slow_tasks).forEach(function (s) {
    if (!s || !slowById[s.task_id]) {
      errors.push('Dropped slow-task comment for unknown Task_ID "' + (s && s.task_id) + '"');
      return;
    }
    const src = slowById[s.task_id];
    clean.slow_tasks.push({
      task_id: s.task_id, task: src.task, employee: src.employee,
      department: src.department, expected_hours: src.expected_hours,
      actual_hours: src.actual_hours, variance_hours: src.variance_hours,
      comment: String(s.comment || '').trim()
    });
  });

  const repKey = {};
  dataset.repeated_tasks.forEach(function (r) {
    repKey[Masters.keyify(r.employee) + '||' + normalizeTask_(r.task)] = r;
  });
  asArray_(json.repeated_tasks).forEach(function (r) {
    if (!r) return;
    const k = Masters.keyify(r.employee || '') + '||' + normalizeTask_(r.task || '');
    if (!repKey[k]) {
      errors.push('Dropped repeated-task comment not present in the dataset ("' +
        (r.employee || '?') + ' / ' + (r.task || '?') + '")');
      return;
    }
    const src = repKey[k];
    clean.repeated_tasks.push({
      employee: src.employee, task: src.task, occurrences: src.occurrences,
      distinct_dates: src.distinct_dates, classification: src.classification,
      comment: String(r.comment || '').trim()
    });
  });

  clean.trends = asArray_(json.trends).map(String).filter(Boolean).slice(0, 10);
  clean.data_quality = asArray_(json.data_quality).map(String).filter(Boolean).slice(0, 10);

  return { ok: errors.length === 0, errors: errors, clean: clean };
}

function asArray_(v) { return Array.isArray(v) ? v : []; }
