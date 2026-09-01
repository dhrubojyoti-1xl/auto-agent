import { redirect } from 'next/navigation';
import Nav from '../nav';
import ImportForm from './import-form';
import { getSession } from '@/lib/auth';
import { loadRoster } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * The one screen where the organisation tells the product something it cannot
 * work out on its own.
 *
 * It leads with what is wrong rather than what is there — people the importer
 * had to guess at, and people with no department — because those are the rows
 * that are currently landing in "Unassigned" on the management dashboard, and
 * this page is the only place they can be fixed.
 */
export default async function RosterPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const { people, departments } = await loadRoster();
  const guessed = people.filter(p => p.autoCreated);
  const undeclared = people.filter(p => !p.department);
  const byDepartment = new Map<string, typeof people>();
  people.forEach(p => {
    const k = p.department || 'Not stated';
    byDepartment.set(k, [...(byDepartment.get(k) || []), p]);
  });
  const managerOf = new Map(departments.map(d => [d.name, d]));

  return (
    <>
      <Nav />
      <main className="shell">
        <div className="page-head">
          <div>
            <h1>Team roster</h1>
            <p className="sub" style={{ margin: 0 }}>
              Who belongs to which department, and who runs each one. A daily report that
              names only a person can be filed to a department only if this list knows where
              that person sits &mdash; otherwise their work counts, but under &ldquo;Unassigned&rdquo;.
            </p>
          </div>
          <div className="page-meta">
            <span><b>{people.length}</b> {people.length === 1 ? 'person' : 'people'}</span>
            <span><b>{departments.length}</b>{' '}
              {departments.length === 1 ? 'department' : 'departments'}</span>
            {guessed.length > 0 && <span><b>{guessed.length}</b> guessed</span>}
          </div>
        </div>

        {(guessed.length > 0 || undeclared.length > 0) && (
          <div className="chart-card" style={{ marginBottom: '1.2rem' }}>
            <h3>Worth confirming</h3>
            {undeclared.length > 0 && (
              <p>
                <b>{undeclared.length}</b>{' '}
                {undeclared.length === 1 ? 'person has' : 'people have'} no department:{' '}
                {undeclared.slice(0, 12).map(p => p.name).join(', ')}
                {undeclared.length > 12 && ` and ${undeclared.length - 12} more`}.
                Their work is counted, but it shows as Unassigned.
              </p>
            )}
            {guessed.length > 0 && (
              <p>
                <b>{guessed.length}</b>{' '}
                {guessed.length === 1 ? 'name was' : 'names were'} taken from a report rather
                than from you: {guessed.slice(0, 12).map(p => p.name).join(', ')}
                {guessed.length > 12 && ` and ${guessed.length - 12} more`}.
                Including them below confirms them; leaving them out changes nothing.
              </p>
            )}
          </div>
        )}

        <ImportForm />

        <h2 style={{ marginTop: '1.6rem' }}>Current roster</h2>

        {people.length === 0 && departments.length === 0 ? (
          <div className="chart-card">
            <p>
              Nothing here yet. Until this list exists, every report that names a person
              without naming their department files that work under &ldquo;Unassigned&rdquo;.
              Paste your team list above and it stops happening from the next sync onward.
            </p>
          </div>
        ) : (
          [...byDepartment.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([dept, members]) => {
              const d = managerOf.get(dept);
              return (
                <div className="chart-card" key={dept} style={{ marginBottom: '1rem' }}>
                  <h3>{dept}</h3>
                  <p className="cap">
                    {members.length} {members.length === 1 ? 'person' : 'people'}
                    {d?.manager
                      ? ` · manager ${d.manager}${d.managerEmail ? ` (${d.managerEmail})` : ''}`
                      : ' · no manager recorded'}
                  </p>
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th><th>Role</th><th>Email</th>
                          <th>Also known as</th><th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map(p => (
                          <tr key={p.id}>
                            <td>{p.name}</td>
                            <td>{p.role || '—'}</td>
                            <td>{p.email || '—'}</td>
                            <td>{p.aliases.join(', ') || '—'}</td>
                            <td className="cap">
                              {p.autoCreated ? 'guessed from a report' : 'you'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
        )}

        {departments.filter(d => !byDepartment.has(d.name)).length > 0 && (
          <div className="chart-card">
            <h3>Departments with nobody listed</h3>
            <p className="cap">
              These exist and have a manager, but no one has been assigned to them yet.
            </p>
            <ul>
              {departments.filter(d => !byDepartment.has(d.name)).map(d => (
                <li key={d.id}>
                  {d.name}{d.manager ? ` — ${d.manager}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}
