/**
 * A report that arrived as a picture.
 *
 * What makes this safe is not the model — it is that the model is asked for
 * things that can be checked against each other, and any disagreement discards
 * the whole report. A partial import from a misread table is the dangerous
 * outcome, because it looks exactly like a complete one.
 *
 * Every check is exercised here without a network or an API key, because the
 * checks are the part that must never regress.
 */
import { describe, expect, it } from 'vitest';
import {
  dateFromTitle, MIN_CELL_CONFIDENCE, verifyVisionTable, visionTableToRows
} from '../src/lib/core/vision';
import type { VisionTable } from '../src/lib/core/vision';
import { seedMasters } from '../src/lib/seed';

const masters = seedMasters([]);
const cell = (text: string, confidence = 0.97) => ({ text, confidence });

/** Case B, as the model should return it. */
function caseB(): VisionTable {
  const rows: [string, string, string, string][] = [
    ['Dhrubo Ganguly', 'AI & Technology', 'AI Integration in SaaS', 'Completed'],
    ['Rahul Mehta', 'Sales', 'Client Follow-up', 'Completed'],
    ['Priya Sharma', 'HR', 'Employee Onboarding', 'In Progress'],
    ['Arjun Sen', 'Operations', 'Vendor Reconciliation', 'Pending'],
    ['Mita Roy', 'Marketing', 'Campaign Performance Review', 'Completed'],
    ['Dhrubo Ganguly', 'AI & Technology', 'Dashboard Visual Improvements', 'Completed'],
    ['Rahul Mehta', 'Sales', 'New Lead Research', 'Completed'],
    ['Priya Sharma', 'HR', 'Policy Update', 'Planned']
  ];
  return {
    declaredRows: 8, declaredColumns: 4,
    title: 'DAILY WORK UPDATE — 30 AUGUST 2026',
    headers: ['Staff Member', 'Team / Division', 'Work Item', 'Current Status'],
    rows: rows.map(r => r.map(v => cell(v)))
  };
}

describe('a clean transcription passes', () => {
  it('accepts a table whose declarations match what came back', () => {
    const out = verifyVisionTable(caseB(), masters);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.lowestConfidence).toBeGreaterThanOrEqual(MIN_CELL_CONFIDENCE);
  });

  it('hands back the ordinary table shape once it has passed', () => {
    const grid = visionTableToRows(caseB());
    expect(grid[0]).toEqual(['Staff Member', 'Team / Division', 'Work Item', 'Current Status']);
    expect(grid).toHaveLength(9);
  });
});

describe('the whole report is discarded, never part of it', () => {
  it('rejects a row count that disagrees with the declaration', () => {
    const t = caseB();
    t.rows.pop();                      // the model dropped a row it said it saw
    const out = verifyVisionTable(t, masters);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/8 row\(s\) but 7/);
      expect(out.reason).toMatch(/rather than importing part/);
    }
  });

  it('rejects a declared column count that disagrees with the header', () => {
    const t = caseB();
    t.declaredColumns = 5;
    expect(verifyVisionTable(t, masters).ok).toBe(false);
  });

  it('rejects a ragged row', () => {
    const t = caseB();
    t.rows[3] = t.rows[3].slice(0, 3);
    const out = verifyVisionTable(t, masters);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/Row 4 has 3 cell\(s\)/);
  });

  it('rejects one weak cell out of thirty-two', () => {
    const t = caseB();
    t.rows[5][2] = cell('Dashboard Visual Improvements', 0.55);
    const out = verifyVisionTable(t, masters);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/row 6/);
      expect(out.reason).toMatch(/Work Item/);
      expect(out.reason).toMatch(/55%/);
    }
  });

  it('rejects a status this organisation has never used', () => {
    // A word outside a small closed vocabulary is far more likely a misread
    // cell than a new status.
    const t = caseB();
    t.rows[2][3] = cell('In Progres');       // one letter short
    const out = verifyVisionTable(t, masters);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/never used/);
  });

  it('rejects an image with no table at all', () => {
    const out = verifyVisionTable(
      { declaredRows: 0, declaredColumns: 0, title: '', headers: [], rows: [] }, masters);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/No table/);
  });

  it('every rejection says which check failed', () => {
    const broken: VisionTable[] = [];
    const a = caseB(); a.rows.pop(); broken.push(a);
    const b = caseB(); b.rows[0] = b.rows[0].slice(0, 2); broken.push(b);
    const c = caseB(); c.rows[1][1] = cell('Sales', 0.2); broken.push(c);
    for (const t of broken) {
      const out = verifyVisionTable(t, masters);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason.length).toBeGreaterThan(30);
    }
  });
});

describe('the title row states the day', () => {
  it('reads the date out of the caption above the header', () => {
    const d = dateFromTitle('DAILY WORK UPDATE — 30 AUGUST 2026');
    expect(d?.date).toBe('2026-08-30');
    expect(d?.quote).toContain('DAILY WORK UPDATE');
  });

  it('handles the orders a title is written in', () => {
    expect(dateFromTitle('Report — August 30, 2026')?.date).toBe('2026-08-30');
    expect(dateFromTitle('Daily update 2026-08-30')?.date).toBe('2026-08-30');
    expect(dateFromTitle('Team report — 5 Sep 2026')?.date).toBe('2026-09-05');
  });

  it('returns nothing rather than guessing', () => {
    expect(dateFromTitle('DAILY WORK UPDATE')).toBeNull();
    expect(dateFromTitle('')).toBeNull();
    expect(dateFromTitle('Report for the 45th of Smarch 2026')).toBeNull();
  });
});

describe('Case B end to end, from a verified transcription', () => {
  it('produces eight rows across five departments, one of them planned', async () => {
    const { ingestDocument } = await import('../src/lib/core/ingest');
    const { engineConfig } = await import('../src/lib/pipeline');
    const t = caseB();
    const verified = verifyVisionTable(t, masters);
    expect(verified.ok).toBe(true);

    const grid = visionTableToRows(t);
    const res = ingestDocument({
      documentId: 'case-b', subject: 'report', sender: 'someone@example.com',
      receivedAt: '2026-08-31T09:00:00.000Z',
      extractionSource: 'vision',
      titleDate: dateFromTitle(t.title) || undefined,
      tables: [{ index: 0, source: 'text',
                 rows: grid.map(r => r.map(text => ({ text, href: '' }))) }]
    }, masters, engineConfig(), new Map());

    expect(res.accepted).toHaveLength(8);
    expect(res.rejected).toHaveLength(0);
    expect(new Set(res.accepted.map(a => a.employeeName)).size).toBe(5);
    expect(res.departments?.sort()).toEqual(
      ['AI & Technology', 'HR', 'Marketing', 'Operations', 'Sales']);
    // Several departments, so the report has none of its own.
    expect(res.department).toBe('');
    // The day comes from the title, not from the day the mail arrived.
    expect(res.accepted.every(a => a.date === '2026-08-30')).toBe(true);
    expect(res.accepted.every(a => a.extractionSource === 'vision')).toBe(true);
    expect(res.accepted[0].dataQualityNotes).toMatch(/title row/i);
  });
});

describe('a status that names the future, and one that names two states', () => {
  it('Case B’s "Planned" row imports as planned work, not as unfinished work', async () => {
    const { ingestDocument } = await import('../src/lib/core/ingest');
    const { engineConfig } = await import('../src/lib/pipeline');
    const { extractPipeTables } = await import('../src/lib/core/html-table');

    const res = ingestDocument({
      documentId: 'planned-status', subject: 'r', sender: 'a@example.com',
      receivedAt: '2026-08-30T09:00:00.000Z',
      tables: extractPipeTables(
        'Date|Staff Member|Team / Division|Work Item|Current Status\n' +
        '30 Aug 2026|Ann Fielding|HR|Policy Update|Planned\n' +
        '30 Aug 2026|Ben Okoro|HR|Employee Onboarding|In Progress\n' +
        '30 Aug 2026|Cara Duval|HR|Payroll run|Completed\n')
    }, seedMasters([]), engineConfig(), new Map());

    expect(res.accepted).toHaveLength(3);
    expect(res.rejected).toHaveLength(0);
    const planned = res.accepted.find(a => a.task === 'Policy Update');
    expect(planned?.workKind).toBe('PLANNED');
    expect(planned?.taskStatus).toBe('Not Started');
    expect(planned?.dataQualityNotes).toMatch(/planned work/i);
  });

  it('keeps a two-state status as ambiguous rather than picking a half', async () => {
    const { ingestDocument } = await import('../src/lib/core/ingest');
    const { engineConfig } = await import('../src/lib/pipeline');
    const { extractPipeTables } = await import('../src/lib/core/html-table');

    const res = ingestDocument({
      documentId: 'ambiguous-status', subject: 'r', sender: 'a@example.com',
      receivedAt: '2026-08-30T09:00:00.000Z',
      tables: extractPipeTables(
        'Date|Employee|Task|Status\n' +
        '30 Aug 2026|Ann Fielding|Auto-Agent development|Completed/Ongoing\n' +
        '30 Aug 2026|Ben Okoro|Payroll run|Completed\n')
    }, seedMasters([]), engineConfig(), new Map());

    expect(res.accepted).toHaveLength(2);          // kept, not rejected
    const amb = res.accepted.find(a => a.task === 'Auto-Agent development');
    expect(amb?.taskStatus).toBe('Ambiguous');
    expect(amb?.taskStatus).not.toBe('Completed');
    expect(amb?.dataQualityNotes).toMatch(/more than one state/i);
  });

  it('still refuses a status that is simply unknown', async () => {
    const { ingestDocument } = await import('../src/lib/core/ingest');
    const { engineConfig } = await import('../src/lib/pipeline');
    const { extractPipeTables } = await import('../src/lib/core/html-table');
    const res = ingestDocument({
      documentId: 'unknown-status', subject: 'r', sender: 'a@example.com',
      receivedAt: '2026-08-30T09:00:00.000Z',
      tables: extractPipeTables(
        'Date|Employee|Task|Status\n30 Aug 2026|Ann Fielding|Something|Compleeted!!\n')
    }, seedMasters([]), engineConfig(), new Map());
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0].reason).toBe('UNKNOWN_STATUS');
  });
});
