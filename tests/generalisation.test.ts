/**
 * Does the mapper generalise, or has it memorised the test set?
 *
 * Every wording here is held out: none of these strings may appear anywhere
 * under src/, and a test below enforces that. A mapper that recognises them
 * because somebody pasted them into an alias list has not solved the problem,
 * it has fitted the fixtures — which is exactly what happens when a case fails
 * and the quickest fix is to add the string.
 *
 * The pool is sampled with a fresh seed each run, so a passing build is not
 * evidence about one fixed ten.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { normalizeHeader } from '../src/lib/core/normalize';
import { mapHeaderRow } from '../src/lib/core/html-table';
import { fieldFromValues } from '../src/lib/core/column-values';
import { seedMasters } from '../src/lib/seed';
import { engineConfig } from '../src/lib/pipeline';

const POOL: Record<string, string[]> = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/headers.holdout.json'), 'utf8'));
const masters = seedMasters([]);
const cfg = engineConfig();

/** Every .ts/.tsx file under src, read once. */
function sourceFiles(dir = join(process.cwd(), 'src')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
const SOURCE = sourceFiles().map(f => ({ file: f, text: readFileSync(f, 'utf8') }));

describe('the held-out wordings are genuinely held out', () => {
  const all = Object.values(POOL).flat();

  it('no held-out header string appears in the extraction source', () => {
    const leaked: string[] = [];
    for (const phrase of all) {
      // Single common words (Day, Dept, Person) are legitimate vocabulary; the
      // gate is about multi-word phrases being pasted in wholesale.
      if (!phrase.includes(' ') && !phrase.includes('/')) continue;
      // Only a quoted occurrence counts. The phrase appearing inside a
      // sentence is English; the phrase appearing as a string literal is a
      // lookup entry, which is the thing this gate exists to catch.
      const quoted = new RegExp(`['"\`]\\s*${phrase.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}\\s*['"\`]`, 'i');
      for (const { file, text } of SOURCE) {
        if (quoted.test(text)) {
          leaked.push(`"${phrase}" quoted in ${file.replace(process.cwd() + '/', '')}`);
        }
      }
    }
    expect(leaked, leaked.join('; ')).toEqual([]);
  });

  it('no fixture proper noun appears in the extraction source', () => {
    const NAMES = ['Dhrubo Ganguly', 'Priya Sharma', 'Rahul Mehta', 'Arjun Sen',
                   'Mita Roy', 'Kavita Menon', 'Neha Gupta', 'Vikas Nair'];
    const leaked: string[] = [];
    for (const name of NAMES) {
      for (const { file, text } of SOURCE) {
        // seed.ts is the demo roster and is not extraction logic.
        if (file.endsWith('seed.ts')) continue;
        if (text.includes(name)) leaked.push(`"${name}" in ${file}`);
      }
    }
    expect(leaked, leaked.join('; ')).toEqual([]);
  });
});

describe('unseen header wordings still map, in a real table', () => {
  // Exercised through the path the product uses: a heading over a column of
  // values. Asking a heading to resolve with no column beneath it is a
  // question the product never asks, and answering it would mean deciding
  // ambiguous single words on the heading alone — which is how a column gets
  // filed under the wrong field.
  const seed = Date.now();
  const pick = <T,>(xs: T[], n: number, s: number) =>
    [...xs].sort((a, b) =>
      String(a).charCodeAt(0) * ((s % 7) + 1) - String(b).charCodeAt(0) * ((s % 5) + 1))
      .slice(0, n);

  // Values a column of each kind plausibly holds. No fixture names.
  const VALUES: Record<string, string[]> = {
    employee: ['Ada Lovelace', 'Grace Hopper', 'Ada Lovelace', 'Alan Turing',
               'Grace Hopper', 'Ada Lovelace'],
    task: ['Reconciled the vendor ledger', 'Prepared the campaign brief',
           'Investigated the overnight job', 'Drafted the onboarding checklist',
           'Reviewed the supplier contract', 'Closed the quarterly books'],
    status: ['Completed', 'In Progress', 'Pending', 'Completed', 'Blocked', 'Completed'],
    date: ['30 Aug 2026', '30 Aug 2026', '29 Aug 2026', '29 Aug 2026',
           '28 Aug 2026', '28 Aug 2026'],
    department: ['Logistics', 'Logistics', 'Procurement', 'Procurement',
                 'Logistics', 'Procurement']
  };

  /** Builds a table where only the column under test carries the header. */
  const mapWith = (field: string, header: string) => {
    const others = Object.keys(VALUES).filter(f => f !== field);
    const headers = [header, ...others.map(f =>
      ({ employee: 'Employee', task: 'Task', status: 'Status',
         date: 'Date', department: 'Department' } as Record<string, string>)[f])];
    const cols = [field, ...others];
    const rows = [headers.map(text => ({ text, href: '' }))];
    for (let r = 0; r < 6; r++) {
      rows.push(cols.map(f => ({ text: VALUES[f][r], href: '' })));
    }
    const header_ = mapHeaderRow(rows, masters, cfg);
    if (!header_) return null;
    return Object.entries(header_.mapping).find(([, idx]) => idx === 0)?.[0] ?? null;
  };

  for (const [field, headers] of Object.entries(POOL)) {
    if (field.startsWith('_')) continue;
    it(`${field}: at least 8 unseen variants map correctly (seed ${seed})`, () => {
      const sample = pick(headers, Math.min(8, headers.length), seed);
      expect(sample.length).toBeGreaterThanOrEqual(8);
      const wrong = sample.filter(h => mapWith(field, h) !== field);
      expect(wrong, `${field} failed on: ${wrong.join(', ')}`).toEqual([]);
    });
  }
});

describe('a column can be identified by its contents alone', () => {
  it('reads a task column whose heading says nothing', () => {
    // "What Was Done Today" scores two weak words and maps to nothing. The
    // values are what make it a task column.
    expect(normalizeHeader('What Was Done Today', masters)).toBeNull();
    const g = fieldFromValues([
      'Reconciled the vendor ledger for August',
      'Prepared the quarterly campaign brief',
      'Investigated the failing overnight job',
      'Drafted the onboarding checklist',
      'Reviewed the supplier contract'
    ], masters, cfg);
    expect(g?.field).toBe('task');
    expect(g?.evidence).toMatch(/free text/);
  });

  it('reads an employee column from repetition and name shape', () => {
    const g = fieldFromValues(
      ['Priya Sharma', 'Rahul Mehta', 'Priya Sharma', 'Arjun Sen', 'Rahul Mehta',
       'Priya Sharma'], masters, cfg);
    expect(g?.field).toBe('employee');
    expect(g?.evidence).toMatch(/distinct/);
  });

  it('reads a date column however it is written', () => {
    expect(fieldFromValues(
      ['30 Aug 2026', '29 Aug 2026', '28 Aug 2026', '27 Aug 2026'], masters, cfg)?.field)
      .toBe('date');
  });

  it('reads a status column from the vocabulary in it', () => {
    expect(fieldFromValues(
      ['Completed', 'In Progress', 'Pending', 'Completed', 'Blocked'], masters, cfg)?.field)
      .toBe('status');
  });

  it('does not mistake free text for a person', () => {
    const g = fieldFromValues([
      'Reconciled the vendor ledger', 'Prepared the campaign brief',
      'Investigated the overnight job', 'Drafted the checklist'
    ], masters, cfg);
    expect(g?.field).not.toBe('employee');
  });

  it('says nothing about a column of money', () => {
    const g = fieldFromValues(['500', '250.00', '1,200', '75'], masters, cfg);
    expect(g).toBeNull();
  });

  it('says nothing when there is too little to judge', () => {
    expect(fieldFromValues(['Completed'], masters, cfg)).toBeNull();
    expect(fieldFromValues(['', '', 'Completed', ''], masters, cfg)).toBeNull();
  });
});

describe('a department the seed list has never heard of', () => {
  it('is taken from a column of its own, not invented from the sender', async () => {
    const { ingestDocument } = await import('../src/lib/core/ingest');
    const { extractPipeTables } = await import('../src/lib/core/html-table');
    // "AI & Technology" is in no seed list anywhere.
    const tables = extractPipeTables(
      'Date|Employee|Team / Division|Work Item|Current Status\n' +
      '30 Aug 2026|Ann Fielding|AI & Technology|Model evaluation|Completed\n' +
      '30 Aug 2026|Ben Okoro|AI & Technology|Prompt regression suite|Completed\n' +
      '30 Aug 2026|Cara Duval|Quantum Logistics|Route solver tuning|Pending\n');
    const res = ingestDocument({
      documentId: 'novel-dept', subject: 'update', sender: 'lead@co.com',
      receivedAt: '2026-08-30T09:00:00.000Z', tables
    }, masters, cfg, new Map());

    expect(res.accepted).toHaveLength(3);
    expect([...new Set(res.accepted.map(a => a.department))].sort())
      .toEqual(['AI & Technology', 'Quantum Logistics']);
  });
});
