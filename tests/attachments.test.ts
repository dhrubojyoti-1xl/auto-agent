/**
 * Attachment parsing: XLSX and CSV must reach the engine as the same tables an
 * inline HTML report produces, so a spreadsheet report is treated identically.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  attachmentToTables, csvToTables, isParsableAttachment, parseDelimited, xlsxToTables
} from '../src/lib/core/attachments';
import { mapHeaderRow } from '../src/lib/core/html-table';
import { ingestDocument } from '../src/lib/core/ingest';
import { seedMasters } from '../src/lib/seed';
import { DEFAULT_ENGINE_CONFIG } from '../src/lib/core/types';

const masters = seedMasters();
const cfg = DEFAULT_ENGINE_CONFIG;

describe('CSV parsing', () => {
  it('handles quotes, embedded commas and embedded newlines', () => {
    const csv = 'Date,Employee,Task,Status\n' +
      '29 Aug 2026,Rahul Mehta,"Update CRM, then email Acme",Completed\n' +
      '29 Aug 2026,Priya Sharma,"Call about ""urgent"" renewal",Pending\n' +
      '29 Aug 2026,Imran Khan,"Multi-line\ntask note",In Progress\n';
    const rows = parseDelimited(csv);
    expect(rows.length).toBe(4);
    expect(rows[1][2]).toBe('Update CRM, then email Acme');
    expect(rows[2][2]).toBe('Call about "urgent" renewal');
    expect(rows[3][2]).toContain('Multi-line');
  });

  it('sniffs tab and semicolon delimiters', () => {
    expect(parseDelimited('a\tb\tc\n1\t2\t3')[1]).toEqual(['1', '2', '3']);
    expect(parseDelimited('a;b;c\n1;2;3')[1]).toEqual(['1', '2', '3']);
  });

  it('strips a UTF-8 BOM so the first header still maps', () => {
    const tables = csvToTables('﻿Date,Employee,Task,Status\n29 Aug 2026,A,Task one,Done');
    const header = mapHeaderRow(tables[0].rows, masters, cfg);
    expect(header).toBeTruthy();
    expect(header?.mapping.date).toBe(0);
  });

  it('a CSV report imports through the normal pipeline', () => {
    const csv = 'Date,Employee Name,Task,Status,Link\n' +
      '29 Aug 2026,Rahul Mehta,Update CRM,Done,https://crm.example.com/1\n' +
      '29 Aug 2026,Priya Sharma,Follow up with Acme,WIP,\n';
    const r = ingestDocument({
      documentId: 'CSV-1', subject: 'Daily Report - Sales',
      sender: 'a@b.com', receivedAt: '2026-08-29T10:00:00Z',
      tables: csvToTables(csv), attachmentName: 'report.csv'
    }, masters, cfg, new Map());
    expect(r.accepted.length).toBe(2);
    expect(r.accepted[0].taskStatus).toBe('Completed');
    expect(r.accepted[1].taskStatus).toBe('In Progress');
    expect(r.accepted[0].link).toBe('https://crm.example.com/1');
  });
});

async function buildWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sales = wb.addWorksheet('Sales');
  sales.addRow(['Date', 'Employee Name', 'Task', 'Status', 'Start Time', 'End Time']);
  sales.addRow([new Date(Date.UTC(2026, 7, 29)), 'Rahul Mehta', 'Update CRM', 'Completed', '09:15', '09:50']);
  sales.addRow([new Date(Date.UTC(2026, 7, 29)), 'Imran Khan', 'Client call - Corvin onboarding', 'Done', '15:00', '17:45']);
  const notes = wb.addWorksheet('Notes');
  notes.addRow(['Anything', 'Else']);
  notes.addRow(['not', 'a report']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('XLSX parsing', () => {
  it('turns every sheet into a table', async () => {
    const tables = await xlsxToTables(await buildWorkbook());
    expect(tables.length).toBe(2);
    expect(tables[0].rows.length).toBe(3);
  });

  it('keeps real dates as yyyy-mm-dd instead of a localised string', async () => {
    const tables = await xlsxToTables(await buildWorkbook());
    expect(tables[0].rows[1][0].text).toBe('2026-08-29');
  });

  it('only the report sheet maps; the other is ignored', async () => {
    const tables = await xlsxToTables(await buildWorkbook());
    expect(mapHeaderRow(tables[0].rows, masters, cfg)).toBeTruthy();
    expect(mapHeaderRow(tables[1].rows, masters, cfg)).toBeNull();
  });

  it('an XLSX report imports, including derived durations', async () => {
    const tables = await attachmentToTables(
      'report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await buildWorkbook()
    );
    const r = ingestDocument({
      documentId: 'XLSX-1', subject: 'Daily Report - Sales',
      sender: 'a@b.com', receivedAt: '2026-08-29T10:00:00Z',
      tables, attachmentName: 'report.xlsx'
    }, masters, cfg, new Map());
    expect(r.accepted.length).toBe(2);
    expect(r.accepted[0].date).toBe('2026-08-29');
    expect(r.accepted[1].actualDuration).toBe(2.75);
    expect(r.accepted[1].durationBasis).toBe('Derived');
  });

  it('the same report as CSV and XLSX yields identical fingerprints', async () => {
    const xlsx = await attachmentToTables('r.xlsx', '', await buildWorkbook());
    const csv = csvToTables(
      'Date,Employee Name,Task,Status,Start Time,End Time\n' +
      '2026-08-29,Rahul Mehta,Update CRM,Completed,09:15,09:50\n' +
      '2026-08-29,Imran Khan,Client call - Corvin onboarding,Done,15:00,17:45\n');
    const a = ingestDocument({ documentId: 'A', subject: 's', sender: 'x@y.z',
      receivedAt: '2026-08-29T10:00:00Z', tables: xlsx }, masters, cfg, new Map());
    const b = ingestDocument({ documentId: 'A', subject: 's', sender: 'x@y.z',
      receivedAt: '2026-08-29T10:00:00Z', tables: csv }, masters, cfg, new Map());
    expect(b.accepted.map(t => t.taskFingerprint))
      .toEqual(a.accepted.map(t => t.taskFingerprint));
  });
});

describe('attachment type detection', () => {
  it('recognises spreadsheets and text tables, ignores the rest', () => {
    expect(isParsableAttachment('report.xlsx', '')).toBe(true);
    expect(isParsableAttachment('report.csv', '')).toBe(true);
    expect(isParsableAttachment('report.tsv', '')).toBe(true);
    expect(isParsableAttachment('r', 'application/vnd.ms-excel')).toBe(true);
    expect(isParsableAttachment('logo.png', 'image/png')).toBe(false);
    expect(isParsableAttachment('contract.pdf', 'application/pdf')).toBe(false);
  });

  it('an unreadable spreadsheet returns nothing rather than throwing', async () => {
    const tables = await attachmentToTables('old.xls', '', Buffer.from('not really a workbook'));
    expect(tables).toEqual([]);
  });
});
