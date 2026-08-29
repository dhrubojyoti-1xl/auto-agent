# auto-agent web

Hosted dashboard over the same tested reporting engine as `../apps-script/`.

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL, APP_PASSWORD, SESSION_SECRET
createdb autoagent_dev
DATABASE_URL=postgres://localhost/autoagent_dev npm run seed -- --demo
npm run dev                    # http://localhost:3210
```

```bash
npm test          # 59 tests: engine parity with Apps Script + auth
createdb autoagent_test
TEST_DATABASE_URL=postgres://localhost/autoagent_test npm test   # + 13 database tests
```

- Architecture, security model and design decisions: [../docs/WEB_APP.md](../docs/WEB_APP.md)
- Deploying to Supabase + Vercel: [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md)

No secrets live in this directory. `.env.local` is gitignored; production values
belong in the Vercel dashboard.
