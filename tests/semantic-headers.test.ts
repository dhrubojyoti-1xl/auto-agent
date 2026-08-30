/**
 * Column headings nobody configured.
 *
 * The alias table only ever contains wordings somebody already thought of.
 * These are the ones real reports use instead — abbreviated, reordered,
 * compound, or in another language — and each has to reach the right canonical
 * field without a person editing a list first.
 *
 * The second half matters more than the first: a heading filed under the wrong
 * field corrupts data silently, while an unmapped heading produces a row-level
 * rejection that says so. Every ambiguous case here must refuse to answer.
 */
import { describe, expect, it } from 'vitest';
import { guessField, headerTokens, rankHeader } from '../src/lib/core/semantic-headers';
import { normalizeHeader } from '../src/lib/core/normalize';
import { seedMasters } from '../src/lib/seed';

const masters = seedMasters([]);
const via = (h: string) => normalizeHeader(h, masters);

describe('headings are read as words, not as strings', () => {
  it('ignores punctuation, case, possessives and parentheses', () => {
    expect(headerTokens("Employee's Name (Full)")).toEqual(['employee', 'name', 'full']);
    expect(headerTokens('  TASK — DESCRIPTION  ')).toEqual(['task', 'description']);
  });

  it('drops filler words that carry no meaning', () => {
    expect(headerTokens('Name of the Employee')).toEqual(['name', 'employee']);
  });
});

describe('wordings a real report uses', () => {
  const cases: [string, string][] = [
    ['Emp Nm', 'employee'],
    ['Name of Employee', 'employee'],
    ['Staff Member', 'employee'],
    ['Assignee', 'employee'],
    ['Resource Name', 'employee'],
    ['Work Done Today', 'task'],
    ['Activities Completed', 'task'],
    ['Job Description', 'task'],
    ['Deliverable', 'task'],
    ['Current State', 'status'],
    ['Progress Stage', 'status'],
    ['Reporting Dt', 'date'],
    ['Work Date', 'date'],
    ['Dept', 'department'],
    ['Division', 'department'],
    ['Business Unit', 'department'],
    ['Urgency', 'priority'],
    ['Reference URL', 'link'],
    ['Blocker Notes', 'notes'],
    ['Hours Spent', 'actualDuration'],
    ['Estimated Effort', 'expectedDuration']
  ];
  for (const [header, field] of cases) {
    it(`"${header}" means ${field}`, () => {
      expect(via(header)).toBe(field);
    });
  }
});

describe('compound headings resolve by weight, not by word order', () => {
  it('"Task Name" is a task, not an employee', () => {
    expect(via('Task Name')).toBe('task');
  });
  it('"Project Name" is not an employee either', () => {
    expect(via('Project Name')).not.toBe('employee');
  });
  it('"Employee Name" is still an employee', () => {
    expect(via('Employee Name')).toBe('employee');
  });
  it('"Task Status" is a status, because status is the stronger word', () => {
    expect(via('Task Status')).toBe('status');
  });
  it('"Actual Hours" and "Estimated Hours" do not collide', () => {
    expect(via('Actual Hours')).toBe('actualDuration');
    expect(via('Estimated Hours')).toBe('expectedDuration');
  });
  it('"Start Date" is a date, "Start Time" is a time', () => {
    expect(via('Start Date')).toBe('startDate');
    expect(via('Start Time')).toBe('startTime');
  });
});

describe('a heading in another language still lands', () => {
  const cases: [string, string][] = [
    ['Fecha', 'date'],
    ['Empleado', 'employee'],
    ['Tarea', 'task'],
    ['Estado', 'status'],
    ['Datum', 'date'],
    ['Aufgabe', 'task'],
    ['Abteilung', 'department'],
    ['Mitarbeiter', 'employee']
  ];
  for (const [header, field] of cases) {
    it(`"${header}" means ${field}`, () => expect(via(header)).toBe(field));
  }
});

describe('refusing to answer is a valid answer', () => {
  it('says nothing about a serial-number column', () => {
    for (const h of ['S. No', 'Sr No', 'Sl. No.', '#', 'Index']) {
      expect(via(h), h).toBeNull();
    }
  });

  it('says nothing about columns that are none of our business', () => {
    for (const h of ['Invoice Amount', 'Headline', 'Author', 'Phone', 'Salary',
                     'GST', 'Quantity', 'Unit Price']) {
      expect(via(h), h).toBeNull();
    }
  });

  it('refuses a heading that is a tie between two fields', () => {
    // Contrived, but the rule has to hold: an even contest is not a decision.
    const ranked = rankHeader('Date Status');
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
      expect(guessField('Date Status')).toBeNull();
    }
  });

  it('refuses a single weak word on its own', () => {
    // "Details" alone could be anything; it only means a task beside stronger
    // evidence, and a whole column must not be claimed on that.
    expect(guessField('Details')).toBeNull();
    expect(guessField('Current')).toBeNull();
  });

  it('can explain every match it makes', () => {
    const [best] = rankHeader('Work Done Today');
    expect(best.field).toBe('task');
    expect(best.evidence).toContain('work');
  });
});

describe('a configured alias always beats a guess', () => {
  it('uses the alias table first', () => {
    // 'day' is configured as a date alias; the guesser would also say date,
    // but the point is that configuration is consulted before inference.
    expect(masters.headerAliases['day']).toBe('date');
    expect(via('Day')).toBe('date');
  });
});
