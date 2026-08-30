'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

/**
 * Ordered by how often a manager needs them. Management first, because that is
 * where the answer to "what happened" lives; Manual entry last and quieter,
 * because the whole point of the product is that nobody uses it day to day.
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
  ['/submit', 'Manual entry', true]
];

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <nav className="top">
      <div className="inner">
        <span className="brand">Department Reporting</span>
        {LINKS.map(([href, label, secondary]) => (
          <Link key={href} href={href}
                className={(pathname === href ? 'active' : '') + (secondary ? ' secondary-link' : '')}>
            {label}
          </Link>
        ))}
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
