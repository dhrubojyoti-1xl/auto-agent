/**
 * The roster reader.
 *
 * Harshal will paste whatever his HR sheet already looks like, so the headings
 * are read the same forgiving way report headings are. These tests use wordings
 * that are NOT the ones in the template, because a parser that only understands
 * its own template has not solved anything.
 */
import { describe, expect, it } from 'vitest';
import { parseRoster, rosterEmployeeId } from '../src/lib/roster';

describe('reading a pasted roster', () => {
  it('reads the headings people actually use', () => {
    const r = parseRoster([
      'Team\tStaff Member\tMail ID\tAlso known as\tDesignation',
      'Management\tUsman Khan\tusman@1xl.com\tUsman\tManager',
      'SOP\tRahul Koli\trahul.koli@1xl.com\tRahul K; R Koli\tExecutive'
    ].join('\n'));

    expect(r.rejected).toEqual([]);
    expect(r.people).toHaveLength(2);

    const usman = r.people.find(p => p.name === 'Usman Khan')!;
    expect(usman.department).toBe('Management');
    expect(usman.email).toBe('usman@1xl.com');
    expect(usman.role).toBe('Manager');

    const rahul = r.people.find(p => p.name === 'Rahul Koli')!;
    expect(rahul.department).toBe('SOP');
    expect(rahul.aliases.sort()).toEqual(['R Koli', 'Rahul K']);
  });

  it('keeps Manager Email away from the employee email column', () => {
    const r = parseRoster([
      'Department,Employee,Email,Manager,Manager Email',
      'Sales,Priya Sharma,priya@1xl.com,Usman Khan,usman@1xl.com'
    ].join('\n'));

    expect(r.people[0].email).toBe('priya@1xl.com');
    expect(r.departments[0].manager).toBe('Usman Khan');
    expect(r.departments[0].managerEmail).toBe('usman@1xl.com');
  });

  it('accepts a department row that names only its manager', () => {
    const r = parseRoster([
      'Department,Employee,Manager,Manager Email',
      'Content,,Mita Roy,mita@1xl.com',
      'Content,Arjun Sen,,'
    ].join('\n'));

    expect(r.people.map(p => p.name)).toEqual(['Arjun Sen']);
    const content = r.departments.find(d => d.name === 'Content')!;
    expect(content.manager).toBe('Mita Roy');
    expect(content.managerEmail).toBe('mita@1xl.com');
  });

  it('rejects rather than guesses, and says why', () => {
    const r = parseRoster([
      'Department,Employee,Email',
      'Sales,Valid Person,ok@1xl.com',
      ',Missing Department,x@1xl.com',
      'Sales,Bad Email,not-an-email'
    ].join('\n'));

    expect(r.people.map(p => p.name)).toEqual(['Valid Person']);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0].reason).toMatch(/department/i);
    expect(r.rejected[1].reason).toMatch(/not a valid email/i);
    // The original values survive, so the row can be fixed rather than hunted for.
    expect(r.rejected[1].values).toContain('not-an-email');
  });

  it('skips a title line above the headings', () => {
    const r = parseRoster([
      'ONEXCELL INDIA — TEAM LIST 2026',
      'Department,Employee',
      'HR,Priya Sharma'
    ].join('\n'));

    expect(r.people).toHaveLength(1);
    expect(r.people[0].department).toBe('HR');
  });

  it('merges a person listed twice instead of duplicating them', () => {
    const r = parseRoster([
      'Department,Employee,Also known as,Email',
      'SOP,Rahul Koli,Rahul K,',
      'SOP,Rahul Koli,R Koli,rahul@1xl.com'
    ].join('\n'));

    expect(r.people).toHaveLength(1);
    expect(r.people[0].aliases.sort()).toEqual(['R Koli', 'Rahul K']);
    expect(r.people[0].email).toBe('rahul@1xl.com');
  });

  it('gives the same person the same id every time, so re-import updates', () => {
    expect(rosterEmployeeId('Rahul Koli')).toBe(rosterEmployeeId('rahul koli'));
    expect(rosterEmployeeId('Rahul Koli')).not.toBe(rosterEmployeeId('Usman Khan'));
  });

  it('gives a thousand different people a thousand different ids', () => {
    // The first version folded a 32-bit hash into six base-36 characters and
    // collided well inside one company. A collision does not look like an
    // error: the second person overwrites the first on the way in, and someone
    // is simply missing from their department for ever after.
    const ids = new Set(
      Array.from({ length: 1000 }, (_, i) => rosterEmployeeId(`Person Number${i}`)));
    expect(ids.size).toBe(1000);
  });

  it('survives an empty paste without throwing', () => {
    const r = parseRoster('');
    expect(r.people).toEqual([]);
    expect(r.departments).toEqual([]);
  });
});
