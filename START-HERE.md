# Start here

Everything you need to do, in the order to do it. Nothing here needs code.

Roughly 90 minutes end to end. You can stop after Part 3 and have a working
portal on Vercel — Parts 4 and 5 add Google Meet and the background sweeps.

**Keep Render running until Part 6.** If something is wrong you want somewhere
to fall back to.

---

## Part 0 — Get the code in (10 min)

This zip is the complete project. Two ways to use it:

**If you already have the repo on your machine:** unzip this over the top of
it, overwriting when asked. Then commit and push.

```bash
git add -A
git commit -m "Vercel-ready: sliced import, Google Meet, background sweeps"
git push
```

**If you're starting fresh:** unzip it, then

```bash
cd curious-lead-intelligence
npm install
```

Two things are deliberately **not** in the zip:

- `node_modules` — `npm install` recreates it
- `.env` — it holds live passwords. There's `.env.example` instead; copy it to
  `.env` and fill it in from your Render dashboard.

---

## Part 1 — Run the database migrations (10 min)

**This has to happen before you deploy.** The new code reads tables that don't
exist yet; deploying first means a broken portal until you catch up.

Supabase → your project → **SQL Editor** → **New query**. Paste each file,
press Run, wait for "Success", then move to the next. **In this order:**

- [ ] `db/migrate-outreach.sql`
- [ ] `db/migrate-outreach-2.sql`
- [ ] `db/migrate-outreach-3.sql`
- [ ] `db/migrate-outreach-4.sql`
- [ ] `db/migrate-outreach-5.sql`

All five are safe to run twice. If you're unsure whether one was already
applied, run it again — that's cheaper than guessing.

**If one errors**, stop and send me the message. Don't skip it and carry on;
the later ones build on the earlier ones.

---

## Part 2 — Deploy to Vercel (20 min)

### 2a. Import the project

1. [vercel.com/new](https://vercel.com/new) → import your GitHub repo
2. **Framework Preset: Other**
3. **Build Command: leave empty**
4. **Output Directory: leave empty**
5. Don't deploy yet — add the variables first (next step), or the first
   deploy fails and confuses you

`vercel.json` already handles the routing, so there's nothing to configure.

### 2b. Environment variables

**Settings → Environment Variables.** Copy each of these across from Render.
Tick all three environments (Production, Preview, Development).

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Render — **must be the pooler string, port 6543** |
| `NEWSAPI_AI_KEY` | Render |
| `GEMINI_API_KEY` | Render |
| `GEMINI_MODEL` | Render (or `gemini-2.0-flash`) |
| `TZ_NAME` | `Asia/Kolkata` |
| `SECURE_COOKIES` | `true` |
| `CLAIM_DAYS_FRESH` | Render (or `10`) |
| `CLAIM_DAYS_ALL` | Render (or `30`) |
| `FRESH_WINDOW_DAYS` | Render (or `14`) |

**On `DATABASE_URL`:** it has to be the pooler string on port **6543**, not the
direct 5432 one. Serverless opens a fresh connection on every cold start, and
a direct connection will run Postgres out of connections within a day. If
you're unsure which you have, Supabase → Connect → *Connection pooling*.

Two more you'll generate. Run this twice, once for each:

```bash
openssl rand -hex 32
```

| Variable | What it's for |
|---|---|
| `CRON_SECRET` | Lets GitHub Actions trigger the lead sweeps |
| `TOKEN_SECRET` | Encrypts Google tokens before they're stored |

(No terminal? Any "random hex generator" site works. It just needs to be long
and random.)

### 2c. Deploy

Hit **Deploy**. When it finishes, open the URL and sign in.

**Check:** you can sign in, and All Leads shows your companies. If it does, the
database, the migrations and the deployment are all good.

---

## Part 3 — Point your domain at it (10 min)

**Settings → Domains** → add `leads.curiousmedia.in` → follow the DNS
instructions.

Then **redeploy**. Vercel does not pick up environment variable changes without
one, which catches everybody out at least once.

---

## Part 4 — Google Meet, Calendar and email (30 min)

Full walkthrough with screenshots-worth of detail: **`GOOGLE-SETUP.md`**.

The short version, so you know what's coming:

1. Google Cloud project — **inside the curiousmedia.in organisation**
2. Enable three APIs: Calendar, Meet, Gmail
3. Consent screen → **Internal** (this is the step that matters — it skips
   Google's review and an annual paid security audit)
4. Create an OAuth client, redirect URI:
   `https://leads.curiousmedia.in/api/google/callback`
5. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` to
   Vercel → **redeploy**
6. Admin console → turn on **automatic meeting transcripts** for the
   organisation

**Step 6 matters more than it looks.** Without it, transcription is a button
someone has to remember to press during every call — so "Get notes from the
call" finds nothing most of the time.

**Two limits worth knowing before you promise this to anyone:**

- Meeting recordings belong to whoever **created** the meeting. If the client
  hosts the call, there's nothing to fetch. Booking through the portal makes
  your person the host automatically.
- Transcripts need Workspace **Business Standard or above**. On a lower plan,
  everything else still works — only automatic notes won't.

Skip this part entirely if you like. The portal works without it; meetings just
save without a Meet link and notes get typed by hand.

---

## Part 5 — Background sweeps (10 min)

This is what releases overdue leads when nobody is logged in. Without it, a
lead due back on Saturday sits claimed until Monday.

GitHub → your repo → **Settings → Secrets and variables → Actions** → add:

| Secret | Value |
|---|---|
| `APP_URL` | `https://leads.curiousmedia.in` |
| `CRON_SECRET` | the same string you put in Vercel |

Then: **Actions** tab → **Release overdue leads** → **Run workflow**.

**Check:** the run goes green and prints something like
`{"leads":{"released":0,...}}`. A 401 means the two `CRON_SECRET` values don't
match.

While you're there, the existing **Lead scan** workflow needs the same
`APP_URL` update if it references the old Render address.

---

## Part 6 — Verify, then turn Render off

Work through these on the live Vercel URL:

- [ ] Sign in
- [ ] All Leads shows companies and their contacts
- [ ] **Import a contact sheet.** It counts through parts — "Uploading part 2
      of 4". That's expected, and it's how a 7 MB sheet gets past Vercel's
      4.5 MB request limit.
- [ ] My Outreach → open a lead → it suggests what to sell
- [ ] Generate a message (this is the one most likely to time out — see below)
- [ ] Book a meeting; if Google is connected, check your calendar for the invite
- [ ] Admin → Settings → Pricing loads

All good? **Now** suspend the Render service.

---

## The one thing I'd flag

**Vercel's Hobby plan gives a function 10 seconds.** Writing a pitch, drafting a
proposal and larger import slices all take longer than that on a slow day. The
config asks for 60 seconds, which Pro honours and Hobby ignores.

Nothing corrupts when a function times out — the work is either done or not
done, never half-written. But people will see errors. If you're staying on
Hobby, tell me and I'll make the slow operations run in the background instead
of making someone wait.

---

## Things that will go wrong, and what they mean

**"Something broke on our side"** right after deploying
A migration was missed. Go back to Part 1 and run all five.

**Sign-in works, then immediately signs you out**
`SECURE_COOKIES` isn't set to `true`. Vercel is always HTTPS.

**`redirect_uri_mismatch` when connecting Google**
The URI in Google Cloud and `GOOGLE_REDIRECT_URI` don't match exactly. Compare
character by character — it's nearly always a missing `s` in `https` or a
trailing slash.

**Import says "that file is 7.3 MB and the limit is..."**
Shouldn't happen any more — the browser slices automatically. If it does, the
new `public/app.js` didn't deploy. Hard-refresh, then check the deployment.

**Database connection errors after a day or two**
`DATABASE_URL` is the direct connection, not the pooler. Switch it to port
6543 and redeploy.

**Sweeps never run**
`CRON_SECRET` differs between Vercel and the GitHub secret, or `APP_URL` still
points at Render.

---

## Where everything is documented

| File | What's in it |
|---|---|
| `START-HERE.md` | this |
| `GOOGLE-SETUP.md` | the Google Cloud walkthrough, in detail |
| `DEPLOY.md` | full deploy checklist and the Render → Vercel notes |
| `README.md` | how the portal works and why it's built the way it is |
| `.env.example` | every setting, with a note on what each one does |

---

## What I still need from you

Nothing blocking, but these are the empty slots:

- **Pushpraj's content** — Admin → Settings → *Wording and templates*: the
  AI's house rules, the proposal email, the deck link, four follow-up messages.
  The portal works without them and falls back to generated wording.
- **Real prices** — Admin → Settings → *Packages and prices*. What's in there
  now is placeholder numbers so the screens render.
- **The credit system** — not built. That was the Tuesday agenda.
