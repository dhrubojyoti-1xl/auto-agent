import Link from 'next/link';
import Nav from './nav';

/**
 * An address that is not a page — typed by hand, or an old bookmark. Next's
 * default is a bare "404" with no way back; this keeps the navigation.
 */
export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Page not found</h1>
        <p className="sub">
          There is no page at this address. It may have been typed by hand or come from an
          old link.
        </p>
        <div className="row">
          <Link className="btn" href="/">Go to Overview</Link>
          <Link className="btn secondary" href="/management">Management</Link>
        </div>
      </main>
    </>
  );
}
