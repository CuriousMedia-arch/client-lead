# Deploy checklist

Work top to bottom. Each step has a way to check it worked before moving on.

---

## 1. Supabase — the database

- [ ] Project created in **ap-south-1 (Mumbai)**
- [ ] Database password saved somewhere, alphanumeric only
- [ ] Connection string copied from **Connect → Connection pooling**, port **6543**

**Check:** the string looks like
`postgresql://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`
— no `[` `]` around the password, and nothing after `/postgres`.

---

## 2. Local — prove it works before deploying

```bash
npm install
```

`.env` needs at minimum:

```
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
NEWSAPI_AI_KEY=...
GEMINI_API_KEY=...
PORT=4000
```

Then:

```bash
npm run setup     # creates tables, seeds the watchlist, makes your admin login
npm start
```

**Check:** http://localhost:4000 — you can sign in, and the dashboard shows
7 leads with 0 signals.

If setup can't create the tables, paste `db/schema.postgres.sql` into the
Supabase SQL editor and run it there, then run `npm run setup` again.

---

## 3. First scan

Admin tab → **Run a cycle now**. Takes a few minutes.

**Check:** leads pick up signals and scores. If Fresh Leads fills up too,
Gemini is working. If it stays empty, the Gemini key is wrong — the watchlist
sweep still works without it.

---

## 4. GitHub

```bash
git init
git add .
git commit -m "Lead intelligence portal"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

**Check:** `.env` is NOT in the repo. `.gitignore` covers it — confirm on GitHub
that you don't see it in the file list.

---

## 5. Render

1. Render → **New** → **Blueprint** → select the repo
2. It reads `render.yaml` and asks for three values:
   - `DATABASE_URL`
   - `NEWSAPI_AI_KEY`
   - `GEMINI_API_KEY`
3. Deploy

**Check:** open `https://<your-app>.onrender.com/api/health` — it should return
`{"ok":true,"users":1}`. If that works, sign in at the root URL.

---

## 6. Scheduled scans

GitHub repo → **Settings** → **Secrets and variables** → **Actions** → add:

- `DATABASE_URL`
- `NEWSAPI_AI_KEY`
- `GEMINI_API_KEY`

**Check:** Actions tab → **Lead scan** → **Run workflow**. It should go green and
new signals should appear in the portal afterwards.

This runs on GitHub's servers, so it works even when Render has the free
instance asleep.

---

## 7. Team access

Sign in → **Admin** → **Team** → add each person with a username, display name
and password. Hand them the URL and their credentials.

**Before sharing widely:** change any placeholder passwords. Anyone with the URL
can reach the login page.

---

## Releasing overdue leads on time

Claim clocks are checked whenever someone loads a page, so what a person is
looking at is never stale. But that alone means a lead due back on Saturday
sits claimed until somebody opens the portal on Monday. Something has to tick
the clocks when nobody is logged in.

**Which mechanism you need depends on where this runs.**

### Render (or a plain Node host)

`services/scheduler.js` runs an in-process timer every 15 minutes. Nothing to
set up — but note that on Render's **free** plan an idle instance sleeps, and a
sleeping instance runs no timer. Either move to a paid plan, or set up the
GitHub Action below, whose request also wakes the instance.

### Vercel

There is no always-on process for a timer to live in, and Vercel Cron on the
Hobby plan allows only one run a day. `vercel.json` includes an hourly cron
entry which works on Pro; on Hobby, use the GitHub Action.

### GitHub Action (works on any host)

`.github/workflows/sweep.yml` calls `/api/cron/sweep` every 15 minutes.

- [ ] Set `CRON_SECRET` on the app to a long random string
      (`openssl rand -hex 32`). On Render this is generated for you by
      `render.yaml`; copy the value out of the dashboard.
- [ ] Add two **repository secrets** under
      *Settings → Secrets and variables → Actions*:
      - `APP_URL` — e.g. `https://leads.curiousmedia.in`
      - `CRON_SECRET` — the same string
- [ ] Actions tab → **Release overdue leads** → *Run workflow* to test it.

**Check:** the run should be green and print a line like
`{"leads":{"released":0,"toNewspaper":0},"contacts":0,"silent":0}`.
A 401 means the two `CRON_SECRET` values don't match. If `CRON_SECRET` is unset
on the app the endpoint refuses everything rather than running open — an
unauthenticated route that releases other people's leads is not something to
leave on by accident.

Running the sweep twice at once is harmless: each query only selects rows that
are genuinely overdue and then makes them not-overdue.

---

## Moving from Render to Vercel

Read the limits first — two of them shape the app, not just the config.

### What is fixed, and what is not

| | Vercel | Notes |
|---|---|---|
| Request body | **4.5 MB, hard** | Infrastructure-level. `maxDuration` and `memory` are configurable in `vercel.json`; this is not. |
| Function timeout | 10s Hobby, up to 300s Pro | `vercel.json` sets 60s. On Hobby it is capped lower regardless. |
| Always-on process | None | An in-process cron never fires. |

The body cap is why the browser now sends contact sheets **in slices**
(`importInSlices` in `public/app.js`). A 7 MB export cannot reach a Vercel
function in one request under any configuration. Slices are safe to retry —
the importer upserts, so a repeated part tops the same people up.

**Pro is effectively required.** On Hobby, a 10-second ceiling will time out
AI pitch generation, proposal drafting and larger import slices. Everything is
built to survive a timeout without corrupting data, but the experience is poor.

### Checklist

- [ ] Import the repo at [vercel.com/new](https://vercel.com/new)
- [ ] Framework preset: **Other**. Build command: leave empty. `vercel.json`
      already routes `api/index.js` and serves `public/` from the CDN.
- [ ] Copy every environment variable across from Render:
      `DATABASE_URL`, `NEWSAPI_AI_KEY`, `GEMINI_API_KEY`, `SESSION_SECRET`,
      `CRON_SECRET`, `TZ_NAME`, and the Google four if set
      (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
      `TOKEN_SECRET`)
- [ ] `DATABASE_URL` must be the Supabase **pooler** string, port 6543. A
      direct connection will exhaust Postgres connections under serverless,
      where each cold start opens its own.
- [ ] Deploy, then point your domain at it
- [ ] **Update `GOOGLE_REDIRECT_URI`** and the matching Authorised redirect URI
      in Google Cloud to the new domain, or Google sign-in breaks with
      `redirect_uri_mismatch`
- [ ] Update the `APP_URL` repository secret so the GitHub Actions sweep hits
      the new deployment
- [ ] Turn the Render service off only after all of the above is verified

### After the move — check these specifically

- [ ] Import a contact sheet. Watch it count through the parts.
- [ ] Book a meeting (Google Meet link appears)
- [ ] Generate a pitch (this is the one most likely to hit a timeout)
- [ ] Actions tab → *Release overdue leads* → Run workflow → green

### What does not change

The lead scan already runs on GitHub Actions and writes straight to Supabase,
so it is unaffected. `services/scheduler.js` detects `VERCEL` and skips
registering in-process timers.
