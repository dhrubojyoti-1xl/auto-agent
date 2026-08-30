/**
 * Tables as people actually build them.
 *
 * A spreadsheet somebody maintains by hand has a title across the top, a
 * grouping row above the real column names, blank rows between sections, a
 * totals line at the bottom, and the report table sitting below an unrelated
 * one. None of that is malformed — it is what a human-maintained report looks
 * like — and all of it has to survive the trip into the database.
 */
import { describe, expect, it } from 'vitest';
import { extractPipeTables, extractTables, mapHeaderRow } from '../src/lib/core/html-table';
import { ingestDocument } from '../src/lib/core/ingest';
import { seedMasters } from '../src/lib/seed';
import { engineConfig } from '../src/lib/pipeline';

const cfg = engineConfig();
const masters = seedMasters([]);
const cells = (row: string[]) => row.map(text => ({ text, href: '' }));

describe('a header split across two rows', () => {
  const rows = [
    cells(['DAILY REPORT', '', '', '', '']),
    cells(['Date', 'Employee Information', '', 'Work Details', '']),
    cells(['', 'Name', 'Department', 'Task', 'Status'])
  ];

  it('is reconstructed from both rows together', () => {
    const header = mapHeaderRow(rows, masters, cfg);
    expect(header).not.toBeNull();
    expect(header!.mapping.employee).toBe(1);     // "Name", from the lower row
    expect(header!.mapping.department).toBe(2);
    expect(header!.mapping.task).toBe(3);
    expect(header!.mapping.status).toBe(4);
  });

  it('starts the data after the lower row, not the upper one', () => {
    expect(mapHeaderRow(rows, masters, cfg)!.headerRowIndex).toBe(2);
  });

  it('the more specific row wins a column both rows claim', () => {
    // Upper row says "Work Details" at 3; lower says "Task" at 3. Same answer,
    // but the lower row is the one that must decide.
    const header = mapHeaderRow(rows, masters, cfg)!;
    expect(header.mapping.task).toBe(3);
  });
});

describe('a report inside a messy sheet', () => {
  const html = `
    <div>
      <p>Morning all, here is the team's report.</p>
      <table>
        <tr><th>Office</th><th>Phone</th></tr>
        <tr><td>Mumbai</td><td>555</td></tr>
      </table>
      <table>
        <tr><td colspan="5">TEAM DAILY REPORT — August</td></tr>
        <tr><td></td><td></td><td></td><td></td><td></td></tr>
        <tr><th>Date</th><th>Staff Member</th><th>Division</th>
            <th>Work Done Today</th><th>Current State</th></tr>
        <tr><td>12 Aug 2026</td><td>Priya Sharma</td><td>Sales</td>
            <td>Call the client</td><td>Completed</td></tr>
        <tr><td></td><td></td><td></td><td></td><td></td></tr>
        <tr><td>12 Aug 2026</td><td>Imran Khan</td><td>Sales</td>
            <td>Prepare the quote</td><td>Ongoing</td></tr>
        <tr><td>TOTAL</td><td></td><td></td><td>2 tasks</td><td></td></tr>
      </table>
    </div>`;

  const result = ingestDocument({
    documentId: 'messy', subject: 'FYI', sender: 'Lead <lead@co.com>',
    receivedAt: '2026-08-12T09:00:00.000Z', html
  }, masters, cfg, new Map());

  it('picks the report table, not the office-details table', () => {
    expect(result.accepted).toHaveLength(2);
  });

  it('skips the title row, the blank rows and the totals row', () => {
    expect(result.accepted.map(a => a.task).sort())
      .toEqual(['Call the client', 'Prepare the quote']);
    expect(result.rejected).toHaveLength(0);
  });

  it('reads both employees, not just the sender', () => {
    expect(result.accepted.map(a => a.employeeName).sort())
      .toEqual(['Imran Khan', 'Priya Sharma']);
  });

  it('understands every column name, none of which is configured', () => {
    const [first] = result.accepted;
    expect(first.department).toBe('Sales');
    expect(first.taskStatus).toBe('Completed');
    expect(first.date).toBe('2026-08-12');
  });
});

describe('columns in an order nobody agreed', () => {
  it('reads the same report however the columns are arranged', () => {
    const a = extractPipeTables(
      'Date|Employee|Task|Status\n12 Aug 2026|Priya Sharma|Call client|Done\n');
    const b = extractPipeTables(
      'Status|Task|Employee|Date\nDone|Call client|Priya Sharma|12 Aug 2026\n');

    const ingest = (tables: ReturnType<typeof extractPipeTables>) => ingestDocument({
      documentId: 'order', subject: 's', sender: 'x@y.com',
      receivedAt: '2026-08-12T09:00:00.000Z', tables
    }, masters, cfg, new Map()).accepted[0];

    const one = ingest(a), two = ingest(b);
    expect(one.employeeName).toBe(two.employeeName);
    expect(one.task).toBe(two.task);
    expect(one.taskStatus).toBe(two.taskStatus);
    expect(one.date).toBe(two.date);
  });
});

describe('several departments in one sheet', () => {
  it('keeps each row under its own department', () => {
    const tables = extractPipeTables(
      'Date|Employee|Dept|Task|Status\n' +
      '12 Aug 2026|Priya Sharma|Sales|Call client|Done\n' +
      '12 Aug 2026|Neha Gupta|Marketing|Write copy|Done\n' +
      '12 Aug 2026|Vikas Nair|Operations|Ship orders|Ongoing\n');
    const res = ingestDocument({
      documentId: 'multi', subject: 'All teams', sender: 'lead@co.com',
      receivedAt: '2026-08-12T09:00:00.000Z', tables
    }, masters, cfg, new Map());
    expect(res.accepted.map(a => a.department).sort())
      .toEqual(['Marketing', 'Operations', 'Sales']);
  });
});

describe('an unrelated table is still not a report', () => {
  it('refuses an invoice however table-shaped it is', () => {
    const tables = extractTables(
      '<table><tr><th>Item</th><th>Quantity</th><th>Unit Price</th><th>Amount</th></tr>' +
      '<tr><td>Hosting</td><td>2</td><td>250</td><td>500</td></tr></table>');
    expect(mapHeaderRow(tables[0].rows, masters, cfg)).toBeNull();
  });

  it('refuses a newsletter table', () => {
    const tables = extractTables(
      '<table><tr><th>Headline</th><th>Author</th><th>Section</th></tr>' +
      '<tr><td>A</td><td>B</td><td>C</td></tr></table>');
    expect(mapHeaderRow(tables[0].rows, masters, cfg)).toBeNull();
  });
});
