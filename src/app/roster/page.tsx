import { redirect } from 'next/navigation';
import Nav from '../nav';
import ImportForm from './import-form';
import { getSession } from '@/lib/auth';
import { loadRoster } from '@/lib/db';
import { getAutoCreatedEmployees } from '@/lib/queries';
import { likelySamePerson, looksLikePersonName } from '@/lib/core/person-name';

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

  const [{ people: everyone, departments }, guessedHere] = await Promise.all([
    loadRoster(), getAutoCreatedEmployees(session.userId)
  ]);
  // The roster is the list the organisation gave. Records the importer made up
  // from reports are shown apart from it: the ones that could be a person as a
  // short list to confirm, and the rest — task titles, places, software panels
  // an earlier version filed as people — as a count. Nothing is deleted.
  //
  // Only guesses with work filed in this account are worth confirming. The
  // rest — test names from another inbox among them — are counted, not listed.
  const people = everyone.filter(p => !p.autoCreated);
  const rosterNames = people.map(p => p.name);
  const tasksById = new Map(guessedHere.map(g => [g.id, g.tasks]));
  const guessed = everyone.filter(p => p.autoCreated);
  const personLike = guessed.filter(p => looksLikePersonName(p.name));
  const guessedPeople = personLike.filter(p => (tasksById.get(p.id) || 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const idleGuesses = personLike.length - guessedPeople.length;
  const guessedJunk = guessed.length - personLike.length;
  const rosterOnly = /^(1|true|yes|on)$/i.test(process.env.ROSTER_ONLY || '') && people.length > 0;
  const undeclared = people.filter(p => !p.department);
  const byDepartment = new Map<string, typeof people>();
  people.forEach(p => {
    const k = p.department || 'Not stated';
    byDepartment.set(k, [...(byDepartment.get(k) || []), p]);
  });
  const managerOf = new Map(departments.map(d => [d.name, d]));
  const unstaffed = departments.filter(d =>
    !byDepartment.has(d.name) && d.manager && d.name.toLowerCase() !== 'unassigned');

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
            <span><b>{people.length}</b> on your list</span>
            <span><b>{byDepartment.size}</b>{' '}
              {byDepartment.size === 1 ? 'department' : 'departments'}</span>
            {guessedPeople.length > 0 && <span><b>{guessedPeople.length}</b> guessed</span>}
          </div>
        </div>

        {rosterOnly && (
          <div className="banner ok" style={{ marginBottom: '1rem' }}>
            <strong>Only the people on your list are imported.</strong> Reports from anyone
            else are left out. Add someone below if they should be included.
          </div>
        )}

        {(guessedPeople.length > 0 || undeclared.length > 0) && (
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
            {guessedPeople.length > 0 && (
              <p>
                <b>{guessedPeople.length}</b>{' '}
                {guessedPeople.length === 1 ? 'name was' : 'names were'} taken from old
                reports and {guessedPeople.length === 1 ? 'is' : 'are'} not on your list
                {rosterOnly ? ', so their reports are not imported' : ''}. If any of them
                should be, add them in the list below.
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
                            <td className="cap">your list</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
        )}

        {guessedPeople.length > 0 && (
          <details className="chart-card" style={{ marginBottom: '1rem' }}>
            <summary style={{ cursor: 'pointer' }}>
              <b>Guessed from old reports, not on your list</b>{' '}
              <span className="muted">({guessedPeople.length})</span>
            </summary>
            <p className="cap" style={{ marginTop: '.6rem' }}>
              Names an earlier import took from reports. The department is its guess. Where
              a name is probably someone on your list spelt differently, add it to that
              person&rsquo;s &ldquo;Also known as&rdquo; so their reports are counted.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th><th>Guessed department</th><th className="num">Tasks</th>
                    <th>Possibly the same as</th>
                  </tr>
                </thead>
                <tbody>
                  {guessedPeople.map(p => (
                    <tr key={p.id}>
                      <td>{p.name}</td><td>{p.department || '—'}</td>
                      <td className="num">{tasksById.get(p.id) || 0}</td>
                      <td>{likelySamePerson(p.name, rosterNames) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {idleGuesses > 0 && (
          <p className="small muted">
            {idleGuesses} other name{idleGuesses === 1 ? '' : 's'} taken from reports
            {idleGuesses === 1 ? ' has' : ' have'} no work filed in this account and
            {idleGuesses === 1 ? ' is' : ' are'} not shown.
          </p>
        )}

        {guessedJunk > 0 && (
          <p className="small muted">
            {guessedJunk} more record{guessedJunk === 1 ? ' is' : 's are'} task titles, places
            and lists of names that an earlier version filed as people. They are not shown and
            are not used for anything.
          </p>
        )}

        {/* Only departments someone runs. The app's first-run defaults
            (Finance, Marketing, Sales, Support) have no manager and nobody
            on the list, and "Unassigned" is the absence of a department:
            listing them made the company's own structure look wrong. */}
        {unstaffed.length > 0 && (
          <div className="chart-card">
            <h3>Departments with nobody listed</h3>
            <p className="cap">
              These have a manager, but nobody on your list is in them yet.
            </p>
            <ul>
              {unstaffed.map(d => (
                <li key={d.id}>{d.name} — {d.manager}</li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}
