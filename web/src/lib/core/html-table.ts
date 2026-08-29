/**
 * Tolerant table extraction — port of 05_HtmlTable.gs.
 *
 * Real emails are not clean documents. This survives Gmail/Outlook layout
 * tables wrapped around the real one, signature tables, colspan/rowspan,
 * missing closing tags, uppercase tags, multiple report tables in one message,
 * blank rows, and plain-text "a | b | c" tables when there is no HTML at all.
 */
import type { Cell, EngineConfig, Field, HeaderMap, Masters, Table } from './types';
import { cleanWhitespace, decodeEntities, normalizeHeader } from './normalize';

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

/** Plain-text fallback: contiguous lines containing "|" become a table. */
export function extractPipeTables(text: string): Table[] {
  const lines = String(text || '').split(/\r?\n/);
  const tables: Table[] = [];
  let buf: string[] = [];

  const flush = () => {
    const rows = buf
      .filter(l => !/^[\s|:+-]+$/.test(l))
      .map(l => {
        const parts = l.split('|').map(p => cleanWhitespace(p));
        if (parts.length && parts[0] === '') parts.shift();
        if (parts.length && parts[parts.length - 1] === '') parts.pop();
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
    if ((l.match(/\|/g) || []).length >= 2) buf.push(l);
    else if (buf.length) flush();
  });
  if (buf.length) flush();
  return tables;
}

/**
 * Finds the header row and returns the column map, or null when the table is
 * not a report table (a layout table, a signature block, an attendance count).
 */
export function mapHeaderRow(rows: Cell[][], masters: Masters, cfg: EngineConfig): HeaderMap | null {
  const scanLimit = Math.min(rows.length, 6);

  for (let r = 0; r < scanLimit; r++) {
    const mapping: Partial<Record<Field, number>> = {};
    let matches = 0;
    rows[r].forEach((cell, i) => {
      const field = normalizeHeader(cell.text, masters);
      if (field && !(field in mapping)) { mapping[field] = i; matches++; }
    });
    const hasRequired = REQUIRED.every(f => f in mapping);
    if (matches >= cfg.minHeaderMatches && hasRequired) {
      return { headerRowIndex: r, mapping, matches };
    }
  }
  // Relaxed pass: a table missing only ONE required column is still recognised,
  // so its rows fail validation individually with a precise reason instead of
  // the whole table vanishing silently.
  for (let r = 0; r < scanLimit; r++) {
    const mapping: Partial<Record<Field, number>> = {};
    let matches = 0;
    rows[r].forEach((cell, i) => {
      const field = normalizeHeader(cell.text, masters);
      if (field && !(field in mapping)) { mapping[field] = i; matches++; }
    });
    const reqHit = REQUIRED.filter(f => f in mapping).length;
    if (reqHit >= 3 && matches >= 3) {
      return { headerRowIndex: r, mapping, matches, partialHeader: true };
    }
  }
  return null;
}
