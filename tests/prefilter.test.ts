/**
 * Deciding whether a message is worth opening.
 *
 * A working mailbox is mostly not reports, and every message that reaches
 * extraction costs an attachment download, a parse, and — now that images are
 * transcribed — a vision call. A promotional email with a banner image is a
 * daily expense repeated for ever.
 *
 * The negative corpus below is the important half. Anything here scoring into
 * CANDIDATE means real money spent on a newsletter.
 */
import { describe, expect, it } from 'vitest';
import { scoreMessage, DROP_BELOW, FORCE_ABOVE } from '../src/lib/core/prefilter';
import type { PrefilterInput, PrefilterRule } from '../src/lib/core/prefilter';
import { readFileSync } from 'fs';
import { join } from 'path';

/** The seeded rules, read from the migration so the test cannot drift from it. */
const RULES: PrefilterRule[] = (() => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/012_prefilter.sql'), 'utf8');
  const block = sql.slice(sql.indexOf('values'), sql.indexOf('on conflict'));
  const out: PrefilterRule[] = [];
  for (const m of block.matchAll(/\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(?:'((?:[^']|'')*)'|null),\s*(-?\d+),\s*(-?\d+|null)/g)) {
    out.push({
      ruleId: m[1], signal: m[2], kind: m[3] as PrefilterRule['kind'],
      pattern: m[4] === undefined ? null : m[4].replace(/''/g, "'"),
      weight: Number(m[5]), cap: m[6] === 'null' ? null : Number(m[6]), active: true
    });
  }
  return out;
})();

const base: PrefilterInput = {
  subject: '', from: 'someone@example.com', bodyText: '', bodyHtml: '',
  headerNames: [], labelIds: [], attachments: [],
  tenantDomains: ['client.example'], rosterKeys: ['ada lovelace', 'ada@client.example'],
  ownAddress: 'manager@client.example',
  threadProducedReport: false
};
const score = (over: Partial<PrefilterInput>) => scoreMessage({ ...base, ...over }, RULES);

describe('the seeded rules load', () => {
  it('reads every rule out of the migration', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(14);
    expect(RULES.some(r => r.weight > 0)).toBe(true);
    expect(RULES.some(r => r.weight < 0)).toBe(true);
  });

  it('contains no proper nouns', () => {
    // A rule naming a person or a company is a rule that stops working for
    // the next client.
    const NAMES = /\b(dhrubo|ganguly|priya|sharma|rahul|mehta|arjun|mita|emo|aiboy|1xl)\b/i;
    for (const r of RULES) {
      expect(NAMES.test(`${r.signal} ${r.pattern ?? ''}`), r.ruleId).toBe(false);
    }
  });
});

describe('reports are promoted', () => {
  it('a spreadsheet from a colleague is forced through', () => {
    const v = score({
      from: 'Ada Lovelace <ada@client.example>',
      subject: 'daily report',
      bodyText: 'Please find the team update attached with today\'s tasks and status.',
      attachments: [{ filename: 'report.xlsx', size: 40_000,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
    });
    expect(v.band).toBe('FORCE');
    expect(v.score).toBeGreaterThan(FORCE_ABOVE);
  });

  it('a Google Sheets link from a colleague reaches at least candidate', () => {
    const v = score({
      from: 'ada@client.example',
      subject: 'Daily report',
      bodyText: 'Please find my daily working report https://docs.google.com/spreadsheets/d/abc123'
    });
    expect(['CANDIDATE', 'FORCE']).toContain(v.band);
  });

  it('an image from a colleague on a thread that has reported before is forced', () => {
    const v = score({
      from: 'ada@client.example', subject: 'update',
      bodyText: 'today work status',
      attachments: [{ filename: 'table.png', mimeType: 'image/png', size: 300_000 }],
      threadProducedReport: true
    });
    expect(v.band).toBe('FORCE');
  });

  it('a plain HTML table in the body is enough to look', () => {
    const v = score({
      subject: 'FYI', from: 'ada@client.example',
      bodyHtml: '<table><tr><th>Date</th><th>Task</th></tr>' +
                '<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'
    });
    expect(v.band).not.toBe('DROP');
  });
});

describe('the negative corpus — none of these may cost anything', () => {
  const NEGATIVE: { name: string; input: Partial<PrefilterInput> }[] = [
    { name: 'newsletter with unsubscribe header', input: {
      from: 'news@newsletter.example', subject: 'Industry Weekly',
      headerNames: ['From', 'To', 'List-Unsubscribe'],
      bodyHtml: '<table><tr><th>Headline</th><th>Author</th></tr>' +
                '<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
      bodyText: 'View in browser. Unsubscribe.' } },
    { name: 'promotional with banner image', input: {
      from: 'deals@shop.example', subject: '50% off hosting',
      labelIds: ['CATEGORY_PROMOTIONS'],
      attachments: [{ filename: 'banner.png', mimeType: 'image/png', size: 400_000 }],
      bodyText: 'Limited time price. Unsubscribe to stop these emails.' } },
    { name: 'invoice with a spreadsheet', input: {
      from: 'billing@vendor.example', subject: 'Invoice 991',
      bodyText: 'Invoice attached. Amount due 500. Subtotal 420. GST 80. Order value 500.',
      attachments: [{ filename: 'invoice.xlsx', size: 20_000,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] } },
    { name: 'GitHub notification', input: {
      from: 'notifications@github.example', subject: '[repo] Pull request opened',
      headerNames: ['From', 'List-Unsubscribe'],
      bodyText: 'You are receiving this because you were mentioned. Manage preferences.' } },
    { name: 'no-reply receipt', input: {
      from: 'no-reply@service.example', subject: 'Your receipt',
      bodyText: 'Thanks for your order. Price 20. Amount due 0.' } },
    { name: 'social notification', input: {
      from: 'noreply@social.example', subject: 'You have 3 new connections',
      labelIds: ['CATEGORY_SOCIAL'], bodyText: 'See who viewed your profile. Unsubscribe.' } },
    { name: 'personal note', input: {
      from: 'friend@example.com', subject: 'lunch?', bodyText: 'free at 1?' } },
    { name: 'marketing with a table and unsubscribe', input: {
      from: 'marketing@vendor.example', subject: 'Our new pricing',
      headerNames: ['List-Unsubscribe'],
      bodyHtml: '<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>50</td></tr>' +
                '<tr><td>Team</td><td>90</td></tr></table>',
      bodyText: 'Compare price plans. Manage preferences.' } },
    { name: 'calendar invite', input: {
      from: 'calendar-notification@service.example', subject: 'Invitation: standup',
      bodyText: 'You have been invited. View in browser.' } },
    { name: 'password reset', input: {
      from: 'no-reply@auth.example', subject: 'Reset your password',
      bodyText: 'Click to reset. If you did not request this, ignore.' } }
  ];

  for (const { name, input } of NEGATIVE) {
    it(`drops: ${name}`, () => {
      const v = score(input);
      expect(v.band, `${name} scored ${v.score}: ${v.signals.join(', ')}`).toBe('DROP');
      expect(v.score).toBeLessThan(DROP_BELOW);
    });
  }

  it('every drop can explain itself', () => {
    for (const { name, input } of NEGATIVE) {
      const v = score(input);
      expect(v.signals.length, name).toBeGreaterThan(0);
    }
  });
});

describe('the bands are what they claim', () => {
  it('never drops a colleague\'s spreadsheet, however much noise surrounds it', () => {
    const v = score({
      from: 'ada@client.example', subject: 'daily report',
      threadProducedReport: true,
      headerNames: ['List-Unsubscribe'],
      bodyText: 'task status update completed pending invoice price',
      attachments: [{ filename: 'r.xlsx', size: 30_000,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
    });
    // Sixteen points of report signal against ten of noise. It may land in
    // CANDIDATE rather than FORCE; what must never happen is a drop.
    expect(v.band).not.toBe('DROP');
    expect(v.score).toBeGreaterThanOrEqual(DROP_BELOW);
  });

  it('an unconfigured rule set opens everything rather than dropping it', () => {
    const v = scoreMessage({ ...base, subject: 'anything' }, []);
    expect(v.band).not.toBe('DROP');
  });
});

describe('a person mailing a report to themselves', () => {
  it('is recognised, because that is how a lot of reporting actually works', () => {
    // No tenant domain to lean on — a personal mailbox is everybody's domain —
    // and no roster entry. The one signal is that it came from the owner.
    const v = scoreMessage({
      ...base, tenantDomains: [], rosterKeys: [],
      ownAddress: 'owner@mail.example',
      from: 'Owner <owner@mail.example>', subject: 'daily report',
      attachments: [{ filename: 'table.png', mimeType: 'image/png', size: 300_000 }]
    }, RULES);
    expect(v.band).not.toBe('DROP');
  });

  it('an anonymous image with nothing else is still not worth a paid call', () => {
    const v = scoreMessage({
      ...base, tenantDomains: [], rosterKeys: [], ownAddress: 'owner@mail.example',
      from: 'stranger@elsewhere.example', subject: '',
      attachments: [{ filename: 'photo.png', mimeType: 'image/png', size: 300_000 }]
    }, RULES);
    expect(v.band).toBe('DROP');
  });
});
