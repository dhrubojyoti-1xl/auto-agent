/**
 * Tolerant table extraction — port of 05_HtmlTable.gs.
 *
 * Real emails are not clean documents. This survives Gmail/Outlook layout
 * tables wrapped around the real one, signature tables, colspan/rowspan,
 * missing closing tags, uppercase tags, multiple report tables in one message,
 * blank rows, and plain-text "a | b | c" tables when there is no HTML at all.
 */
import type {
  Banner, Cell, ColumnDecision, EngineConfig, Field, HeaderMap, Masters, Table
} from './types';
import { readBanner } from './banner';
import { confirmWeakHeader, fieldFromValues, VALUE_CONFIDENCE_FLOOR } from './column-values';
import { cleanWhitespace, decodeEntities, normalizeHeader } from './normalize';
import { rankHeader } from './semantic-headers';

/**
 * The field a heading leans towards without reaching the bar to decide on its
 * own — one clear front-runner, too weak to act on unaided.
 */
function weakFieldFor(header: string): Field | null {
  const [best, second] = rankHeader(header);
  if (!best || best.score >= 3) return null;          // decided already, or nothing
  if (second && second.score === best.score) return null;  // a tie is not a lean
  return best.field;
}

const REQUIRED: Field[] = ['date', 'employee', 'task', 'status'];

function stripNoise(html: string): string {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');
}

/** All table blocks, innermost included, ordered by position in the document. */
function findTableBlocks(html: string): { start: number; inner: string }[] {
  const re = /<\/?table\b[^>]*>/gi;
  const stack: number[] = [];
  const blocks: { start: number; inner: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0].charAt(1) !== '/') {
      stack.push(m.index + m[0].length);
    } else {
      const start = stack.pop();
      if (start !== undefined && m.index > start) {
        blocks.push({ start, inner: html.substring(start, m.index) });
      }
    }
  }
  while (stack.length) {
    const s = stack.pop() as number;
    blocks.push({ start: s, inner: html.substring(s) });   // unclosed <table>
  }
  blocks.sort((a, b) => a.start - b.start);
  return blocks;
}

/** Removes complete nested <table> subtrees so rows are never counted twice. */
function stripNestedTables(inner: string): string {
  const re = /<\/?table\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let depth = 0, out = '', cursor = 0, blockStart = -1;
  while ((m = re.exec(inner)) !== null) {
    if (m[0].charAt(1) !== '/') {
      if (depth === 0) { out += inner.substring(cursor, m.index); blockStart = m.index; }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) { cursor = m.index + m[0].length; blockStart = -1; }
    }
  }
  out += inner.substring(depth === 0 ? cursor : (blockStart >= 0 ? blockStart : cursor));
  return out;
}

export function tagText(fragment: string): string {
  return cleanWhitespace(decodeEntities(
    String(fragment)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?(p|div|li|tr)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
  ));
}

function firstHref(fragment: string): string {
  const m = String(fragment).match(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/i);
  if (m) return decodeEntities(m[1]);
  const u = tagText(fragment).match(/https?:\/\/\S+/);
  return u ? u[0].replace(/[),.]+$/, '') : '';
}

function attrNum(tag: string, name: string): number {
  const m = new RegExp(name + '\\s*=\\s*["\']?(\\d+)', 'i').exec(tag);
  const n = m ? parseInt(m[1], 10) : 1;
  return (isNaN(n) || n < 1 || n > 50) ? 1 : n;
}

/** Parses one table's inner HTML (nested tables already stripped) into a grid. */
function parseTableRows(inner: string): Cell[][] {
  const rowChunks: string[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(inner)) !== null) rowChunks.push(m[1]);
  if (!rowChunks.length) return [];

  const grid: Cell[][] = [];
  const pending: Record<number, { cell: Cell; remaining: number }> = {};

  rowChunks.forEach(chunk => {
    const cells: Cell[] = [];
    let c = 0;
    const placeCarried = () => {
      while (pending[c] && pending[c].remaining > 0) {
        cells[c] = { text: pending[c].cell.text, href: pending[c].cell.href };
        pending[c].remaining--;
        if (pending[c].remaining <= 0) delete pending[c];
        c++;
      }
    };
    placeCarried();

    const cellRe = /<(t[dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr>|<\/t[dh]>\s*<\/table>|$)/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(chunk)) !== null) {
      const attrs = cm[2] || '';
      const body = cm[3].replace(/<\/t[dh]>[\s\S]*$/i, '');
      const cell: Cell = { text: tagText(body), href: firstHref(body) };
      const colspan = attrNum(attrs, 'colspan');
      const rowspan = attrNum(attrs, 'rowspan');
      for (let k = 0; k < colspan; k++) {
        placeCarried();
        cells[c] = { text: cell.text, href: cell.href };
        if (rowspan > 1) pending[c] = { cell, remaining: rowspan - 1 };
        c++;
      }
    }
    for (let i = 0; i < cells.length; i++) if (!cells[i]) cells[i] = { text: '', href: '' };
    grid.push(cells);
  });

  return grid.filter(r => r.some(c => c && c.text));
}

export function extractTables(html: string): Table[] {
  const out: Table[] = [];
  findTableBlocks(stripNoise(html)).forEach(b => {
    const rows = parseTableRows(stripNestedTables(b.inner));
    if (rows.length) out.push({ index: out.length, rows, source: 'html' });
  });
  return out;
}

/**
 * Plain-text fallback: contiguous lines containing "|" become a table.
 *
 * Two pipes a line by default, because one pipe turns up in ordinary prose
 * ("Sales | Q3"). A caller that knows the text is a table — Manual entry with
 * the Employee and Report date fields filled in — can accept one, so a
 * two-column "Task | Status" paste is read.
 */
export function extractPipeTables(text: string, minPipes = 2): Table[] {
  const lines = String(text || '').split(/\r?\n/);
  const tables: Table[] = [];
  let buf: string[] = [];

  const flush = () => {
    const lines = buf.filter(l => !/^[\s|:+-]+$/.test(l));
    // "| a | b |" has an empty cell before the first pipe and after the last
    // that belongs to the notation, not the data. Whether a table is written
    // that way is decided once, from its first line: deciding per row threw
    // away a genuinely empty first cell — a DWR line with no Sr. No. — and
    // slid every value one column to the left.
    const first = lines[0] || '';
    const leading = /^\s*\|/.test(first);
    const trailing = /\|\s*$/.test(first);
    const rows = lines
      .map(l => {
        const parts = l.split('|').map(p => cleanWhitespace(p));
        if (leading && parts.length && parts[0] === '') parts.shift();
        if (trailing && parts.length && parts[parts.length - 1] === '') parts.pop();
        return parts.map(p => {
          const u = p.match(/https?:\/\/\S+/);
          return { text: p, href: u ? u[0] : '' } as Cell;
        });
      })
      .filter(r => r.length >= 2 && r.some(c => c.text));
    if (rows.length >= 2) tables.push({ index: tables.length, rows, source: 'text' });
    buf = [];
  };

  lines.forEach(l => {
    if ((l.match(/\|/g) || []).length >= minPipes) buf.push(l);
    else if (buf.length) flush();
  });
  if (buf.length) flush();
  return tables;
}

/**
 * Plain-text fallback for a paste out of a spreadsheet.
 *
 * Copying a range from Google Sheets or Excel puts tab-separated text on the
 * clipboard — no HTML, no pipes. Read as the "a | b | c" format it produced no
 * table at all, which is why pasting a Daily Work Report into Manual entry
 * found nothing. Quoted cells (a task with a line break in it) are honoured.
 */
export function extractTabTables(text: string): Table[] {
  const src = String(text || '');
  const tabbedLines = src.split(/\r?\n/).filter(l => l.includes('\t')).length;
  if (tabbedLines < 2) return [];
  const rows = parseTabbed(src)
    .map(r => r.map(v => {
      const t = cleanWhitespace(v);
      const u = t.match(/https?:\/\/\S+/);
      return { text: t, href: u ? u[0].replace(/[),.]+$/, '') : '' } as Cell;
    }))
    .filter(r => r.some(c => c.text));
  return rows.length >= 2 ? [{ index: 0, rows, source: 'text' }] : [];
}

/** RFC 4180 reading with a tab delimiter: quotes, doubled quotes, line breaks in cells. */
function parseTabbed(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    // A quote only opens a quoted cell at the start of one; mid-cell it is text.
    if (c === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; continue; }
    if (c === '\t') { row.push(field); field = ''; atFieldStart = true; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; atFieldStart = true; continue; }
    field += c;
    atFieldStart = false;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Finds the header row and returns the column map, or null when the table is
 * not a report table (a layout table, a signature block, an attendance count).
 */
/**
 * Reads one row as a header, mapping each cell to the field it means.
 */
function mapOneRow(
  row: Cell[], masters: Masters, into: Partial<Record<Field, number>> = {}
): { mapping: Partial<Record<Field, number>>; matches: number } {
  const mapping = { ...into };
  let matches = 0;
  row.forEach((cell, i) => {
    const field = normalizeHeader(cell.text, masters);
    if (field && !(field in mapping)) { mapping[field] = i; matches++; }
  });
  return { mapping, matches };
}

/**
 * A second pass over the columns whose headings said nothing, deciding from
 * the values underneath them.
 *
 * This is what stops the mapper depending on somebody having anticipated a
 * wording. "What Was Done Today" scores two weak words and maps to nothing;
 * the column beneath it is free text that rarely repeats, which is a task
 * column whatever it is called.
 *
 * Only fields the header pass failed to fill are considered, so an explicit
 * heading always wins, and a column that convinces nothing is left alone.
 */
function fillFromValues(
  rows: Cell[][], headerRowIndex: number, mapping: Partial<Record<Field, number>>,
  masters: Masters, cfg: EngineConfig
): { mapping: Partial<Record<Field, number>>; added: ColumnDecision[] } {
  const out = { ...mapping };
  const added: ColumnDecision[] = [];
  const taken = new Set(Object.values(out));
  const width = Math.max(...rows.slice(headerRowIndex).map(r => r.length), 0);
  const body = rows.slice(headerRowIndex + 1);
  if (body.length < 3) return { mapping: out, added };

  for (let c = 0; c < width; c++) {
    if (taken.has(c)) continue;
    const column = body.map(r => r[c]?.text ?? '');
    const header = rows[headerRowIndex]?.[c]?.text ?? '';

    // The heading proposes where it can, and the values decide.
    const weak = weakFieldFor(header);
    const guess = (weak && confirmWeakHeader(weak, column, masters, cfg)) ||
                  fieldFromValues(column, masters, cfg);

    if (!guess || guess.confidence < VALUE_CONFIDENCE_FLOOR) continue;
    if (guess.field in out) continue;
    // Never make a person column out of one whose heading says it is something
    // else. "What was I supposed to do today?" leans towards the work, and its
    // short repeated entries ("Hr Meeting", "Attendance Monitoring") look like
    // names to a shape test; filing them as employees is what put task titles
    // in the Employee drop-down.
    if (guess.field === 'employee' && headingNamesSomethingElse(header)) continue;
    out[guess.field] = c;
    taken.add(c);
    added.push({
      column: c, field: guess.field, confidence: guess.confidence,
      evidence: guess.evidence,
      source: weak && guess.field === weak ? 'header semantics' : 'values',
      header
    });
  }
  return { mapping: out, added };
}

/** True when a heading leans towards some field and never towards a person. */
function headingNamesSomethingElse(header: string): boolean {
  const ranked = rankHeader(header);
  return ranked.length > 0 && !ranked.some(g => g.field === 'employee');
}

export function mapHeaderRow(
  rows: Cell[][], masters: Masters, cfg: EngineConfig,
  stated: { employee?: boolean; date?: boolean } = {}
): HeaderMap | null {
  const scanLimit = Math.min(rows.length, 6);

  // A title line can state the author and the day for every row, in which case
  // the table does not need columns for them. So can the person submitting it:
  // the Manual entry form's Employee and Report date fields exist for a table
  // that names no one or no day, and a table with neither column was refused
  // even with both fields filled in.
  const banner: Banner | null = readBanner(rows, cfg.dateOrder, scanLimit);
  const has = (f: Field, mapping: Partial<Record<Field, number>>) =>
    f in mapping ||
    (f === 'employee' && (!!banner?.employee || !!stated.employee)) ||
    (f === 'date' && (!!banner?.date || !!stated.date)) ||
    // A DWR row whose "What did I do?" is empty still names the work it was
    // meant to be; a table with only the planned column is still a report.
    (f === 'task' && 'plannedTask' in mapping);
  const withBanner = (m: HeaderMap): HeaderMap => (banner ? { ...m, banner } : m);

  // Each field the form states is a heading the table did not need to match:
  // "Task | Status" plus both fields is a complete report of two headings.
  const statedCount = (stated.employee ? 1 : 0) + (stated.date ? 1 : 0);
  const effective = statedCount
    ? { ...cfg, minHeaderMatches: Math.max(2, cfg.minHeaderMatches - statedCount) }
    : cfg;
  const found = mapHeaderRowWith(rows, masters, effective, scanLimit, has);
  return found ? withBanner(found) : null;
}

function mapHeaderRowWith(
  rows: Cell[][], masters: Masters, cfg: EngineConfig, scanLimit: number,
  has: (f: Field, mapping: Partial<Record<Field, number>>) => boolean
): HeaderMap | null {
  for (let r = 0; r < scanLimit; r++) {
    const { mapping, matches } = mapOneRow(rows[r], masters);
    const hasRequired = REQUIRED.every(f => has(f, mapping));
    if (matches >= cfg.minHeaderMatches && hasRequired) {
      // The required fields are settled, but a column the headings did not
      // name may still be a department, a link or a duration. Dropping it
      // because four other columns happened to be enough loses real data.
      const extra = fillFromValues(rows, r, mapping, masters, cfg);
      return {
        headerRowIndex: r, mapping: extra.mapping,
        matches: matches + extra.added.length,
        decisions: extra.added.length ? extra.added : undefined
      };
    }
    // The headings alone were not enough. Before giving up on this row, let
    // the columns speak for themselves.
    const filled = fillFromValues(rows, r, mapping, masters, cfg);
    if (filled.added.length) {
      const nowHasRequired = REQUIRED.every(f => has(f, filled.mapping));
      const total = matches + filled.added.length;
      if (nowHasRequired && total >= cfg.minHeaderMatches) {
        return {
          headerRowIndex: r, mapping: filled.mapping, matches: total,
          decisions: filled.added
        };
      }
    }
  }

  /*
   * A header split across two rows.
   *
   *     |            DAILY REPORT             |          <- title, spans everything
   *     | Date | Employee Information | Work  |          <- grouping row
   *     |      | Name | Department     | Task | Status |  <- the real names
   *
   * Neither row is a header on its own: the first names groups, the second
   * names half the columns. Read together they are complete, and a report
   * written this way is otherwise invisible. The lower row wins any column
   * both rows claim, because it is the more specific of the two.
   */
  for (let r = 0; r + 1 < scanLimit; r++) {
    const lower = mapOneRow(rows[r + 1], masters);
    const combined = mapOneRow(rows[r], masters, lower.mapping);
    const hasRequired = REQUIRED.every(f => has(f, combined.mapping));
    const matches = lower.matches + combined.matches;
    if (hasRequired && matches >= cfg.minHeaderMatches &&
        lower.matches > 0 && combined.matches > 0) {
      // Data starts after the LOWER row, not the upper one.
      return { headerRowIndex: r + 1, mapping: combined.mapping, matches };
    }
  }
  // Relaxed pass: a table missing only ONE required column is still recognised,
  // so its rows fail validation individually with a precise reason instead of
  // the whole table vanishing silently.
  //
  // Values are consulted here too, and that matters more than it sounds. A
  // screenshot clipped at the right edge gives a status column headed
  // "Current St", which names nothing — while the column beneath it is plainly
  // eight statuses. Reading headings alone threw the whole report away over a
  // truncated word.
  for (let r = 0; r < scanLimit; r++) {
    const header = mapOneRow(rows[r], masters);
    const filled = fillFromValues(rows, r, header.mapping, masters, cfg);
    const mapping = filled.mapping;
    const matches = header.matches + filled.added.length;
    const reqHit = REQUIRED.filter(f => has(f, mapping)).length;
    if (reqHit >= 3 && matches >= 3) {
      return {
        headerRowIndex: r, mapping, matches, partialHeader: true,
        decisions: filled.added.length ? filled.added : undefined
      };
    }
  }
  return null;
}
