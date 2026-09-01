/**
 * The roster has to work whatever the report arrived as.
 *
 * Departments send different things: one attaches a workbook, one exports CSV,
 * one pastes the table into the mail, one sends a screenshot. Identity
 * resolution happens after parsing, so in principle it cannot tell them apart —
 * but "in principle" is how the department column ended up right on import and
 * wrong on re-file. Each format is therefore walked from its own parser through
 * to the stored department and the stored name.
 *
 * Every report below names the same two people the way their own team writes
 * them, and none of them names a department at all. That is the real shape of
 * Harshal's mail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDatabase } from './helpers';
import { parseRoster, rosterDepartmentId, rosterEmployeeId } from '../src/lib/roster';
import { csvToTables, xlsxToTables } from '../src/lib/core/attachments';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('every report format lands under the right department', () => {
  let db: any, seedDb: any, ingest: any, pipeline: any;
  const UID = 1;

  const ROWS = [
    ['Date', 'Employee', 'Task', 'Status'],
    ['30 Aug 2026', 'Usman', 'Approved the quarter plan', 'Completed'],
    ['30 Aug 2026', 'Rahul K', 'Updated the SOP index', 'In Progress']
  ];

  async function run(doc: any) {
    const masters = await db.loadMasters();
    return ingest.ingestDocument(doc, masters, pipeline.engineConfig(), new Map());
  }

  const expectFiled = (r: any) => {
    const byName = Object.fromEntries(r.accepted.map((t: any) => [t.employeeName, t.department]));
    // The roster's own spelling, not the report's.
    expect(byName['Usman Khan']).toBe('Management');
    expect(byName['Rahul Koli']).toBe('SOP');
    expect(Object.keys(byName)).not.toContain('Rahul K');
  };

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    ingest = await import('../src/lib/core/ingest');
    pipeline = await import('../src/lib/pipeline');
    await resetDatabase(db, seedDb, { demo: false });

    const parsed = parseRoster([
      'Team,Staff Member,Also known as',
      'Management,Usman Khan,Usman',
      'SOP,Rahul Koli,Rahul K'
    ].join('\n'));
    await db.upsertRoster(
      parsed.people.map((p: any) => ({ ...p, id: rosterEmployeeId(p.name) })),
      parsed.departments.map((x: any) => ({ ...x, id: rosterDepartmentId(x.name) }))
    );
  }, 60_000);

  afterAll(async () => { await db.getPool().end(); });

  it('a table pasted into the email body', async () => {
    expectFiled(await run({
      documentId: 'f-html', subject: 'FYI', sender: 'Team <team@1xl.com>',
      receivedAt: '2026-08-31T04:00:00.000Z',
      html: `<p>Today's update.</p><table>${
        ROWS.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
    }));
  });

  it('a CSV attachment', async () => {
    const tables = csvToTables(ROWS.map(r => r.join(',')).join('\n'), 'update.csv');
    expectFiled(await run({
      documentId: 'f-csv', subject: 'Monday', sender: 'Team <team@1xl.com>',
      receivedAt: '2026-08-31T04:00:00.000Z',
      tables, attachmentName: 'update.csv', contextText: 'Please find today\'s update attached.'
    }));
  });

  it('a tab-separated export', async () => {
    const tables = csvToTables(ROWS.map(r => r.join('\t')).join('\n'), 'update.tsv');
    expectFiled(await run({
      documentId: 'f-tsv', subject: 'update', sender: 'Team <team@1xl.com>',
      receivedAt: '2026-08-31T04:00:00.000Z', tables, attachmentName: 'update.tsv'
    }));
  });

  it('an Excel workbook', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Daily');
    ROWS.forEach(r => ws.addRow(r));
    const tables = await xlsxToTables(Buffer.from(await wb.xlsx.writeBuffer()));
    expectFiled(await run({
      documentId: 'f-xlsx', subject: 'Re: yesterday', sender: 'Team <team@1xl.com>',
      receivedAt: '2026-08-31T04:00:00.000Z',
      tables, attachmentName: 'final_v9.xlsx'
    }));
  });

  it('a workbook whose sheets are per department, with no department column', async () => {
    const wb = new ExcelJS.Workbook();
    const a = wb.addWorksheet('Sheet1');
    [ROWS[0], ROWS[1]].forEach(r => a.addRow(r));
    const b = wb.addWorksheet('Sheet2');
    [ROWS[0], ROWS[2]].forEach(r => b.addRow(r));
    const tables = await xlsxToTables(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(tables.length).toBeGreaterThanOrEqual(2);
    const r = await run({
      documentId: 'f-multi', subject: 'Sharing', sender: 'Team <team@1xl.com>',
      receivedAt: '2026-08-31T04:00:00.000Z', tables, attachmentName: 'Daily_Update.xlsx'
    });
    expectFiled(r);
    // One report spanning two departments must say so rather than picking one.
    expect(r.departments?.sort()).toEqual(['Management', 'SOP']);
  });

  it('a table transcribed from a screenshot', async () => {
    const tables = [{ rows: ROWS.map(r => r.map(text => ({ text, href: '' }))) }];
    expectFiled(await run({
      documentId: 'f-vision', subject: '', sender: 'Team <team@1xl.com>',
      receivedAt: '2026-08-31T04:00:00.000Z',
      tables, extractionSource: 'vision',
      contextText: 'Sending the screenshot of today\'s sheet.'
    }));
  });

  it('a linked Google Sheet, arriving as parsed tables', async () => {
    const tables = [{ rows: ROWS.map(r => r.map(text => ({ text, href: '' }))) }];
    expectFiled(await run({
      documentId: 'f-sheet', subject: 'Sharing', sender: 'Team <team@1xl.com>',
      receivedAt: '2026-08-31T04:00:00.000Z',
      tables, extractionSource: 'google-sheet',
      contextText: 'Today\'s update: https://docs.google.com/spreadsheets/d/abc/edit'
    }));
  });
});
