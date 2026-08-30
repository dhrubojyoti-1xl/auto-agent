/**
 * Reports that arrive as a link rather than a file.
 *
 * A department that keeps its daily report in a Google Sheet does not attach
 * it — it pastes the link, which is the natural thing to do and produces an
 * email with no table and no attachment. Before this, the assistant scanned
 * such a message, found nothing, and correctly reported "0 reports": the data
 * was one hop away and nobody was told.
 *
 * The hop is taken without any additional Google permission. A sheet shared as
 * "anyone with the link can view" answers its own CSV export URL to an
 * unauthenticated request, so following the link needs no Drive scope, no
 * re-consent, and no Google verification review — which matters, because the
 * Drive scopes are the ones that require it.
 *
 * A sheet that is not link-shared answers with a sign-in page instead. That is
 * a case to report, not to retry: only the sender can change the sharing.
 */

/** Google file ids are long and alphanumeric; the separators are - and _. */
const SHEET_RE = /https?:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/g;

export interface SheetLink {
  id: string;
  /** The tab, when the link points at one. */
  gid: string;
  url: string;
  exportUrl: string;
}

export function exportUrlFor(id: string, gid = ''): string {
  const base = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  return gid ? `${base}&gid=${gid}` : base;
}

/**
 * The whole workbook rather than one tab.
 *
 * A CSV export returns a single sheet — the first, or the one the link named.
 * A team that keeps one tab per department, or this month beside last month,
 * would have every tab but one silently ignored. The xlsx export returns them
 * all, and the spreadsheet parser already turns every worksheet into a table.
 *
 * Still no Google permission: this is the same public export endpoint.
 */
export function workbookUrlFor(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
}

/**
 * Every distinct Google Sheet referenced anywhere in the message.
 *
 * Both the HTML and the plain-text part are searched: a link pasted into Gmail
 * appears as an href in one and as bare text in the other, and which of those
 * survives depends on the sending client.
 */
export function findSheetLinks(html: string, text: string): SheetLink[] {
  const seen = new Map<string, SheetLink>();
  const haystack = `${html || ''}\n${text || ''}`;

  for (const m of haystack.matchAll(SHEET_RE)) {
    const id = m[1];
    // The gid follows the id in the same URL, usually after #gid= .
    const tail = haystack.slice(m.index! + m[0].length, m.index! + m[0].length + 120);
    const gid = tail.match(/[#&?]gid=(\d+)/)?.[1] || '';
    const key = `${id}:${gid}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      id, gid,
      url: `https://docs.google.com/spreadsheets/d/${id}`,
      exportUrl: exportUrlFor(id, gid)
    });
  }
  return [...seen.values()];
}

export type SheetFetch =
  | { ok: true; kind: 'csv'; csv: string }
  | { ok: true; kind: 'workbook'; workbook: Buffer }
  | { ok: false; reason: 'NOT_SHARED' | 'TOO_LARGE' | 'FAILED'; detail: string };

/**
 * Google answers a restricted file with 200 and a sign-in page rather than a
 * 403, so the content type is what distinguishes "here is your CSV" from
 * "please sign in".
 */
export async function fetchSheetCsv(
  link: SheetLink,
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<SheetFetch> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(link.exportUrl, {
      redirect: 'follow', signal: controller.signal
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok || !type.includes('text/csv')) {
      return {
        ok: false, reason: 'NOT_SHARED',
        detail: `A report was detected as a Google Sheet, and the sheet cannot be read. ` +
                `Set its sharing to "Anyone with the link can view", or attach the file ` +
                `to the email. ${link.url}`
      };
    }

    const size = Number(res.headers.get('content-length') || 0);
    if (size > maxBytes) {
      return {
        ok: false, reason: 'TOO_LARGE',
        detail: `The Google Sheet at ${link.url} is ${Math.round(size / 1024)}KB, over the ` +
                `${Math.round(maxBytes / 1024)}KB limit.`
      };
    }

    const csv = await res.text();
    if (csv.length > maxBytes) {
      return {
        ok: false, reason: 'TOO_LARGE',
        detail: `The Google Sheet at ${link.url} exceeded the size limit while downloading.`
      };
    }
    return { ok: true, kind: 'csv', csv };
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return {
      ok: false, reason: 'FAILED',
      detail: aborted
        ? `Timed out after ${timeoutMs}ms opening the Google Sheet at ${link.url}.`
        : `Could not open the Google Sheet at ${link.url}: ${(e as Error).message}`.slice(0, 300)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches every tab of a sheet, falling back to the single-tab CSV export.
 *
 * The workbook export is tried first because it is the complete answer. The
 * CSV fallback exists because a link that names a specific tab (#gid=) means
 * the sender pointed at that tab deliberately, and because a workbook export
 * can fail for reasons a CSV export does not.
 */
export async function fetchSheet(
  link: SheetLink, opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<SheetFetch> {
  // A link that names a tab is a link to that tab.
  if (!link.gid) {
    const wb = await fetchWorkbook(link, opts);
    if (wb.ok) return wb;
    // A permission failure is final; anything else is worth one CSV attempt.
    if (wb.reason === 'NOT_SHARED') {
      const csv = await fetchSheetCsv(link, opts);
      return csv.ok ? csv : wb;
    }
  }
  return fetchSheetCsv(link, opts);
}

async function fetchWorkbook(
  link: SheetLink, opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<SheetFetch> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(workbookUrlFor(link.id), {
      redirect: 'follow', signal: controller.signal
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !/spreadsheetml|octet-stream|excel/.test(type)) {
      return {
        ok: false, reason: 'NOT_SHARED',
        detail: `A report was detected as a Google Sheet, and the sheet cannot be read. ` +
                `Set its sharing to "Anyone with the link can view", or attach the file ` +
                `to the email. ${link.url}`
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      return {
        ok: false, reason: 'TOO_LARGE',
        detail: `The Google Sheet at ${link.url} is ${Math.round(buf.length / 1024)}KB, ` +
                `over the ${Math.round(maxBytes / 1024)}KB limit.`
      };
    }
    return { ok: true, kind: 'workbook', workbook: buf };
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return {
      ok: false, reason: 'FAILED',
      detail: aborted
        ? `Timed out after ${timeoutMs}ms opening the Google Sheet at ${link.url}.`
        : `Could not open the Google Sheet at ${link.url}: ${(e as Error).message}`.slice(0, 300)
    };
  } finally {
    clearTimeout(timer);
  }
}
