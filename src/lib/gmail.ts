/**
 * Gmail REST client — read only.
 *
 * Uses plain fetch rather than googleapis: one fewer heavy dependency, and
 * everything here is three endpoints. All calls are GET; nothing in this file
 * can modify a mailbox even if it wanted to.
 */
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Every call is bounded in time and retried a fixed number of times.
 *
 * Without a timeout a single stalled request holds the whole sync until the
 * serverless function is killed, which leaves the run marked RUNNING for ever
 * and gives the manager no idea what happened. Without a retry, one 503 from
 * Gmail — which happens — throws away an entire scheduled sync until tomorrow.
 *
 * Only transient conditions are retried: network failures, 429, and 5xx. A 401
 * or 403 means the grant is gone or the scope is wrong, and repeating the call
 * cannot change that. The backoff is short and the attempt count small, because
 * the whole sync has to finish inside a serverless invocation.
 */
export const REQUEST_TIMEOUT_MS = Number(process.env.GMAIL_TIMEOUT_MS || 20_000);
export const MAX_ATTEMPTS = Number(process.env.GMAIL_MAX_ATTEMPTS || 3);
const BACKOFF_MS = Number(process.env.GMAIL_BACKOFF_MS || 400);

export function isTransient(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;             // ISO
  snippet: string;
  html: string;
  text: string;
  attachments: GmailAttachment[];
  labelIds: string[];
}

async function api<T>(path: string, accessToken: string): Promise<T> {
  let lastError: Error = new Error(`Gmail API never attempted ${path}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API}${path}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal
      });
      if (res.ok) return await res.json() as T;

      const body = (await res.text()).slice(0, 300);
      const err = new Error(`Gmail API ${res.status} on ${path}: ${body}`);
      (err as Error & { status?: number }).status = res.status;
      if (!isTransient(res.status) || attempt === MAX_ATTEMPTS) throw err;
      lastError = err;
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      // A thrown response error that is not transient has already been decided
      // above; anything else here is a network failure or the timeout firing.
      if (status !== undefined && !isTransient(status)) throw e;
      if (attempt === MAX_ATTEMPTS) {
        throw (e as Error).name === 'AbortError'
          ? Object.assign(new Error(
              `Gmail API timed out after ${REQUEST_TIMEOUT_MS}ms on ${path}`), { status: 504 })
          : e;
      }
      lastError = e as Error;
    } finally {
      clearTimeout(timer);
    }
    await sleep(BACKOFF_MS * attempt);
  }
  throw lastError;
}

export async function listMessageIds(
  accessToken: string, query: string, max = 100
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - ids.length)) });
    if (pageToken) p.set('pageToken', pageToken);
    const page = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
      `/messages?${p.toString()}`, accessToken);
    (page.messages || []).forEach(m => ids.push(m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

interface MessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: MessagePart[];
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function header(headers: { name: string; value: string }[] | undefined, name: string): string {
  const h = (headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/**
 * Walks the MIME tree. Real mail nests arbitrarily deep
 * (multipart/mixed > multipart/alternative > text/html), and attachments can
 * appear at any level, so this recurses rather than assuming a shape.
 */
function walkParts(
  part: MessagePart,
  out: { html: string[]; text: string[]; attachments: GmailAttachment[] }
): void {
  const mime = (part.mimeType || '').toLowerCase();
  const filename = part.filename || '';

  if (filename && part.body?.attachmentId) {
    out.attachments.push({
      filename,
      mimeType: mime,
      attachmentId: part.body.attachmentId,
      size: part.body.size || 0
    });
  } else if (mime === 'text/html' && part.body?.data) {
    out.html.push(decodeB64Url(part.body.data));
  } else if (mime === 'text/plain' && part.body?.data) {
    out.text.push(decodeB64Url(part.body.data));
  }
  (part.parts || []).forEach(p => walkParts(p, out));
}

export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  const msg = await api<{
    id: string; threadId: string; snippet: string; internalDate: string;
    labelIds?: string[]; payload: MessagePart;
  }>(`/messages/${id}?format=full`, accessToken);

  const acc = { html: [] as string[], text: [] as string[], attachments: [] as GmailAttachment[] };
  walkParts(msg.payload, acc);

  const h = msg.payload.headers;
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: header(h, 'Subject'),
    from: header(h, 'From'),
    to: header(h, 'To'),
    date: new Date(Number(msg.internalDate)).toISOString(),
    snippet: msg.snippet || '',
    html: acc.html.join('\n'),
    text: acc.text.join('\n'),
    attachments: acc.attachments,
    labelIds: msg.labelIds || []
  };
}

export async function getAttachment(
  accessToken: string, messageId: string, attachmentId: string
): Promise<Buffer> {
  const a = await api<{ data: string; size: number }>(
    `/messages/${messageId}/attachments/${attachmentId}`, accessToken);
  return Buffer.from(a.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export async function getProfile(accessToken: string): Promise<{ emailAddress: string; messagesTotal: number }> {
  return api('/profile', accessToken);
}
