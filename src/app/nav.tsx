'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const LINKS = [
  ['/', 'Overview'],
  ['/management', 'Management'],
  ['/connect', 'Inbox'],
  ['/submit', 'Manual entry'],
  ['/repeats', 'Repeated tasks'],
  ['/slow', 'Slow tasks'],
  ['/quality', 'Data quality'],
  ['/report', 'Management report'],
  ['/health', 'Sync health']
];

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <nav className="top">
      <div className="inner">
        <span className="brand">Department Reporting</span>
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href} className={pathname === href ? 'active' : ''}>{label}</Link>
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
