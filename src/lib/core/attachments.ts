/**
 * Attachment parsing — XLSX/XLSM and CSV/TSV into the same Table shape the
 * HTML parser produces, so everything downstream (header mapping, validation,
 * normalisation, fingerprinting) is entirely unchanged.
 *
 * Departments send spreadsheets at least as often as inline tables, so this is
 * not an optional extra: without it the assistant silently ignores half the
 * reports it is shown.
 */
import type { Cell, Table } from './types';
import { cleanWhitespace } from './normalize';

export const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'];
export const TEXT_TABLE_EXTENSIONS = ['.csv', '.tsv', '.txt'];

export function isSpreadsheetAttachment(filename: string, mimeType = ''): boolean {
  const f = filename.toLowerCase();
  return SPREADSHEET_EXTENSIONS.some(e => f.endsWith(e)) ||
    /spreadsheetml|ms-excel/.test(mimeType.toLowerCase());
}

export function isTextTableAttachment(filename: string, mimeType = ''): boolean {
  const f = filename.toLowerCase();
  return TEXT_TABLE_EXTENSIONS.some(e => f.endsWith(e)) ||
    /text\/csv|text\/tab-separated/.test(mimeType.toLowerCase());
}

export function isParsableAttachment(filename: string, mimeType = ''): boolean {
  return isSpreadsheetAttachment(filename, mimeType) || isTextTableAttachment(filename, mimeType);
}

/* -------------------------------------------------------------------------- */
/* CSV / TSV                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * RFC 4180 parser. Hand-written rather than pulled from a dependency because
 * the awkward cases are the whole job: quoted fields containing the delimiter,
 * escaped quotes (""), and embedded newlines inside a quoted field. A naive
 * split(',') mangles exactly the rows people care about — task descriptions
 * with commas in them.
 */
export function parseDelimited(content: string, delimiter?: string): string[][] {
  const text = content.replace(/^﻿/, '');          // strip BOM
  const delim = delimiter || sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter(r => r.some(v => cleanWhitespace(v)));
}

function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts: Record<string, number> = {
    ',': (sample.match(/,/g) || []).length,
    '\t': (sample.match(/\t/g) || []).length,
    ';': (sample.match(/;/g) || []).length,
    '|': (sample.match(/\|/g) || []).length
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}

export function csvToTables(content: string, filename = ''): Table[] {
  const delim = filename.toLowerCase().endsWith('.tsv') ? '\t' : undefined;
  const rows = parseDelimited(content, delim);
  if (rows.length < 2) return [];
  return [{ index: 0, source: 'text', rows: rows.map(toCells) }];
}

function toCells(values: string[]): Cell[] {
  return values.map(v => {
    const text = cleanWhitespace(v);
    const url = text.match(/https?:\/\/\S+/);
    return { text, href: url ? url[0] : '' };
  });
}

/* -------------------------------------------------------------------------- */
/* XLSX                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every worksheet becomes its own Table, because a workbook routinely holds one
 * sheet per department. Sheets that are not reports simply fail header mapping
 * later and are skipped, so there is no need to guess here.
 */
export async function xlsxToTables(buffer: Buffer): Promise<Table[]> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const tables: Table[] = [];
  wb.eachSheet(sheet => {
    const rows: Cell[][] = [];
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells: Cell[] = [];
      const values = row.values as unknown[];
      // exceljs uses 1-based indexing and puts a hole at [0].
      for (let c = 1; c < values.length; c++) {
        cells[c - 1] = cellToCell(values[c]);
      }
      for (let i = 0; i < cells.length; i++) if (!cells[i]) cells[i] = { text: '', href: '' };
      if (cells.some(x => x.text)) rows.push(cells);
    });
    if (rows.length >= 2) tables.push({ index: tables.length, source: 'text', rows });
  });
  return tables;
}

function cellToCell(value: unknown): Cell {
  if (value === null || value === undefined) return { text: '', href: '' };

  // A real Date must not be stringified through the locale — that is how
  // 03/04 flips between March and April on its way into the database.
  if (value instanceof Date) {
    const iso = value.toISOString().slice(0, 10);
    return { text: iso, href: '' };
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string' && v.hyperlink) {
      return { text: cleanWhitespace(v.text), href: String(v.hyperlink) };
    }
    if (Array.isArray(v.richText)) {
      return {
        text: cleanWhitespace((v.richText as { text: string }[]).map(r => r.text).join('')),
        href: ''
      };
    }
    if (v.result !== undefined) return cellToCell(v.result);   // formula cell
    if (typeof v.text === 'string') return { text: cleanWhitespace(v.text), href: '' };
    if (typeof v.hyperlink === 'string') return { text: String(v.hyperlink), href: String(v.hyperlink) };
    return { text: '', href: '' };
  }
  const text = cleanWhitespace(String(value));
  const url = text.match(/https?:\/\/\S+/);
  return { text, href: url ? url[0] : '' };
}

/** Dispatches on filename/mime. Returns [] for anything not table-shaped. */
export async function attachmentToTables(
  filename: string, mimeType: string, buffer: Buffer
): Promise<Table[]> {
  if (isSpreadsheetAttachment(filename, mimeType)) {
    try {
      return await xlsxToTables(buffer);
    } catch {
      // .xls (old binary format) is not readable by exceljs. Fall through so
      // the caller records it honestly rather than pretending it was empty.
      return [];
    }
  }
  if (isTextTableAttachment(filename, mimeType)) {
    return csvToTables(buffer.toString('utf8'), filename);
  }
  return [];
}
