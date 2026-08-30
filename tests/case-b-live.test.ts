/**
 * CASE B, exactly as the image is.
 *
 * The screenshot is clipped at the right edge: the status column's heading
 * reads "Current St", cut off mid-word. Reading headings alone threw the whole
 * report away over a truncated word, while the column beneath it was plainly
 * eight statuses. This is the contract that the column's contents decide when
 * its heading cannot.
 *
 * There is no date column anywhere in the table. The day comes from the title
 * line printed above it.
 */
import { describe, expect, it } from 'vitest';
import { detectInTables } from '../src/lib/core/detect';
import { ingestDocument } from '../src/lib/core/ingest';
import { dateFromTitle, verifyVisionTable, visionTableToRows } from '../src/lib/core/vision';
import type { VisionTable } from '../src/lib/core/vision';
import { seedMasters } from '../src/lib/seed';
import { engineConfig } from '../src/lib/pipeline';

const masters = seedMasters([]);
const cfg = engineConfig();
const TITLE = 'DAILY WORK UPDATE — 30 AUGUST 2026';

/** The header as the image actually renders it — clipped. */
const HEADERS = ['Staff Member', 'Team / Division', 'Work Item',
                 'What Was Done Today', 'Current St'];

const ROWS: string[][] = [
  ['Dhrubo Ganguly', 'AI & Technology', 'AI Integration in SaaS',
   'Integrated the AI workflow into the SaaS reporting module, tested API responses, and fixed two validation issues.', 'Completed'],
  ['Rahul Mehta', 'Sales', 'Client Follow-up',
   'Followed up with 8 existing clients, discussed renewal requirements, and scheduled 3 follow-up calls.', 'Completed'],
  ['Priya Sharma', 'HR', 'Employee Onboarding',
   'Completed onboarding documentation for two new employees and verified their joining paperwork.', 'In Progress'],
  ['Arjun Sen', 'Operations', 'Vendor Reconciliation',
   'Compared vendor invoices with delivery records and identified four mismatched entries for correction.', 'Pending'],
  ['Mita Roy', 'Marketing', 'Campaign Performance Review',
   'Reviewed campaign performance, identified the three highest-performing creatives, and prepared optimisation notes.', 'Completed'],
  ['Dhrubo Ganguly', 'AI & Technology', 'Dashboard Visual Improvements',
   'Improved KPI hierarchy, chart readability, department cards, and management attention indicators.', 'Completed'],
  ['Rahul Mehta', 'Sales', 'New Lead Research',
   'Reviewed 15 prospective accounts and shortlisted 6 companies for the next outreach cycle.', 'Completed'],
  ['Priya Sharma', 'HR', 'Policy Update',
   'Drafted the revised leave-policy communication and prepared the employee announcement for tomorrow.', 'Planned']
];

const table: VisionTable = {
  declaredRows: 8, declaredColumns: 5, title: TITLE, headers: HEADERS,
  rows: ROWS.map(r => r.map(text => ({ text, confidence: 0.96 })))
};

describe('the clipped screenshot', () => {
  it('passes every structural check', () => {
    expect(verifyVisionTable(table, masters).ok).toBe(true);
  });

  it('is recognised as a report despite a heading cut off mid-word', () => {
    const grid = visionTableToRows(table);
    const rows = grid.map(r => r.map(text => ({ text, href: '' })));
    const signal = detectInTables([{ index: 0, source: 'text', rows }], masters, cfg);
    expect(signal.isReport, signal.reason).toBe(true);
  });
});

describe('Case B imports as the brief requires', () => {
  const grid = visionTableToRows(table);
  const res = ingestDocument({
    documentId: 'case-b-live', subject: 'Daily report',
    sender: 'Dhrubo <someone@example.com>',
    receivedAt: '2026-08-30T11:16:00.000Z',
    extractionSource: 'vision',
    titleDate: dateFromTitle(TITLE) || undefined,
    tables: [{ index: 0, source: 'text',
               rows: grid.map(r => r.map(text => ({ text, href: '' }))) }]
  }, masters, cfg, new Map());

  it('imports all eight rows, rejecting none', () => {
    expect(res.rejected.map(r => `${r.reason}: ${r.detail}`)).toEqual([]);
    expect(res.accepted).toHaveLength(8);
  });

  it('finds five employees', () => {
    expect(new Set(res.accepted.map(a => a.employeeName)).size).toBe(5);
  });

  it('finds five departments, none of them invented', () => {
    expect(res.departments?.sort()).toEqual(
      ['AI & Technology', 'HR', 'Marketing', 'Operations', 'Sales']);
  });

  it('leaves the report-level department empty, because the rows disagree', () => {
    expect(res.department).toBe('');
  });

  it('splits the statuses 5 / 1 / 1, with the eighth planned', () => {
    const counts: Record<string, number> = {};
    for (const a of res.accepted) counts[a.taskStatus] = (counts[a.taskStatus] || 0) + 1;
    expect(counts.Completed).toBe(5);
    expect(counts['In Progress']).toBe(1);
    expect(counts.Pending).toBe(1);
    expect(counts['Not Started']).toBe(1);          // the "Planned" row

    const planned = res.accepted.filter(a => a.workKind === 'PLANNED');
    expect(planned).toHaveLength(1);
    expect(planned[0].task).toBe('Policy Update');
  });

  it('takes the work date from the title line, not from the day it was sent', () => {
    expect(res.accepted.every(a => a.date === '2026-08-30')).toBe(true);
    expect(res.accepted[0].dataQualityNotes).toMatch(/title row/i);
    expect(res.accepted[0].dataQualityNotes).toMatch(/DAILY WORK UPDATE/);
  });

  it('marks every row as read from a picture', () => {
    expect(res.accepted.every(a => a.extractionSource === 'vision')).toBe(true);
  });

  it('computes 71.4% — the plan leaves the numerator and the denominator', () => {
    const counted = res.accepted.filter(a => a.workKind !== 'PLANNED');
    const done = counted.filter(a => a.taskStatus === 'Completed');
    expect(counted).toHaveLength(7);
    expect(done).toHaveLength(5);
    expect(Math.round((done.length / counted.length) * 1000) / 10).toBe(71.4);
  });
});
