/**
 * Harshal's actual case, from the demo call.
 *
 * His teams send daily reports that carry NO department column. Usman Khan
 * belongs to Management, Rahul Koli belongs to SOP, and the reports say
 * neither. Before the roster is filled, every row of theirs lands in
 * "Unassigned" — which is exactly what he saw on screen.
 *
 * These tests pin the mechanism that fixes it: an employee on the roster
 * carries their department onto every row they appear in, whatever the report
 * says or fails to say. They also pin the honest half — an unknown name must
 * NOT be quietly given a department.
 */
import { describe, expect, it } from 'vitest';
import { ingestDocument } from '../src/lib/core/ingest';
import { engineConfig } from '../src/lib/pipeline';
import { seedMasters } from '../src/lib/seed';
import type { Masters, SourceDocument } from '../src/lib/core/types';

const cfg = engineConfig();
const noFingerprints = () => new Map<string, string>();

/** A roster like the one Harshal will send as a spreadsheet. */
function rosterMasters(): Masters {
  const m = seedMasters([]);
  return {
    ...m,
    employees: [
      { id: 'E1', name: 'Usman Khan', aliases: ['Usman'], department: 'Management', active: true },
      { id: 'E2', name: 'Rahul Koli', aliases: ['Rahul K', 'R Koli'], department: 'SOP', active: true }
    ],
    departments: [
      { id: 'D1', name: 'Management', aliases: [], senderDomains: [] },
      { id: 'D2', name: 'SOP', aliases: ['SOP Team'], senderDomains: [] }
    ]
  };
}

/** A daily report with no department column anywhere — his real shape. */
function report(rows: string[][]): SourceDocument {
  const body = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return {
    documentId: 'msg-' + rows.length + '-' + rows[1][0],
    subject: 'Daily report',
    sender: 'Team <team@1xl.com>',
    receivedAt: '2026-08-31T04:00:00.000Z',
    html: `<p>Please find today's update.</p><table>${body}</table>`
  };
}

describe("Harshal's roster decides the department", () => {
  const HEAD = ['Date', 'Employee', 'Task', 'Status'];

  it('puts a rostered employee in their own department, not Unassigned', () => {
    const r = ingestDocument(report([
      HEAD,
      ['30 Aug 2026', 'Usman Khan', 'Reviewed vendor contract', 'Completed'],
      ['30 Aug 2026', 'Rahul Koli', 'Updated the SOP index', 'In Progress']
    ]), rosterMasters(), cfg, noFingerprints());

    const byName = Object.fromEntries(r.accepted.map(t => [t.employeeName, t.department]));
    expect(byName['Usman Khan']).toBe('Management');
    expect(byName['Rahul Koli']).toBe('SOP');
    expect(Object.values(byName)).not.toContain('Unassigned');
  });

  it('recognises the short forms people actually type', () => {
    const r = ingestDocument(report([
      HEAD,
      ['30 Aug 2026', 'Rahul K', 'Filed the audit note', 'Completed'],
      ['30 Aug 2026', 'Usman', 'Approved the roster change', 'Completed']
    ]), rosterMasters(), cfg, noFingerprints());

    const depts = r.accepted.map(t => t.department).sort();
    expect(depts).toEqual(['Management', 'SOP']);
  });

  it('lets the roster override a department stated in the report', () => {
    // Someone files an SOP person's row under the wrong heading. The roster is
    // the organisation's own record and has to win, or one mistyped cell
    // silently moves a person between departments.
    const r = ingestDocument(report([
      ['Date', 'Employee', 'Task', 'Status', 'Department'],
      ['30 Aug 2026', 'Rahul Koli', 'Rewrote the checklist', 'Completed', 'Marketing']
    ]), rosterMasters(), cfg, noFingerprints());

    expect(r.accepted[0].department).toBe('SOP');
  });

  it('records the disagreement rather than hiding it', () => {
    const r = ingestDocument(report([
      ['Date', 'Employee', 'Task', 'Status', 'Department'],
      ['30 Aug 2026', 'Rahul Koli', 'Rewrote the checklist', 'Completed', 'Marketing']
    ]), rosterMasters(), cfg, noFingerprints());

    const note = r.accepted[0].dataQualityNotes || '';
    expect(note).toContain('Marketing');
    expect(note).toContain('SOP');
  });

  it('does NOT invent a department for someone who is not on the roster', () => {
    const r = ingestDocument(report([
      HEAD,
      ['30 Aug 2026', 'Someone Unlisted', 'Did a thing', 'Completed']
    ]), rosterMasters(), cfg, noFingerprints());

    const row = r.accepted[0];
    if (row) expect(['Management', 'SOP']).not.toContain(row.department);
  });
});
