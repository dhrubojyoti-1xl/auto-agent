# Deploying the web app (Supabase + Vercel)

**Current deployment:** <https://auto-agent-reporting.vercel.app>
(Vercel team `dgg3`, project `auto-agent-reporting`, Deployment Protection off,
`APP_PASSWORD` / `SESSION_SECRET` / `INGEST_TOKEN` already set.)

Only the database is outstanding. Two account-level steps genuinely need you,
because each is a legal or credential action that must not be automated:
accepting the marketplace terms (or pasting a connection string), and supplying
an Anthropic key if you want AI commentary. Everything else is scripted.

## The one-command finish

Once `DATABASE_URL` exists in the Vercel production environment:

```bash
cd web && ./scripts/finish-deploy.sh
```

That pulls the environment, applies the schema, seeds the master data,
redeploys, and runs the acceptance test.

### Getting DATABASE_URL there — two routes

**A. Vercel Marketplace (nothing to copy, no credential ever leaves Vercel)**

1. Open <https://vercel.com/dgg3/~/integrations/accept-terms/supabase?source=cli>
   and accept the marketplace terms. This is a legal agreement, which is why it
   cannot be automated.
2. Then run `npx vercel integration add supabase` — it provisions the database
   and injects `DATABASE_URL` automatically.
3. `cd web && ./scripts/finish-deploy.sh`

**B. Existing Supabase project (paste one value)**

1. Supabase → Project Settings → Database → **Connection pooling** → copy the
   URI (port **6543**).
2. Vercel → Settings → Environment Variables → add `DATABASE_URL` for
   Production.
3. `cd web && ./scripts/finish-deploy.sh`

---

## STEP 1 — Create the Supabase database

1. <https://supabase.com/dashboard> → **New project**.
2. Name it, set a database password, pick the nearest region, create.
3. Wait for provisioning (about a minute).

## STEP 2 — Apply the schema

**Supabase dashboard → SQL Editor → New query.** Paste the whole of
`web/supabase/schema.sql` and run it.

Expected: `Success. No rows returned.` It creates 12 tables and 6 views, enables
row-level security on everything, and is safe to re-run.

Verify:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by 1;
```

## STEP 3 — Get the connection string

**Project Settings → Database → Connection pooling → Connection string (URI).**

Use the **pooler** string — port `6543`, host containing `pooler.supabase.com`.

> Do not use the direct connection (port 5432). Vercel runs every request in its
> own isolate, and a direct connection pool is exhausted within minutes.

Replace `[YOUR-PASSWORD]` with the database password from step 1.

## STEP 4 — Deploy to Vercel

```bash
cd web
npx vercel link          # choose or create the project
npx vercel --prod
```

The first deploy will run, and the app will report that the database is not yet
configured — that is expected until step 5.

## STEP 4b — Turn off Deployment Protection

**This is easy to miss and it blocks everything.** If your Vercel team has
*Vercel Authentication* enabled, every deployment — production included —
redirects to Vercel SSO, so your team cannot reach the app at all:

```bash
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://<your-app>.vercel.app/api/health
# 302 -> https://vercel.com/sso-api?url=...
```

Fix it in **Project → Settings → Deployment Protection → Vercel Authentication
→ Disabled** (Standard Protection is on by default for team projects). There is
no CLI command for this; it is a dashboard toggle.

Turning it off is safe here because the app has its own authentication: every
page redirects to `/login`, and every private API returns 401 without a valid
signed session cookie.

## STEP 5 — Set the environment variables

**Vercel dashboard → your project → Settings → Environment Variables.** Add
these for **Production** (and Preview if you want previews to work):

| Name | Value | Required |
|---|---|---|
| `DATABASE_URL` | the pooler string from step 3 | yes |
| `APP_PASSWORD` | the password your team will type | yes |
| `SESSION_SECRET` | 32+ random bytes, see below | yes |
| `INGEST_TOKEN` | 16+ random bytes; needed only for the Gmail bridge | optional |
| `ANTHROPIC_API_KEY` | your Anthropic key | optional |
| `ANTHROPIC_MODEL` | defaults to `claude-sonnet-5` | optional |
| `SLOW_TASK_MULTIPLIER` | defaults to `1.5` | optional |
| `DATE_ORDER` | `DMY` or `MDY`, defaults to `DMY` | optional |

Generate the two secrets locally and paste them in — never type them into a
chat, an issue, or a commit:

```bash
node -e "console.log('SESSION_SECRET', require('crypto').randomBytes(32).toString('hex'))"
```

```bash
node -e "console.log('INGEST_TOKEN', require('crypto').randomBytes(16).toString('hex'))"
```

Redeploy so the new values are picked up:

```bash
npx vercel --prod
```

## STEP 6 — Seed the master data

From your machine, with the pooler string in your environment:

```bash
cd web && DATABASE_URL="<pooler string>" npm run seed
```

That inserts the six statuses, ~50 status aliases, ~80 header aliases, the
department list and the task categories. It is idempotent.

Add `-- --demo` to also insert the ten demo employees. **Do not** do that on a
production database you intend to use for real; add your own roster instead.

## STEP 7 — Verify the deployment

```bash
curl -s https://<your-app>.vercel.app/api/health
```

Expected:

```json
{"ok":true,"checks":{"database":"ok","tasks":"0",
 "appPassword":"configured","sessionSecret":"configured",
 "ingestToken":"configured","ai":"configured"}}
```

Then check the security boundary — these must all be `401`:

```bash
for p in preview commit rebuild report; do
  curl -s -o /dev/null -w "$p %{http_code}\n" -X POST \
    https://<your-app>.vercel.app/api/$p -H 'content-type: application/json' -d '{}'
done
```

And an unauthenticated page must redirect, not render:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://<your-app>.vercel.app/
```

Expected: `307 https://<your-app>.vercel.app/login?next=%2F`

## STEP 8 — First real import

1. Open the app, sign in with `APP_PASSWORD`.
2. **Submit report**, paste `sample-data/real-demo-email.html`, press **Preview**.
3. You should see 14 rows to import and 2 quarantined with reasons.
4. Press **Confirm import**, then check the Overview page.
5. Press **Confirm import** again — 0 written, 14 already present. That is the
   idempotency guarantee.

## STEP 9 — Connect Gmail (optional)

See [WEB_APP.md](WEB_APP.md) §8. In short: store the ingest token in the Apps
Script project, set `BRIDGE_ENABLED` and `BRIDGE_URL` on the Config sheet, and
run **Test bridge connection**.

---

## Costs, honestly

| Service | Free tier | What happens past it |
|---|---|---|
| Vercel Hobby | personal, non-commercial use | commercial use needs a paid plan |
| Supabase Free | 500 MB database, pauses after 7 days idle | paid plan, or keep it active |
| Anthropic | none — billed per call | leave `ANTHROPIC_API_KEY` unset and the system still works |

The Google Sheets version in `apps-script/` has none of these caveats. Keeping
both is deliberate: the Sheets version is the zero-cost guarantee, the web app
is the nicer experience.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every URL redirects to `vercel.com/sso-api` | Deployment Protection | Step 4b — dashboard toggle, no CLI equivalent |
| `DATABASE_URL is not set` | env var missing or set for the wrong environment | Vercel → Settings → Environment Variables, tick **Production**, redeploy |
| `too many connections` | using the direct 5432 string | switch to the pooler (6543) |
| `SESSION_SECRET is not set` | missing env var | add it; the app fails loudly rather than accepting forgeable sessions |
| Pages load without signing in | `middleware.ts` outside `src/` | it must be `src/middleware.ts`; `npm test` asserts this |
| `relation "tasks" does not exist` | schema not applied | re-run `supabase/schema.sql` in the SQL editor |
| Login always fails | `APP_PASSWORD` has a trailing space | re-paste it in Vercel |
| Bridge returns 401 | token mismatch | re-run **Store ingest token** in the Sheet with the exact `INGEST_TOKEN` |
| Supabase project paused | 7 days idle on the free tier | resume it from the dashboard |
