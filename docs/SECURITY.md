# Security model

## Identity

"Continue with Google" is the primary sign-in. The Google account that signs in
is the same account whose mailbox is read — one consent, one identity.

`APP_PASSWORD` remains as a **fallback identity** so the app is usable before a
Google client is configured. It is user id 1 and owns its own workspace; it is
not an admin and cannot see Google users' data.

| Control | Implementation |
|---|---|
| Session | HMAC-SHA256 signed token in an **HttpOnly, SameSite=Lax** cookie, `Secure` in production, 7-day expiry |
| Session payload | `userId.kind.issuedAt.nonce.signature` — the signature covers the user id, so a session cannot be re-pointed at another user |
| Password compare | both sides hashed then compared in constant time, so neither the value nor its length leaks through timing |
| Page access | `src/middleware.ts` redirects to `/login`; **it must live in `src/`** — at the project root Next.js silently ignores it, which once left every page publicly readable |
| API access | every route re-verifies the signature itself, because middleware runs on the edge runtime where `node:crypto` is unavailable |
| OAuth CSRF | 128-bit `state` in an HttpOnly cookie, compared on callback |
| Machine ingest | separate bearer token; it can write reports but cannot read anything |
| Scheduled sync | `CRON_SECRET` bearer token; without it the endpoint 401s |

## Gmail access

The app requests `gmail.readonly` and nothing else. It **cannot** send, delete,
label, archive or modify a mailbox — enforced by Google, not by our code. That
is also why the product needs no Gmail labels: it observes rather than organises.

Two guards make this checkable rather than a promise:

- `tests/oauth.test.ts` asserts no `gmail.modify|send|compose|labels` scope is
  ever requested.
- `src/lib/gmail.ts` issues only GET requests.

If a user grants identity but declines Gmail, the callback refuses with
`gmail_scope_denied` instead of half-connecting.

## Tokens at rest

Google refresh tokens are encrypted with **AES-256-GCM**, a fresh random IV per
record, authenticated, keyed from `TOKEN_ENCRYPTION_KEY` (never in the
database). A database dump alone cannot read anyone's mail.

Tampered ciphertext throws rather than returning garbage. Access tokens are
never persisted; they are cached in memory only, keyed by account **and** by the
stored refresh token, so reconnecting cannot reuse a token minted from the old
grant.

`TOKEN_ENCRYPTION_KEY` is not rotatable in place: changing it makes every stored
token undecryptable and every inbox must be reconnected.

## Multi-user isolation

Every row carries `owner_user_id`, and uniqueness is scoped to it:

```sql
unique (owner_user_id, task_fingerprint)
unique (owner_user_id, document_id, table_index, row_index, rejection_reason)
unique (owner_user_id, report_id)
unique (owner_user_id, google_sub)
```

Two consequences worth stating plainly:

1. A missed `WHERE owner_user_id` fails closed at the database rather than
   leaking, because the constraint and the index are both scoped.
2. **The same report in two mailboxes is two facts, not a duplicate.** Global
   deduplication would silently delete a real manager's data. `tests/isolation.test.ts`
   asserts this.

`getGmailAccount(id, ownerUserId)` and `disconnectGmailAccount(id, ownerUserId)`
take the owner explicitly, so knowing an id is never sufficient.

Row-level security is enabled on every table. The app connects server-side with
a privileged connection string; no browser ever talks to Postgres, so a leaked
anon key exposes nothing.

## Secrets

- Nothing secret is in the repository; `.env*.local` is gitignored.
- Production values live only in the Vercel environment.
- `ANTHROPIC_API_KEY` is read server-side in a route handler and never reaches
  the client bundle.
- `scripts/verify-production.sh` greps the delivered HTML and JS for every
  secret name on each run.

## What this does not defend against

- A compromised Vercel account or database. Both are single points of trust.
- A malicious administrator, who can read `TOKEN_ENCRYPTION_KEY`.
- Anyone who learns `APP_PASSWORD`, if password sign-in is enabled. Unset
  `APP_PASSWORD` once Google sign-in is configured to close that door.
