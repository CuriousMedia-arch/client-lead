# Your setup, in order

Google Meet links + Fathom notes. No Workspace, no admin, nothing to pay.

About 40 minutes. Do them in this order — each depends on the one before.

---

## 1 — Deploy the code (10 min)

Unzip over your project folder, overwrite everything, then:

```powershell
git add -A
git commit -m "Fathom notes, Google Meet links"
git push
```

**Then run the migrations** in Supabase → SQL Editor → New query.
Paste each, press Run, wait for "Success", next one:

- [ ] `db/migrate-outreach-6.sql`
- [ ] `db/migrate-outreach-7.sql`
- [ ] `db/migrate-outreach-8.sql`
- [ ] `db/migrate-outreach-9.sql`

(1–5 you've already run. Safe to re-run if unsure.)

---

## 1a — Trim the news watchlist (5 min) — do this before anything else

Admin tab → **News watchlist**.

This is the setting that costs money. The news provider charges **per company,
per sweep**, so an import of 4,000 companies means 4,000 paid searches every
three days — roughly **₹52,000/month**, mostly finding nothing.

The screen shows what you are currently watching and what it costs. Two bulk
buttons do most of the work:

- **Stop watching those with no news in 90 days** — the sweep finds nothing for
  these and charges the same
- **Stop watching unclaimed ones** — nobody is working them, so nobody reads
  the news about them

Then tick individual companies back on as you start working them.

Watching ~500 instead of 4,000 is about **₹5,000/month** instead of ₹52,000.

---

## 1b — Set this month's targets (2 min)

Admin → **Settings → This month's targets**. Type each salesperson's number
and save. Until you do, the target bar simply doesn't appear.

Targets are per person, per month, and only an admin can change them. Raising
someone's target now doesn't rewrite what they were measured against last month.

---

## 2 — Google, for the Meet links (15 min)

A **personal** Google account is fine. You do not need Workspace.

1. [console.cloud.google.com](https://console.cloud.google.com) → **New Project**
   → name it `Curious Lead Portal`. Location: "No organisation" is expected.
2. **APIs & Services → Library** → enable **Google Calendar API**.
   *(Skip Gmail and Meet APIs — you have no Gmail mailbox, and transcripts
   come from Fathom.)*
3. **OAuth consent screen** → **External** → fill in app name and your email
   → Save. Under **Test users**, add every `@curiousmedia.in` address that
   will book meetings. **Up to 100.**
4. **Credentials → Create Credentials → OAuth client ID → Web application**.
   Authorised redirect URI:
   ```
   https://leads.curiousmedia.in/api/google/callback
   ```
5. Copy the **Client ID** and **Client secret**.

---

## 3 — Fathom, for the notes (10 min)

1. [fathom.video](https://fathom.video) → sign up → **connect your calendar**
   (that's how the bot knows to join)
2. **Settings → Integrations → API** → create a key, copy it
3. **Settings → Integrations → Webhooks** → add one:
   - Event: **New meeting content ready**
   - URL: `https://leads.curiousmedia.in/api/fathom/webhook`
   - Tick **Include transcript**
4. Copy the **webhook secret**

---

## 4 — Put it all in Vercel (5 min)

**Settings → Environment Variables.** Add five, then **redeploy** — Vercel
ignores new variables until you do.

| Name | From |
|---|---|
| `GOOGLE_CLIENT_ID` | step 2 |
| `GOOGLE_CLIENT_SECRET` | step 2 |
| `GOOGLE_REDIRECT_URI` | `https://leads.curiousmedia.in/api/google/callback` |
| `FATHOM_API_KEY` | step 3 |
| `FATHOM_WEBHOOK_SECRET` | step 3 |

`TOKEN_SECRET` should already be set. If not, add any long random string.

---

## 5 — Test it (10 min)

1. Portal → **My Outreach** → open a lead → **Meetings** tab
2. **Connect Google** → approve → you land back on the portal
3. Book a meeting a few minutes out
4. Check Google Calendar — invite there, with a Meet link
5. Join it, talk for a minute, end the call
6. Wait ~5 minutes, reopen the lead → notes should be there

If they aren't, press **Get notes from the call** — it asks Fathom directly
and tells you what it found.

---

## What works, and what doesn't

| | |
|---|---|
| Meet link from the portal | ✅ |
| Fathom records and transcribes | ✅ |
| Notes written into the lead | ✅ |
| Send proposals / notes by email | ❌ — no Gmail mailbox. Copy-paste. |

Email sending needs Microsoft. When your admin is ready, `MICROSOFT-SETUP.md`
turns it on and also gives free transcripts, at which point Fathom becomes a
backup rather than the main route.

---

## Two things to decide later

**Weekly reconnects.** Because the Google app is External and unverified,
everyone reconnects every 7 days. To stop that, publish the app and go through
Google's verification — free, needs a privacy policy page, takes 1–2 weeks.
Not urgent.

**Who writes the summary.** Settings → *Wording and templates* → **Who writes
the meeting summary**:

- `fathom` — Fathom's own. Free plan allows **5 a month**, then needs Premium
  (~₹1,400/host/month).
- `portal` — this app writes them from the transcript. Free, unlimited, and
  they know the company, the service and the price you quoted.

Currently set to `fathom`. Change the word, save, done — no deploy.

Either way the structured fields your reports read — what they need, budget,
timeline, objections, next step — are filled in automatically.

---

## If it goes wrong

**"Access blocked: app not verified"** — add that address under Test users
(step 2.3).

**`redirect_uri_mismatch`** — the URI in Google and `GOOGLE_REDIRECT_URI`
differ. Compare character by character.

**No notes after a meeting** — check the webhook URL, confirm you redeployed
after adding the variables, then press **Get notes from the call**.

**Vercel log says "rejected a webhook: Signature did not match"** —
`FATHOM_WEBHOOK_SECRET` doesn't match Fathom's. Copy it again.

**Notes on the wrong lead** — that's a bug, not a setting. Send me the
recording ID from the Vercel log.
