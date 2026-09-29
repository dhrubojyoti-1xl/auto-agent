'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * Ordered by how often a manager needs them. Management first, because that is
 * where the answer to "what happened" lives; Manual entry last, because the
 * whole point of the product is that nobody uses it day to day. Last, not
 * greyed out: at 62% opacity it read as a disabled link.
 */
const LINKS: [string, string, boolean?][] = [
  ['/management', 'Management'],
  ['/', 'Overview'],
  ['/connect', 'Inbox'],
  ['/report', 'Management report'],
  ['/repeats', 'Repeated tasks'],
  ['/slow', 'Slow tasks'],
  ['/quality', 'Data quality'],
  ['/health', 'Sync health'],
  ['/roster', 'Team roster'],
  ['/submit', 'Manual entry', true]
];

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  // On a phone the links are one row that scrolls sideways; bring the current
  // page's link into view, or "Manual entry" is off the right edge. On a wide
  // screen nothing scrolls and this does nothing.
  const links = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = links.current;
    const active = box?.querySelector<HTMLElement>('a.active');
    if (box && active && box.scrollWidth > box.clientWidth) {
      box.scrollLeft = active.offsetLeft - (box.clientWidth - active.offsetWidth) / 2;
    }
  }, [pathname]);
  return (
    <nav className="top">
      <div className="inner">
        <span className="brand">Department Reporting</span>
        <div className="links" ref={links}>
          {LINKS.map(([href, label, secondary]) => (
            <Link key={href} href={href}
                  className={(pathname === href ? 'active' : '') + (secondary ? ' secondary-link' : '')}>
              {label}
            </Link>
          ))}
        </div>
        <form onSubmit={async e => {
          e.preventDefault();
          await fetch('/api/logout', { method: 'POST' });
          router.push('/login');
          router.refresh();
        }}>
          <button className="secondary" type="submit">Sign out</button>
        </form>
      </div>
    </nav>
  );
}
