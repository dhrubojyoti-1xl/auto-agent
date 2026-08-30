/**
 * The half of a report that is not in the table.
 *
 * "Sales team update for yesterday" arrives as a sentence above a spreadsheet
 * whose columns say neither Sales nor a date, because the sender already said
 * both. Treating the covering line and the attachment as unrelated documents
 * throws away the only evidence of which department the report is for and
 * which day it covers.
 */
import { describe, expect, it } from 'vitest';
import { contextLooksPlanned, departmentFromEvidence, inferReportDate } from '../src/lib/core/evidence';
import { ingestDocument } from '../src/lib/core/ingest';
import { extractPipeTables } from '../src/lib/core/html-table';
import { seedMasters } from '../src/lib/seed';
import { engineConfig } from '../src/lib/pipeline';

const cfg = engineConfig();
const masters = seedMasters([]);

describe('reading the department out of the covering text', () => {
  it('finds it in the body when the subject says nothing', () => {
    const e = departmentFromEvidence(
      { subject: 'FYI', body: 'Please find the Sales team update attached.' }, masters, cfg);
    expect(e?.department).toBe('Sales');
    expect(e?.source).toBe('body');
  });

  it('finds it in an attachment name', () => {
    const e = departmentFromEvidence(
      { subject: 'Monday', attachmentName: 'marketing-aug.xlsx' }, masters, cfg);
    expect(e?.department).toBe('Marketing');
    expect(e?.source).toBe('attachment name');
  });

  it('finds it in a worksheet name', () => {
    const e = departmentFromEvidence({ subject: 'x', sheetName: 'Operations' }, masters, cfg);
    expect(e?.department).toBe('Operations');
    expect(e?.source).toBe('sheet name');
  });

  it('prefers the covering sentence to the subject', () => {
    const e = departmentFromEvidence(
      { subject: 'Marketing weekly', body: 'This is the Sales report.' }, masters, cfg);
    expect(e?.department).toBe('Sales');
  });

  it('invents nothing when nothing names a department', () => {
    expect(departmentFromEvidence(
      { subject: 'Fwd: Re: hello', body: 'here you go' }, masters, cfg)).toBeNull();
    expect(departmentFromEvidence(
      { subject: 'Frobnication weekly' }, masters, cfg)).toBeNull();
  });
});

describe('reading the reporting day out of the covering text', () => {
  const sent = '2026-08-30T09:00:00.000Z';

  it('reads "yesterday\'s update" as the day before it was sent', () => {
    const d = inferReportDate({ body: "Yesterday's update from the team.", receivedAt: sent }, cfg);
    expect(d?.date).toBe('2026-08-29');
    expect(d?.basis).toBe('relative to send date');
    expect(d?.quote).toMatch(/yesterday/i);
  });

  it("reads today's report as the day it was sent", () => {
    expect(inferReportDate({ body: "Today's work report attached.", receivedAt: sent }, cfg)?.date)
      .toBe('2026-08-30');
  });

  it('reads a date written out in the body', () => {
    const d = inferReportDate({ body: 'Operations update for 28 Aug 2026.', receivedAt: sent }, cfg);
    expect(d?.date).toBe('2026-08-28');
    expect(d?.basis).toBe('stated in body');
  });

  it('never uses the arrival date on its own', () => {
    // A report sent on Monday about Friday's work is not Monday's work, and
    // stamping it with the send date invents activity on a day nobody worked.
    expect(inferReportDate({ body: 'Please see attached.', receivedAt: sent }, cfg)).toBeNull();
    expect(inferReportDate({ subject: 'FYI', body: '', receivedAt: sent }, cfg)).toBeNull();
  });

  it('does not date a plan as though it had happened', () => {
    expect(inferReportDate({ body: "Tomorrow's plan attached.", receivedAt: sent }, cfg)).toBeNull();
    expect(contextLooksPlanned("Tomorrow's plan attached.")).toBe(true);
  });

  it('ignores the word in ordinary prose', () => {
    expect(inferReportDate(
      { body: 'I mentioned yesterday that the printer is broken.', receivedAt: sent }, cfg))
      .toBeNull();
  });
});

describe('a spreadsheet and its covering sentence are one report', () => {
  const tables = extractPipeTables(
    'Employee|Work Done|State\n' +
    'Rahul Mehta|Call the client|Completed\n' +
    'Priya Sharma|Prepare the quote|Ongoing\n');

  const res = ingestDocument({
    documentId: 'combined', subject: 'FYI',
    sender: 'Team Lead <lead@co.com>',
    receivedAt: '2026-08-30T09:00:00.000Z',
    contextText: "Sales team update for yesterday. Please find it attached.",
    attachmentName: 'update.xlsx', tables
  }, masters, cfg, new Map());

  it('imports rows whose table has neither a date nor a department column', () => {
    expect(res.accepted).toHaveLength(2);
    expect(res.rejected).toHaveLength(0);
  });

  it('takes the department from the sentence', () => {
    expect(res.accepted.every(a => a.department === 'Sales')).toBe(true);
  });

  it('takes the reporting day from the sentence, not the send date', () => {
    expect(res.accepted.every(a => a.date === '2026-08-29')).toBe(true);
  });

  it('records where the date came from, so the inference is inspectable', () => {
    expect(res.accepted[0].dataQualityNotes).toMatch(/Date taken from the email/i);
    expect(res.accepted[0].dataQualityNotes).toMatch(/yesterday/i);
  });

  it('still reads each employee from their own row', () => {
    expect(res.accepted.map(a => a.employeeName).sort())
      .toEqual(['Priya Sharma', 'Rahul Mehta']);
  });

  it('refuses the rows when the covering text says nothing about a day', () => {
    const bare = ingestDocument({
      documentId: 'bare', subject: 'FYI', sender: 'lead@co.com',
      receivedAt: '2026-08-30T09:00:00.000Z',
      contextText: 'Please find it attached.', tables
    }, masters, cfg, new Map());
    expect(bare.accepted).toHaveLength(0);
    expect(bare.rejected[0].detail).toMatch(/says nothing about which day/i);
  });
});
