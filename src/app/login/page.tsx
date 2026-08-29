import { googleConfigured } from '@/lib/google-oauth';
import { passwordLoginEnabled } from '@/lib/auth';
import PasswordForm from './password-form';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  not_configured: 'Google sign-in is not configured on this deployment yet.',
  state_mismatch: 'That sign-in attempt could not be verified. Please try again.',
  missing_code: 'Google did not return an authorisation code. Please try again.',
  no_refresh_token: 'Google did not issue a refresh token, so the assistant could not keep reading your inbox unattended. Remove this app at myaccount.google.com/permissions, then sign in again.',
  gmail_scope_denied: 'Gmail read access was not granted, so no reports could be collected. Sign in again and leave the Gmail permission ticked.',
  no_id_token: 'Google did not return an identity token. Please try again.',
  access_denied: 'Sign-in was cancelled.'
};

export default async function LoginPage({
  searchParams
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const configured = googleConfigured();
  const passwordEnabled = passwordLoginEnabled();
  const errKey = params.error || '';
  const errMsg = errKey ? (ERRORS[errKey] || decodeURIComponent(errKey)) : '';

  return (
    <div className="center">
      <div style={{ width: 400 }}>
        <div className="card">
          <h1 style={{ marginBottom: '.35rem' }}>Department Reporting System</h1>
          <p className="sub" style={{ marginBottom: '1.2rem' }}>
            Sign in with the Google account that receives your team&apos;s daily reports.
          </p>

          {errMsg && <div className="banner bad">{errMsg}</div>}

          {configured ? (
            <>
              <a className="btn" href="/api/auth/google"
                 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                          gap: '.6rem', width: '100%', padding: '.65rem' }}>
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.0 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
                  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.0 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
                  <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
                  <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C40.9 35.9 44 30.5 44 24c0-1.3-.1-2.6-.4-3.9z"/>
                </svg>
                Continue with Google
              </a>
              <p className="small muted" style={{ marginTop: '.8rem', textAlign: 'center' }}>
                Grants <strong>read-only</strong> Gmail access. The assistant can see report
                emails and attachments; it cannot send, delete, label or change anything.
              </p>
            </>
          ) : (
            <div className="banner warn" style={{ marginBottom: 0 }}>
              <strong>Google sign-in is not configured yet.</strong> An administrator needs to
              set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.
              See <code>docs/GOOGLE_OAUTH_SETUP.md</code>.
            </div>
          )}

          {passwordEnabled && <PasswordForm hasGoogle={configured} />}
        </div>

        <p className="small muted" style={{ textAlign: 'center', marginTop: '1rem' }}>
          Departments keep emailing reports exactly as they do today.
        </p>
      </div>
    </div>
  );
}
