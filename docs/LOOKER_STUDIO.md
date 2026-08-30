# Connecting Looker Studio (or Power BI, or Metabase)

Looker Studio is free. Only Looker Studio **Pro** is paid, and nothing here
needs it. If you want to build your own charts on top of this data, you can —
the application and the BI tool read the same database, so they cannot drift
apart.

## What the application already does

Charts, filters, the management summary, data-quality explanations and the
attention list are built in. You do not need a BI tool to use the product.

## What a BI tool adds

- Charts you build yourself, by dragging fields, without asking anybody
- Chart types the application does not have
- Scheduled PDF delivery by email
- Sharing a read-only dashboard with people who have no login here

## What it does not add

It reads. It cannot ingest mail, understand a column nobody named, tell a
report from a newsletter, or explain why a row was refused — that is the part
of this product that is hard, and it stays where it is.

## Connecting

Looker Studio connects to PostgreSQL directly.

1. In Supabase, click the green **Connect** button at the top of the project
   page — the sidebar no longer has a Database entry. Choose the **Session
   pooler** tab.

   Use the session pooler, not the direct connection: direct is IPv6-only on
   the free plan and Looker Studio connects over IPv4, so it times out with no
   useful error. Host looks like `aws-0-<region>.pooler.supabase.com`, port
   `5432`.
2. Create a read-only user first. In the Supabase SQL editor:

   ```sql
   create role bi_reader with login password 'choose-a-strong-password';
   grant connect on database postgres to bi_reader;
   grant usage on schema public to bi_reader;
   grant select on bi_tasks, bi_daily_by_department, bi_messages to bi_reader;
   ```

   Grant only the three `bi_` views. A BI tool has no business reading
   `gmail_accounts`, which holds your encrypted Google token.

3. In Looker Studio: **Create → Data source → PostgreSQL**, enter the host,
   port `5432`, database `postgres`, and the password you chose.

   The username through the pooler is `bi_reader.<project-id>` — the role name,
   a full stop, then the Project ID from Project Settings → General. Plain
   `bi_reader` fails against the pooler. Tick **Enable SSL**.
4. Pick a view:

   | View | One row per | Use it for |
   |---|---|---|
   | `bi_tasks` | task | anything — dates are pre-bucketed by week and month |
   | `bi_daily_by_department` | day × department | time series and department comparison |
   | `bi_messages` | message | coverage, and what was ignored |

5. **Add a filter on `owner_user_id`.** A BI tool does not know what a tenant
   is, and without the filter a shared deployment shows everybody's data.

## Rules the views already apply

Do not re-derive these, or your charts will disagree with the application:

- **`counted`** — excludes work planned for tomorrow and rows whose status
  named two states at once. This is the denominator.
- **`completed`** — completed *and* counted. This is the numerator.
- **`open_work`** — pending, in progress or blocked, excluding plans.

A completion rate is `sum(completed) / sum(counted)`. Using `count(*)` instead
will include planned work and overstate what was left undone.

## Refresh

Looker Studio caches for 12 hours by default. Set the data source's freshness
to 1 hour if you want it closer to live. The application's own dashboard is
never cached — it reads the database on every request.
