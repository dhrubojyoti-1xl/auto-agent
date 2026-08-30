/**
 * The document → records pipeline. Port of 06_Ingest.gs, minus all I/O.
 *
 * Guarantees, all covered by tests:
 *   IDEMPOTENT  The same document ingested twice produces nothing the second
 *               time. Enforced by taskFingerprint + sourceDocumentId, never by
 *               a label or a flag a user could remove.
 *   LOSSLESS    A bad row never kills the document. It is returned in
 *               `rejected` with the raw values and an actionable reason.
 *   HONEST      Nothing is invented: no guessed dates, durations, employees or
 *               departments.
 */
import { departmentFromEvidence, inferReportDate } from './evidence';
import { workKindFromHeader } from './semantic-headers';
import type {
  Cell, EngineConfig, Employee, Field, IngestResult, Masters, RejectedRow,
  SourceDocument, TaskRecord
} from './types';
import {
  cleanWhitespace, departmentFromSender,
  expectedDurationFor, keyify, lookupDepartment, normalizePriority, normalizeStatus,
  normalizeTask, parseDate, parseHours, parseTime, resolveCategory, resolveEmployee,
  shortHash
} from './normalize';
import { extractPipeTables, extractTables, mapHeaderRow, tagText } from './html-table';

/** fingerprint -> the document id that owns it. */
export type FingerprintIndex = Map<string, string>;

export interface DurationResult { hours: number | null; basis: TaskRecord['durationBasis'] }

/**
 * Actual duration in hours.
 *   Reported          the document supplied an explicit hours column
 *   Derived           computed from start/completion stamps
 *   Insufficient Data never guessed
 */
export function computeDuration(
  taskDate: string,
  startDate: string | null, startTime: string | null,
  completionDate: string | null, completionTime: string | null,
  reportedHours: number | null
): DurationResult {
  if (reportedHours !== null && reportedHours > 0) {
    return { hours: reportedHours, basis: 'Reported' };
  }
  const sd = startDate || (startTime ? taskDate : null);
  const ed = completionDate || (completionTime ? taskDate : null);

  if (sd && ed && startTime && completionTime) {
    const s = Date.parse(sd + 'T' + startTime + ':00Z');
    const e = Date.parse(ed + 'T' + completionTime + ':00Z');
    const h = (e - s) / 3600000;
    if (h >= 0 && h < 24 * 30) return { hours: Math.round(h * 100) / 100, basis: 'Derived' };
    return { hours: null, basis: 'Insufficient Data' };
  }
  if (sd && ed && !startTime && !completionTime) {
    const days = Math.round((Date.parse(ed) - Date.parse(sd)) / 86400000);
    if (days > 0 && days <= 365) return { hours: days * 8, basis: 'Derived' };
  }
  return { hours: null, basis: 'Insufficient Data' };
}

function readRowFields(cells: Cell[], mapping: Partial<Record<Field, number>>): Record<string, string> {
  const out: Record<string, string> = {};
  (Object.keys(mapping) as Field[]).forEach(field => {
    const c = cells[mapping[field] as number];
    out[field] = c ? c.text : '';
    if (field === 'link' && c && c.href) out[field] = c.href;
  });
  if (!out.link) {
    for (const c of cells) if (c && c.href) { out.link = c.href; break; }
  }
  return out;
}

function isBlankRow(raw: Record<string, string>): boolean {
  return !Object.keys(raw).some(k => cleanWhitespace(raw[k]));
}

/**
 * A summary line at the foot of a hand-maintained sheet.
 *
 * The word can sit in any column — whoever typed it put it wherever the layout
 * suited — so every field is checked rather than just the two it was first
 * seen in. Getting this wrong is not harmless: a totals row that reaches
 * validation is rejected as a malformed task, which puts a permanent entry on
 * the Data quality page for a row that was never a task at all.
 */
const SUMMARY_WORD = /^(total|grand total|sum|subtotal|overall|summary|count)\b/;

function looksLikeTotalsRow(raw: Record<string, string>): boolean {
  for (const key of ['task', 'employee', 'date', 'department', 'status']) {
    if (SUMMARY_WORD.test(cleanWhitespace(raw[key] || '').toLowerCase())) return true;
  }
  return false;
}

type BuildOk = {
  ok: true;
  record: Omit<TaskRecord, 'taskFingerprint'>;
  raw: Record<string, string>;
  tableIndex: number;
  rowIndex: number;
};
type BuildFail = { ok: false; reason: RejectedRow['reason']; detail: string };

function buildTaskRecord(
  raw: Record<string, string>,
  ctx: {
    reportId: string; documentId: string; receivedAt: string; departmentHint: string;
    /** The day the covering text said the report covers, when a row omits one. */
    reportDate: string;
    /** The words that date was read from, recorded on the row. */
    reportDateQuote: string;
    /**
     * Who sent the report, used only when the table has no employee column at
     * all. A blank cell in a table that HAS one is a malformed row and is
     * still rejected — attributing it to the sender would invent an author for
     * somebody else's line.
     */
    senderEmployee: string;
    /** The stream the task column described: today's work, a plan, and so on. */
    workKind: string;
    tableIndex: number; rowIndex: number;
  },
  masters: Masters, cfg: EngineConfig, createdEmployees: Employee[]
): BuildOk | BuildFail {
  const problems: string[] = [];

  // --- Date (required) ---
  // A row without its own date falls back to the day the covering text stated,
  // and only that: with nothing stated the row is refused rather than stamped
  // with whenever the email happened to arrive.
  const ownDate = cleanWhitespace(raw.date);
  const rawDate = ownDate || ctx.reportDate || '';
  if (!rawDate) {
    return {
      ok: false, reason: 'MISSING_REQUIRED_FIELD',
      detail: 'Date is empty, and the email says nothing about which day the report covers'
    };
  }
  const dateFromContext = !ownDate;
  const date = parseDate(rawDate, cfg.dateOrder);
  if (dateFromContext && date) {
    // Visible on the row, because a date the sender never wrote in the table is
    // an inference and should be inspectable as one.
    problems.push(`Date taken from the email — ${ctx.reportDateQuote}`);
  }
  if (!date) {
    return {
      ok: false, reason: 'INVALID_DATE',
      detail: `Could not parse "${rawDate}". Accepted: 2026-08-29, 29 Aug 2026, ` +
              `29/08/2026 (dateOrder=${cfg.dateOrder}), Aug 29 2026.`
    };
  }

  // --- Employee (required) ---
  // A one-person report routinely omits the name: the sender is the author,
  // and writing it on every row would be redundant. Falling back to the sender
  // is only safe when the table never had an employee column, which the caller
  // determines from the header, not from this row being blank.
  const rawEmp = cleanWhitespace(raw.employee) || ctx.senderEmployee;
  if (!rawEmp) {
    return {
      ok: false, reason: 'MISSING_REQUIRED_FIELD',
      detail: 'Employee name is empty, and the sender could not be identified either'
    };
  }
  const deptRaw = cleanWhitespace(raw.department);
  const deptFromRow = deptRaw ? lookupDepartment(deptRaw, masters) || titleIfNew(deptRaw) : '';
  const emp = resolveEmployee(
    rawEmp, deptFromRow || ctx.departmentHint || cfg.defaultDepartment,
    masters, cfg, createdEmployees
  );
  if (!emp) {
    return {
      ok: false, reason: 'UNKNOWN_EMPLOYEE',
      detail: `"${rawEmp}" is not a known employee and autoCreateEmployees is off.`
    };
  }
  if (emp.isNew) problems.push('Employee auto-created from this document');

  // Department precedence: explicit column > employee master > document hint >
  // configured default. The default is a placeholder, not a fact, so a real
  // signal must still beat it — and department is part of the fingerprint, so
  // this must resolve identically on every run.
  const deptFromMaster = emp.department && emp.department !== cfg.defaultDepartment ? emp.department : '';
  const department = deptFromRow || deptFromMaster || ctx.departmentHint || cfg.defaultDepartment;

  // --- Task (required) ---
  const rawTask = cleanWhitespace(raw.task);
  if (!rawTask) return { ok: false, reason: 'MISSING_REQUIRED_FIELD', detail: 'Task is empty' };
  if (rawTask.length < cfg.minTaskLength) {
    return {
      ok: false, reason: 'TASK_TOO_SHORT',
      detail: `Task "${rawTask}" is shorter than minTaskLength=${cfg.minTaskLength}`
    };
  }
  const taskNormalized = normalizeTask(rawTask);
  if (!taskNormalized) {
    return {
      ok: false, reason: 'TASK_NOT_MEANINGFUL',
      detail: `Task "${rawTask}" contains no usable words after normalisation`
    };
  }

  // --- Status (required) ---
  const rawStatus = cleanWhitespace(raw.status);
  if (!rawStatus) return { ok: false, reason: 'MISSING_REQUIRED_FIELD', detail: 'Status is empty' };
  let status = normalizeStatus(rawStatus, masters);
  if (!status) {
    if (cfg.rejectUnknownStatus) {
      return {
        ok: false, reason: 'UNKNOWN_STATUS',
        detail: `"${rawStatus}" does not map to any canonical status. Add it to the ` +
                `status alias list and re-import.`
      };
    }
    status = 'Pending';
    problems.push(`Unrecognised status "${rawStatus}" defaulted to Pending`);
  }

  // --- Optional ---
  const startDate = parseDate(raw.startDate, cfg.dateOrder);
  const startTime = parseTime(raw.startTime);
  const completionDate = parseDate(raw.completionDate, cfg.dateOrder);
  const completionTime = parseTime(raw.completionTime);

  let categoryName = cleanWhitespace(raw.category);
  let expected: number | null = null;
  if (categoryName) {
    expected = expectedDurationFor(categoryName, masters);
  } else {
    const cat = resolveCategory(taskNormalized, masters);
    categoryName = cat.name;
    expected = cat.expectedDuration;
  }
  const expectedFromDoc = parseHours(raw.expectedDuration);
  if (expectedFromDoc !== null) expected = expectedFromDoc;

  const dur = computeDuration(
    date, startDate, startTime, completionDate, completionTime, parseHours(raw.actualDuration)
  );
  if (dur.basis === 'Insufficient Data') {
    problems.push('No start/completion timestamps — duration cannot be measured');
  }

  const quality: TaskRecord['dataQualityStatus'] =
    problems.length === 0 ? 'OK'
      : problems.some(p => /Unrecognised/.test(p)) ? 'Review' : 'Partial';

  return {
    ok: true,
    raw,
    tableIndex: ctx.tableIndex,
    rowIndex: ctx.rowIndex,
    record: {
      taskId: 'TSK-' + shortHash(
        `${ctx.documentId}|${ctx.tableIndex}|${ctx.rowIndex}|${rawTask}`, 10).toUpperCase(),
      reportId: ctx.reportId,
      date,
      department,
      workKind: ctx.workKind,
      employeeName: emp.name,
      employeeId: emp.id,
      task: rawTask,
      taskNormalized,
      taskCategory: categoryName,
      taskStatus: status,
      priority: normalizePriority(raw.priority),
      startDate, startTime, completionDate, completionTime,
      expectedDuration: expected,
      actualDuration: dur.hours,
      durationBasis: dur.basis,
      link: cleanWhitespace(raw.link),
      sourceDocumentId: ctx.documentId,
      sourceDocumentDate: ctx.receivedAt,
      dataQualityStatus: quality,
      dataQualityNotes: problems.join('; '),
      notes: cleanWhitespace(raw.notes)
    }
  };
}

/** A department column may legitimately name a department we do not know yet. */
function titleIfNew(raw: string): string {
  return cleanWhitespace(raw)
    .replace(/\b([a-z])/g, m => m.toUpperCase());
}

/**
 * The fingerprint that makes the whole system idempotent.
 *
 * base     = date | employee | department | normalised task | status
 * ordinal  = which occurrence of that base this is WITHIN this document
 *
 * The ordinal is what separates "the report was sent twice" from "this person
 * genuinely had three client calls today".
 */
export function taskFingerprint(
  date: string, employee: string, department: string,
  taskNormalized: string, status: string, ordinal: number
): string {
  const base = [date, keyify(employee), keyify(department), taskNormalized, status].join('|');
  return shortHash(base + '#' + ordinal, 16);
}

export function ingestDocument(
  doc: SourceDocument,
  masters: Masters,
  cfg: EngineConfig,
  fingerprints: FingerprintIndex
): IngestResult {
  const reportId = 'RPT-' + shortHash(doc.documentId, 10).toUpperCase();
  const createdEmployees: Employee[] = [];

  // 1. Candidate tables. Pre-parsed tables (an attachment) win outright.
  let tables = doc.tables?.length ? doc.tables : (doc.html ? extractTables(doc.html) : []);
  if (!tables.length) {
    tables = extractPipeTables(doc.text || (doc.html ? tagText(doc.html) : ''));
  }

  // 2. Keep only tables that map to the schema
  const reportTables = tables
    .map(t => ({ table: t, header: mapHeaderRow(t.rows, masters, cfg) }))
    .filter(x => x.header !== null) as { table: typeof tables[number]; header: NonNullable<ReturnType<typeof mapHeaderRow>> }[];

  if (!reportTables.length) {
    return {
      reportId, status: 'NO_DATA', department: '', reportDate: null,
      tablesFound: 0, rowsExtracted: 0, accepted: [], rejected: [],
      skippedIdempotent: 0, newEmployees: [],
      message: `No table with recognisable Date/Employee/Task/Status headers. ` +
               `Tables seen: ${tables.length}. Add the missing header wording to the ` +
               `header alias list if this really is a report.`
    };
  }

  // 3. Department and reporting date from everything except the rows.
  //
  // A spreadsheet arrives with a covering sentence, and that sentence is
  // routinely the only statement of which department the report is for and
  // which day it covers — the columns do not repeat what the sender already
  // said. Reading only the subject threw that away.
  const addr = (doc.sender.match(/<([^>]+)>/)?.[1] || doc.sender || '').toLowerCase().trim();
  const domain = addr.includes('@') ? addr.split('@')[1] : '';
  const deptEvidence = departmentFromEvidence({
    subject: doc.subject, body: doc.contextText,
    attachmentName: doc.attachmentName,
    sheetName: reportTables[0]?.table.sheetName
  }, masters, cfg);
  const departmentHint =
    deptEvidence?.department ||
    departmentFromSender(domain, doc.sender, masters) || '';

  // The day the report is about, when its rows do not say. Never the arrival
  // date on its own: a Monday email about Friday's work is not Monday's work.
  const dateEvidence = inferReportDate(
    { subject: doc.subject, body: doc.contextText, receivedAt: doc.receivedAt }, cfg);

  // The sender as a person: "Ada Lovelace <a@x.com>" -> "Ada Lovelace",
  // and a bare address falls back to its local part.
  const senderName = senderDisplayName(doc.sender);

  // 4. Parse every report table
  const built: BuildOk[] = [];
  const rejected: RejectedRow[] = [];
  let rowsExtracted = 0;

  reportTables.forEach((rt, tIdx) => {
    const { rows } = rt.table;
    for (let r = rt.header.headerRowIndex + 1; r < rows.length; r++) {
      if (rowsExtracted >= cfg.maxRowsPerDocument) break;
      const raw = readRowFields(rows[r], rt.header.mapping);
      if (isBlankRow(raw) || looksLikeTotalsRow(raw)) continue;
      rowsExtracted++;
      const res = buildTaskRecord(
        raw,
        { reportId, documentId: doc.documentId, receivedAt: doc.receivedAt,
          departmentHint,
          reportDate: dateEvidence?.date || '',
          reportDateQuote: dateEvidence?.quote || '',
          tableIndex: tIdx, rowIndex: r,
          workKind: workKindFor(rt.header, rt.table.rows),
          // Only when this table has no employee column of its own.
          senderEmployee: 'employee' in rt.header.mapping ? '' : senderName },
        masters, cfg, createdEmployees
      );
      if (res.ok) built.push(res);
      else rejected.push({
        reportId, documentId: doc.documentId, tableIndex: tIdx, rowIndex: r,
        reason: res.reason, detail: res.detail, raw
      });
    }
  });

  // 5. Fingerprint + duplicate resolution
  const ordinals = new Map<string, number>();
  const accepted: TaskRecord[] = [];
  let skippedIdempotent = 0;

  built.forEach(b => {
    const rec = b.record;
    const base = [rec.date, keyify(rec.employeeName), keyify(rec.department),
                  rec.taskNormalized, rec.taskStatus].join('|');
    const ordinal = (ordinals.get(base) || 0) + 1;
    ordinals.set(base, ordinal);
    const fp = taskFingerprint(
      rec.date, rec.employeeName, rec.department, rec.taskNormalized, rec.taskStatus, ordinal
    );

    const owner = fingerprints.get(fp);
    if (owner === undefined) {
      fingerprints.set(fp, doc.documentId);
      accepted.push({ ...rec, taskFingerprint: fp });
    } else if (owner === doc.documentId) {
      skippedIdempotent++;                       // safe re-run of the same document
    } else {
      rejected.push({
        // Carry the ORIGINAL table/row position through. Logging every
        // duplicate at (-1,-1) would make them indistinguishable, and the
        // database's uniqueness index would silently collapse fourteen
        // rejections into one.
        reportId, documentId: doc.documentId,
        tableIndex: b.tableIndex, rowIndex: b.rowIndex,
        reason: 'DUPLICATE_ACROSS_DOCUMENTS',
        detail: `Identical task already imported from document ${owner} ` +
                `(fingerprint ${fp}, occurrence ${ordinal} of this ` +
                `Date+Employee+Task+Status). This is not a repeated task: the same ` +
                `occurrence number is already in the database.`,
        raw: b.raw
      });
    }
  });

  const reportDate = accepted.length
    ? accepted.map(r => r.date).sort().slice(-1)[0]
    : (parseDate(doc.subject.match(
        /(\d{1,2}[\s\-/.][A-Za-z]{3,9}[\s\-/.,]+\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/
      )?.[1], cfg.dateOrder) || doc.receivedAt.slice(0, 10));

  // The report's department, set only when every row agrees.
  //
  // Taking the most common one labelled a five-department report with
  // whichever team happened to have the most rows, and the other four
  // disappeared from the report's own description. The rows always carried
  // their own department correctly; it was the summary that lied.
  const departments = [...new Set(accepted.map(r => r.department).filter(Boolean))].sort();
  const department = departments.length === 1
    ? departments[0]
    : departments.length === 0 ? (departmentHint || '') : '';

  const status: IngestResult['status'] =
    rejected.length > 0 ? 'PARTIAL'
      : accepted.length === 0 && skippedIdempotent === 0 ? 'NO_DATA'
      : 'SUCCESS';

  return {
    reportId, status, department, departments, reportDate,
    tablesFound: reportTables.length, rowsExtracted,
    accepted, rejected, skippedIdempotent,
    newEmployees: createdEmployees,
    message: rejected.length
      ? `${accepted.length} imported, ${rejected.length} rejected, ${skippedIdempotent} already present`
      : `${accepted.length} imported, ${skippedIdempotent} already present`
  };
}

/**
 * The human name behind a From header.
 *
 * "Ada Lovelace <ada@example.com>" -> "Ada Lovelace"
 * "ada.lovelace@example.com"                 -> "Ada Lovelace"
 *
 * The address is only used when there is no display name, and the local part
 * is title-cased rather than left as an address, because it becomes an
 * employee name on screen.
 */
/**
 * The stream a table's task column describes, read from its own heading.
 *
 * A table headed "Tomorrow's Plan" holds plans, and every row in it is a plan
 * no matter what its status cell says.
 */
function workKindFor(
  header: { mapping: Partial<Record<string, number>>; headerRowIndex: number },
  rows: { text: string }[][]
): string {
  const col = (header.mapping as Record<string, number | undefined>).task;
  if (col === undefined) return 'REPORTED';
  const headerRow = rows[header.headerRowIndex];
  const text = headerRow?.[col]?.text || '';
  return workKindFromHeader(text);
}

export function senderDisplayName(from: string): string {
  const raw = cleanWhitespace(from || '');
  if (!raw) return '';

  const named = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (named) {
    const name = cleanWhitespace(named[1]);
    if (name && !name.includes('@')) return name;
  }

  const addr = raw.match(/<([^>]+)>/)?.[1] || raw;
  const local = addr.split('@')[0] || '';
  if (!local) return '';
  return local
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
