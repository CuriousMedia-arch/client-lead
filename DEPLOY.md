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
