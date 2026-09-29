/**
 * The 28-09-2026 review, item by item, against the engine.
 *
 *   - the company's DWR format (title line + question headings) imports
 *   - a DWR pasted from Google Sheets as tab-separated text imports
 *   - task titles never become employees ("Hr Meeting", "Content Team")
 *   - a report is attributed to its sender through the roster's email column
 *   - roster-only mode leaves people outside the roster out (the Dubai team)
 */
import { describe, expect, it } from 'vitest';
import { ingestDocument } from '../src/lib/core/ingest';
import { mapHeaderRow, extractTabTables } from '../src/lib/core/html-table';
import { fieldFromValues } from '../src/lib/core/column-values';
import { looksLikePersonName } from '../src/lib/core/person-name';
import { readBanner } from '../src/lib/core/banner';
import { DEFAULT_ENGINE_CONFIG } from '../src/lib/core/types';
import type { Employee, EngineConfig, SourceDocument } from '../src/lib/core/types';
import { seedMasters } from '../src/lib/seed';
import { pastedDocument } from '../src/lib/paste';

const cfg: EngineConfig = { ...DEFAULT_ENGINE_CONFIG };

const HEAD = ['Sr. No.', 'Company', 'Category', 'What was I supposed to do today?',
  'What did I do?', 'Did I do', 'Time taken (Minutes)', 'Comments / Links'];
const BANNER = 'DWR: 001 | Emp Name: Asha Rao | Designation | Date: 26/09/2026 | Day: Friday | Full Day';
const BODY = [
  ['1', 'Adhoc', 'SOP', 'Hr Meeting', 'Attended the HR meeting on the SOP audit plan', 'All', '45',
   'https://docs.google.com/document/d/abc123'],
  ['2', 'Adhoc', 'SOP', 'Attendance Monitoring', 'Checked attendance for the SOP team', 'Partial', '30', ''],
  ['3', 'Adhoc', 'SOP', 'Content Team review', '', 'No', '', 'Postponed to Monday'],
  // The template's unused lines: pre-filled, never written in.
  ['', 'Adhoc', '', '', '', 'All', '', ''],
  ['', 'Adhoc', '', '', '', 'All', '', ''],
  ['', 'Adhoc', '', '', '', 'All', '', '']
];

function dwrHtml(banner = BANNER): string {
  const cell = (v: string) => `<td>${v}</td>`;
  return '<table>' +
    '<tr><td colspan="8"></td></tr>' +
    `<tr><td colspan="8">${banner}</td></tr>` +
    `<tr>${HEAD.map(cell).join('')}</tr>` +
    BODY.map(r => `<tr>${r.map(cell).join('')}</tr>`).join('') +
    '</table>';
}

function dwrTsv(): string {
  return [
    '\t\t\t\t\t\t\t',
    BANNER + '\t\t\t\t\t\t\t',
    HEAD.join('\t'),
    ...BODY.map(r => r.join('\t'))
  ].join('\n');
}

function doc(over: Partial<SourceDocument>): SourceDocument {
  return {
    documentId: 'doc-' + Math.random().toString(36).slice(2),
    subject: 'DWR', sender: 'dashboard@local', receivedAt: '2026-09-28T10:00:00Z',
    ...over
  };
}

function rosterMasters(extra: Employee[] = []) {
  return seedMasters([
    { id: 'EMP-AR', name: 'Asha Rao', aliases: [], department: 'SOP', active: true,
      email: 'asha.rao@example.com', onRoster: true },
    { id: 'EMP-VN', name: 'Vikram Nair', aliases: [], department: 'Content', active: true,
      email: 'vikram@example.com', onRoster: true },
    ...extra
  ]);
}

describe('the DWR format imports as it is', () => {
  it('reads the author and the day from the title line', () => {
    expect(readBanner([[{ text: BANNER, href: '' }]], 'DMY')).toMatchObject({
      employee: 'Asha Rao', date: '2026-09-26'
    });
    // The blank template states nothing.
    expect(readBanner([[{ text: 'DWR: 001 | Emp Name:  | Designation | Date:  | Day:  | Full Day',
      href: '' }]], 'DMY')).toBeNull();
  });

  it('maps the question headings', () => {
    const tables = [{ index: 0, source: 'html' as const, rows: [
      [{ text: BANNER, href: '' }],
      HEAD.map(text => ({ text, href: '' })),
      ...BODY.map(r => r.map(text => ({ text, href: '' })))
    ] }];
    const h = mapHeaderRow(tables[0].rows, seedMasters([]), cfg)!;
    expect(h).not.toBeNull();
    expect(h.headerRowIndex).toBe(1);
    expect(h.mapping).toMatchObject({
      category: 2, plannedTask: 3, task: 4, status: 5, actualDuration: 6, notes: 7
    });
    expect(h.mapping.employee).toBeUndefined();
    expect(h.banner?.employee).toBe('Asha Rao');
  });

  it('imports the three written rows and nothing from the unused ones', () => {
    const res = ingestDocument(doc({ html: dwrHtml() }), seedMasters([]), cfg, new Map());
    expect(res.rejected).toEqual([]);
    expect(res.accepted).toHaveLength(3);
    for (const t of res.accepted) {
      expect(t.employeeName).toBe('Asha Rao');
      expect(t.date).toBe('2026-09-26');
    }
    const [a, b, c] = res.accepted;
    expect([a.taskStatus, b.taskStatus, c.taskStatus]).toEqual(['Completed', 'In Progress', 'Pending']);
    // Minutes, not hours.
    expect(a.actualDuration).toBe(0.75);
    expect(b.actualDuration).toBe(0.5);
    // An empty "What did I do?" still names the work it was meant to be.
    expect(c.task).toBe('Content Team review');
    expect(a.notes).toContain('Planned: Hr Meeting');
    expect(a.link).toBe('https://docs.google.com/document/d/abc123');
    // No task title became a person.
    expect(res.newEmployees.map(e => e.name)).toEqual(['Asha Rao']);
  });

  it('imports the same sheet pasted as tab-separated text', () => {
    expect(extractTabTables(dwrTsv())).toHaveLength(1);
    const res = ingestDocument(doc({ text: dwrTsv() }), seedMasters([]), cfg, new Map());
    expect(res.status).toBe('SUCCESS');
    expect(res.accepted.map(t => t.employeeName)).toEqual(['Asha Rao', 'Asha Rao', 'Asha Rao']);
  });

  it('keeps a quoted cell with a line break in one piece', () => {
    const tsv = 'Date\tEmployee\tTask\tStatus\n' +
      '26/09/2026\tAsha Rao\t"Fixed login\nand signup"\tDone\n' +
      '26/09/2026\tAsha Rao\tWrote the SOP draft\tDone';
    const res = ingestDocument(doc({ text: tsv }), seedMasters([]), cfg, new Map());
    expect(res.accepted.map(t => t.task)).toEqual(['Fixed login and signup', 'Wrote the SOP draft']);
  });

  it('only reads "All" and "No" as statuses under a question heading', () => {
    const html = '<table><tr><td>Date</td><td>Employee</td><td>Task</td><td>Status</td></tr>' +
      '<tr><td>26/09/2026</td><td>Asha Rao</td><td>Checked the audit sheet</td><td>All</td></tr></table>';
    const res = ingestDocument(doc({ html }), seedMasters([]), cfg, new Map());
    expect(res.rejected[0]?.reason).toBe('UNKNOWN_STATUS');
  });
});

describe('task titles are never employees', () => {
  const TITLES = ['Hr Meeting', 'Attendance Monitoring', 'Content Team', 'Hr Capability Building – Sr',
    'Recruitment – Senior Relationship Manager', 'Internal Communication – Newsletter',
    'Employee Engagement – Diwali', '2026 Event Calendar', '2nd Round Interview',
    '90-Day Plan – Asha', 'Priya – Biometric Coordination', 'Asset Acknowledgement',
    'Hr Meeting & Task Priorities',
    '1) Address Remaining Qa Tickets(45 Defects) Across Referrals, Coupons, Plans'];
  const PEOPLE = ['Asha Rao', 'Vikram Nair', 'Karan Mehta', 'Imran Shaikh', 'Leela S',
    'Raghavan KP', 'Lakshmi Devi Reddy', 'Subhajit Chattopadhyay', 'Asha', "D'Souza"];

  it('recognises what the live Data quality page listed as people as not people', () => {
    // Records an earlier importer created, as they appeared on 29-09-2026.
    for (const t of ['Admin Panel', 'Influencer Panel', 'Dubai', 'New Delhi', 'Greater Noida',
      'India Today Group', 'Human Resource', 'Travel Reimbursement', 'Welcome Kit',
      'Warning Letter', 'Cv Database', 'Organisational Chart', 'Welfare Committee',
      'Doj Confirmation', 'Birthday Posters', 'Probation Tracking', 'Google Sheets', 'Na',
      'Jainam & Jivika Jain', 'Content Team', 'Response Submiited', 'Gmail Account',
      'Internship Completion Certificate', 'New Joiner System Access']) {
      expect(looksLikePersonName(t), t).toBe(false);
    }
  });

  it('recognises the review screenshots as work, and the roster as people', () => {
    for (const t of TITLES) expect(looksLikePersonName(t), t).toBe(false);
    for (const p of PEOPLE) expect(looksLikePersonName(p), p).toBe(true);
  });

  it('a column of short task titles is not a column of names', () => {
    const values = ['Hr Meeting', 'Attendance Monitoring', 'Content Team', 'Hr Meeting',
      'Attendance Monitoring', 'Hr Meeting'];
    expect(fieldFromValues(values, seedMasters([]), cfg)?.field).not.toBe('employee');
  });

  it('files a report with no name column under its sender, not its topics', () => {
    const html = '<table><tr><td>Date</td><td>Topic today</td><td>Work done</td><td>Status</td></tr>' +
      ['Hr Meeting', 'Attendance Monitoring', 'Content Team', 'Hr Meeting'].map((t, i) =>
        `<tr><td>26/09/2026</td><td>${t}</td><td>Handled item number ${i + 1} for the team</td>` +
        '<td>Completed</td></tr>').join('') + '</table>';
    const res = ingestDocument(
      doc({ html, sender: 'Asha Rao <asha.rao@example.com>' }), seedMasters([]), cfg, new Map());
    expect(res.accepted).toHaveLength(4);
    expect(new Set(res.accepted.map(t => t.employeeName))).toEqual(new Set(['Asha Rao']));
  });
});

describe('the roster decides who a report belongs to', () => {
  const TABLE = '<table><tr><td>Date</td><td>Task</td><td>Status</td><td>Remarks</td></tr>' +
    '<tr><td>26/09/2026</td><td>Prepared the SOP index</td><td>Done</td><td></td></tr>' +
    '<tr><td>26/09/2026</td><td>Reviewed two SOP drafts</td><td>WIP</td><td></td></tr></table>';

  it('matches the sender by email, whatever the mail client calls them', () => {
    const res = ingestDocument(doc({ html: TABLE, sender: 'AR Phone <Asha.Rao@example.com>' }),
      rosterMasters(), cfg, new Map());
    expect(res.accepted.map(t => [t.employeeName, t.department]))
      .toEqual([['Asha Rao', 'SOP'], ['Asha Rao', 'SOP']]);
    expect(res.newEmployees).toEqual([]);
  });

  it('a dashboard paste is never filed under a person called "Dashboard"', () => {
    const res = ingestDocument(doc({ html: TABLE }), rosterMasters(), cfg, new Map());
    expect(res.accepted).toEqual([]);
    expect(res.rejected[0].detail).toMatch(/Employee name is empty/);
    const named = ingestDocument(doc({ html: TABLE, statedEmployee: 'Vikram Nair' }),
      rosterMasters(), cfg, new Map());
    expect(named.accepted.map(t => t.employeeName)).toEqual(['Vikram Nair', 'Vikram Nair']);
  });

  it('roster-only mode leaves people outside the roster out, without rejecting them', () => {
    const html = '<table><tr><td>Date</td><td>Employee</td><td>Task</td><td>Status</td></tr>' +
      '<tr><td>26/09/2026</td><td>Asha Rao</td><td>Prepared the SOP index</td><td>Done</td></tr>' +
      '<tr><td>26/09/2026</td><td>Omar Farooq</td><td>Dubai showroom visit</td><td>Done</td></tr>' +
      '<tr><td>26/09/2026</td><td>Omar Farooq</td><td>Dubai vendor call</td><td>Done</td></tr></table>';
    const off = ingestDocument(doc({ html }), rosterMasters(), cfg, new Map());
    expect(off.accepted).toHaveLength(3);

    const on = ingestDocument(doc({ html }), rosterMasters(), { ...cfg, rosterOnly: true }, new Map());
    expect(on.accepted.map(t => t.employeeName)).toEqual(['Asha Rao']);
    expect(on.rejected).toEqual([]);
    expect(on.newEmployees).toEqual([]);
    expect(on.outsideRoster).toEqual([{ name: 'Omar Farooq', rows: 2 }]);
    expect(on.message).toMatch(/2 left out as not on the team roster \(Omar Farooq\)/);
  });

  it('roster-only mode does nothing until a roster exists', () => {
    const res = ingestDocument(doc({ html: TABLE, sender: 'A <a@x.com>' }), seedMasters([]),
      { ...cfg, rosterOnly: true }, new Map());
    expect(res.accepted).toHaveLength(2);
  });
});

describe('Manual entry', () => {
  it('carries the optional name and date, and keeps the id stable without them', () => {
    const plain = pastedDocument({ content: 'a\tb\nc\td' }, 'DMY');
    expect(plain.documentId).toBe(pastedDocument({ content: 'a\tb\nc\td' }, 'DMY').documentId);
    expect(plain.statedEmployee).toBeUndefined();
    const named = pastedDocument({ content: 'a\tb\nc\td', employee: ' Asha Rao ', date: '26/09/2026' }, 'DMY');
    expect(named.statedEmployee).toBe('Asha Rao');
    expect(named.titleDate?.date).toBe('2026-09-26');
    expect(named.documentId).not.toBe(plain.documentId);
    expect(pastedDocument({ content: '<table><tr><td>x</td></tr></table>' }, 'DMY').html).toBeTruthy();
  });
});
