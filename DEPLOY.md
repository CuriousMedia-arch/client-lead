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
