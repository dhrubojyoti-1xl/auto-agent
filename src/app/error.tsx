'use client';
import { useEffect } from 'react';

/**
 * The last line of defence for any page that throws. Without it Next shows its
 * own generic screen, which tells a manager nothing and offers no way back.
 *
 * The error's own text is deliberately not printed: this boundary catches
 * database and configuration failures, whose messages can carry connection
 * details. The digest is enough to find the matching server log.
 */
export default function AppError({
  error, reset
}: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('page error', error.digest || error.message); }, [error]);

  return (
    <main className="shell">
      <h1>Something went wrong on this page</h1>
      <div className="banner bad">
        <strong>The page could not be loaded.</strong> This is usually the database being
        briefly unreachable. Your imported reports are not affected.
      </div>
      <p className="small muted">
        Try again in a moment. If it keeps happening, open <a href="/health">Sync health</a> —
        it shows whether the database and the connected inbox are reachable.
        {error.digest && <> Reference: <code>{error.digest}</code>.</>}
      </p>
      <div className="row">
        <button onClick={reset}>Try again</button>
        <a className="btn secondary" href="/health">Sync health</a>
      </div>
    </main>
  );
}
