/**
 * Error text that is safe to put on a screen.
 *
 * Connection failures are the errors most likely to reach a user, and a
 * Postgres URL carries a password. Node's own messages sometimes echo the
 * connection target, and a well-meaning `${e.message}` in a page then prints a
 * credential into a browser tab and any screenshot of it. Redacting at the
 * point of display is the only reliable place: every call site that formats an
 * error would otherwise have to remember.
 */
const PATTERNS: [RegExp, string][] = [
  // Anything shaped like scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1***:***@'],
  // Bare secrets that occasionally appear in provider errors.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***'],
  [/\b(password|pwd|secret|token|api[-_]?key)\s*[=:]\s*("?)[^\s"&,;]+\2/gi, '$1=***'],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***']
];

export function safeErrorMessage(err: unknown, max = 300): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  let out = raw;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out.slice(0, max);
}
