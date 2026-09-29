/**
 * A report pasted into Manual entry, as the document the engine reads.
 *
 * Shared by preview and commit so the two can never disagree about what was
 * pasted: the id is derived from the content, which is what lets "preview,
 * then confirm" and "confirm the same paste twice" both resolve to one document.
 */
import type { SourceDocument } from './core/types';
import { cleanWhitespace, parseDate, shortHash } from './core/normalize';

export function pastedDocument(
  body: Record<string, unknown>, dateOrder: 'DMY' | 'MDY'
): SourceDocument {
  const content = String(body.content || '');
  const subject = String(body.subject || 'Pasted report');
  // A copy out of Google Sheets arrives as the sheet's own HTML table, which
  // keeps merged title rows and links that the plain-text copy loses.
  const isHtml = /<\s*(table|tr|td|div|p)\b/i.test(content);

  // Optional, for a table that names nobody or no day. Never overrides what
  // the table itself says.
  const employee = cleanWhitespace(body.employee).slice(0, 80);
  const rawDate = cleanWhitespace(body.date);
  const date = rawDate ? parseDate(rawDate, dateOrder) : null;
  const stated = employee || date ? `|${employee}|${date || ''}` : '';

  return {
    documentId: 'PASTE-' + shortHash(subject + '|' + content + stated, 16),
    subject,
    sender: String(body.sender || 'dashboard@local'),
    receivedAt: new Date().toISOString(),
    html: isHtml ? content : undefined,
    text: isHtml ? undefined : content,
    ...(employee ? { statedEmployee: employee } : {}),
    ...(date ? { statedDate: date,
                 titleDate: { date, quote: 'entered on the Manual entry form' } } : {})
  };
}
