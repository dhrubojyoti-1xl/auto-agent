# Google OAuth setup (one-time, administrator)

This is the only Google configuration anyone ever does. After it, a manager
signs in once and the assistant reads their inbox automatically — for good.

They never create a label, a filter, a forward, or run anything.

Time: about 10 minutes.

---

## What the app asks for, and what it cannot do

| Scope | Why |
|---|---|
| `openid`, `userinfo.email`, `userinfo.profile` | to know who connected |
| `gmail.readonly` | to read report emails and their attachments |

`gmail.readonly` **cannot send, delete, label, archive or modify anything.**
That is a hard boundary enforced by Google, not a promise in our code — the
access token is simply not valid for those operations. It is also why this
design needs no Gmail labels: the assistant observes the mailbox instead of
organising it.

The refresh token is encrypted with AES-256-GCM before it touches the database
(`src/lib/crypto.ts`), so a database dump on its own cannot read anyone's mail.

---

## STEP 1 — Create a Google Cloud project

1. <https://console.cloud.google.com/projectcreate>
2. Name it e.g. `department-reporting`. Create, then select it.

## STEP 2 — Enable the Gmail API

1. **APIs & Services → Library**
2. Search **Gmail API** → **Enable**.

## STEP 3 — Configure the consent screen

1. **APIs & Services → OAuth consent screen**
2. User type:
   - **Internal** if you have Google Workspace and only your own staff connect.
     Choose this — it skips verification entirely.
   - **External** otherwise. It works immediately in *Testing* mode; see the
     verification note below.
3. App name, support email, developer contact. Logo optional.
4. **Scopes → Add or remove scopes → Manually add**:

   ```
   https://www.googleapis.com/auth/gmail.readonly
   ```

   Also tick `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
5. **External only:** under *Test users*, add every manager who will connect an
   inbox. In Testing mode only listed users can authorise.

## STEP 4 — Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**
2. Application type: **Web application**
3. Name: `Department Reporting web`
4. **Authorised redirect URIs** — add exactly, one per line:

   ```
   https://<your-app>.vercel.app/api/auth/google/callback
   http://localhost:3210/api/auth/google/callback
   ```

   It must match character for character, including the scheme and any trailing
   path. A mismatch produces `redirect_uri_mismatch` and nothing else.
5. Create. Copy the **Client ID** and **Client secret**.

## STEP 5 — Put them in the deployment

Vercel → your project → **Settings → Environment Variables** → Production:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 4 |
| `GOOGLE_CLIENT_SECRET` | from step 4 |
| `TOKEN_ENCRYPTION_KEY` | 32+ random characters, see below |
| `CRON_SECRET` | 32+ random characters, see below |

```bash
node -e "console.log('TOKEN_ENCRYPTION_KEY', require('crypto').randomBytes(32).toString('hex'))"
```

```bash
node -e "console.log('CRON_SECRET', require('crypto').randomBytes(32).toString('hex'))"
```

> **`TOKEN_ENCRYPTION_KEY` is not rotatable in place.** Change it and every
> stored refresh token becomes undecryptable, and every connected inbox must be
> reconnected. Set it once and keep it.

Redeploy so the values take effect:

```bash
cd web && npx vercel --prod
```

## STEP 6 — Confirm

```bash
curl -s https://<your-app>.vercel.app/api/health
```

You want:

```json
{"ok":true,"checks":{"database":"ok","googleOauth":"configured",
 "tokenEncryption":"configured","cronSecret":"configured","connectedInboxes":"0"}}
```

`"ok": true` requires the database, the app password, the session secret, Google
OAuth and token encryption to all be present. A deployment missing any of them
cannot run the product flow, so it deliberately reports unhealthy.

## STEP 7 — Hand it to the manager

They open the app, sign in with the team password, go to **Inbox**, and click
**Connect Gmail**. Google shows the consent screen; they approve; the first sync
starts on its own and reports appear on the Overview page.

That is the whole end-user experience.

---

## The hourly loop

`vercel.json` registers a cron job:

```json
{ "crons": [{ "path": "/api/cron/sync", "schedule": "0 * * * *" }] }
```

Vercel calls it with `Authorization: Bearer $CRON_SECRET`; without a matching
secret the endpoint returns 401, so it cannot be driven from outside.

Each run: reads new mail on every connected inbox, imports whatever is a report,
rebuilds the repeat/slow analysis, and regenerates the management summary **only
if something changed**.

> **Vercel Hobby plans allow one cron execution per day.** Hourly needs Pro. On
> Hobby, either accept daily collection, use the **Sync now** button, or point
> any external scheduler (cron-job.org, GitHub Actions, an existing server) at
> `GET /api/cron/sync` with the same bearer token.

## Verification (External user type only)

In *Testing* mode the app works immediately for listed test users, with two
caveats Google imposes:

- refresh tokens expire after **7 days**, so managers must reconnect weekly
- a "Google hasn't verified this app" warning appears; users click *Advanced →
  Go to …*

`gmail.readonly` is a **restricted** scope, so moving to Production requires
Google's verification, which includes a security assessment and takes weeks.

**Use Internal (Workspace) if you possibly can** — it avoids all of this. If the
managers' mailboxes are on a Workspace domain you control, Internal is both
simpler and stricter.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` | the URI in step 4 differs from the deployment origin | copy the exact URL from the browser's address bar during the failed attempt |
| `no_refresh_token` on the Connect page | Google omits it when the app is already authorised | remove the app at <https://myaccount.google.com/permissions> and connect again; the code already sends `prompt=consent`, this covers the residual case |
| `gmail_scope_denied` | the user unticked the Gmail permission | reconnect and leave it ticked; without it there is nothing to read |
| `access_blocked` / `app not verified` | External + user not in Test users | add them under *Test users*, or switch to Internal |
| Status shows `REAUTH_REQUIRED` | user revoked access, changed password, or the 7-day Testing token expired | click **Connect Gmail** again |
| Health says `googleOauth: MISSING` | env vars not set for the Production environment | re-add and redeploy |
| Syncs run but find nothing | nothing in the window looks like a report | the window is `sync_since` (default 14 days). Confirm a report actually contains Date/Employee/Task/Status columns; the Data quality page shows what was examined and rejected |
