/**
 * Deciding whether a message is worth opening.
 *
 * A working mailbox is mostly not reports. Every message that reaches the
 * extraction layer costs something — an attachment download, a spreadsheet
 * parse, and now a vision call for anything with a picture in it — so a
 * promotional email with a banner image is a real expense, repeated daily.
 *
 * The score is deliberately blunt and explainable. Each signal contributes a
 * fixed weight, the deciding signals are recorded against the message, and a
 * manager asking "why was my report ignored" gets an answer rather than a
 * shrug. Rules live in the database so they can be tuned against a real
 * mailbox without a deploy, and none of them names a person or a company.
 */
export interface PrefilterRule {
  ruleId: string;
  signal: string;
  kind: 'header' | 'body' | 'subject' | 'sender' | 'attachment' | 'structure';
  pattern: string | null;
  weight: number;
  cap: number | null;
  active: boolean;
}

export interface PrefilterInput {
  subject: string;
  from: string;
  bodyText: string;
  bodyHtml: string;
  headerNames: string[];
  labelIds: string[];
  attachments: { filename: string; mimeType: string; size: number }[];
  /** Domains that belong to this tenant, lowercased. */
  tenantDomains: string[];
  /** Employee names and addresses already known, lowercased. */
  rosterKeys: string[];
  /** The connected mailbox's own address: people mail reports to themselves. */
  ownAddress: string;
  /** True when an earlier message in this thread produced an imported report. */
  threadProducedReport: boolean;
}

export type PrefilterBand = 'DROP' | 'CANDIDATE' | 'FORCE';

export interface PrefilterVerdict {
  score: number;
  band: PrefilterBand;
  /** The signals that moved the score, strongest first, for display. */
  signals: string[];
}

export const DROP_BELOW = 3;
export const FORCE_ABOVE = 6;

/** Counts non-overlapping matches of a token list, for capped vocabulary rules. */
function countTokens(haystack: string, pattern: string): number {
  let n = 0;
  for (const token of pattern.split('|')) {
    const re = new RegExp(`\\b${token.replace(/[.*+?^${}()[\]\\]/g, '\\$&')}`, 'gi');
    n += (haystack.match(re) || []).length;
  }
  return n;
}

function hasTableOfSize(html: string, minRows: number, minCols: number): boolean {
  for (const block of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = block.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < minRows) continue;
    const cols = ((rows[0] ?? '').match(/<t[hd]\b/gi) || []).length;
    if (cols >= minCols) return true;
  }
  return false;
}

/**
 * Scores one message.
 *
 * FORCE is checked last and overrides everything: a message carrying a
 * spreadsheet from a colleague on a thread that has produced reports before is
 * a report even if it also happens to contain the word "invoice".
 */
export function scoreMessage(
  input: PrefilterInput, rules: PrefilterRule[]
): PrefilterVerdict {
  // No rules configured means nothing has been decided, and deciding to drop
  // the whole mailbox on the strength of an empty table is the worst possible
  // reading of that. Everything is opened until somebody says otherwise.
  if (!rules.some(r => r.active)) {
    return { score: FORCE_ABOVE + 1, band: 'FORCE',
             signals: ['no prefilter rules configured — every message is opened'] };
  }

  const body = `${input.bodyText}\n${input.bodyHtml.replace(/<[^>]+>/g, ' ')}`.toLowerCase();
  const subject = (input.subject || '').toLowerCase();
  const from = (input.from || '').toLowerCase();
  const headers = input.headerNames.map(h => h.toLowerCase());
  const labels = input.labelIds.map(l => l.toUpperCase());
  const files = input.attachments.map(a =>
    `${a.filename} ${a.mimeType}`.toLowerCase());

  let score = 0;
  const hits: { text: string; weight: number }[] = [];
  const add = (rule: PrefilterRule, times = 1) => {
    let delta = rule.weight * times;
    if (rule.cap !== null) {
      delta = rule.weight > 0 ? Math.min(delta, rule.cap) : Math.max(delta, rule.cap);
    }
    if (!delta) return;
    score += delta;
    hits.push({ text: `${rule.signal} (${delta > 0 ? '+' : ''}${delta})`, weight: Math.abs(delta) });
  };

  for (const rule of rules) {
    if (!rule.active) continue;
    const p = rule.pattern || '';
    switch (rule.kind) {
      case 'attachment':
        if (files.some(f => new RegExp(`(${p})`, 'i').test(f))) add(rule);
        break;
      case 'structure':
        if (p.startsWith('table>=')) {
          const [r, c] = p.slice(7).split('x').map(Number);
          if (hasTableOfSize(input.bodyHtml, r || 3, c || 2)) add(rule);
        }
        break;
      case 'body': {
        const hay = `${subject}\n${body}`;
        if (rule.cap !== null) {
          const n = countTokens(hay, p);
          if (n) add(rule, n);
        } else if (new RegExp(p, 'i').test(hay)) add(rule);
        break;
      }
      case 'subject':
        if (new RegExp(p, 'i').test(subject)) add(rule);
        break;
      case 'header':
        if (p.startsWith('category_')) {
          const want = p.replace('category_', '').toUpperCase();
          if (labels.some(l => l === `CATEGORY_${want}`)) add(rule);
        } else if (headers.includes(p)) add(rule);
        break;
      case 'sender':
        if (p === 'tenant-domain') {
          if (input.tenantDomains.some(d => d && from.includes(`@${d}`))) add(rule);
        } else if (p === 'roster') {
          if (input.rosterKeys.some(k => k && from.includes(k))) add(rule);
        } else if (p === 'self') {
          if (input.ownAddress && from.includes(input.ownAddress)) add(rule);
        } else if (p === 'thread-history') {
          if (input.threadProducedReport) add(rule);
        } else if (new RegExp(p, 'i').test(from)) add(rule);
        break;
    }
  }

  const band: PrefilterBand =
    score > FORCE_ABOVE ? 'FORCE' : score < DROP_BELOW ? 'DROP' : 'CANDIDATE';

  return {
    score, band,
    // A decision with no stated reason is not a decision a manager can argue
    // with. Silence is itself the reason, and it is written down.
    signals: hits.length
      ? hits.sort((a, b) => b.weight - a.weight).map(h => h.text).slice(0, 6)
      : ['nothing in this message resembles a report']
  };
}
