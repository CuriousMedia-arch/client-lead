# Connecting Fathom for meeting notes

Fathom's bot joins your call and records it. That's why it works on a free
Google account, on Zoom, on Teams — anything. **No Google Workspace, no admin
permissions, nothing to buy.**

About 15 minutes.

---

## What you get

Book a meeting in the portal → it creates the Google Calendar invite with a
Meet link → Fathom's bot joins and records → the transcript comes back
automatically → **your portal writes the notes**, in the lead's record, in the
fields your reporting reads.

**The summary comes from Fathom**, which is what you asked for. Worth knowing
what that costs: the free plan gives unlimited recording and transcription, but
caps *advanced AI summaries* at **five a month**. Past that you get a basic
chronological template. So if you want Fathom's summaries on every meeting,
whoever hosts needs **Premium — about $16/user/month**.

Only meeting hosts need it. Four salespeople is roughly ₹5,600/month.

**You can switch to the portal writing them instead**, free, at any time:
Settings → *Wording and templates* → **Who writes the meeting summary** → type
`portal`. No deploy needed.

**Either way the structured fields are filled in automatically** — what they
need, budget mentioned, timeline, objections, next step. Those are read by the
funnel report and the loss reasons, and Fathom returns prose, so the portal
always extracts them from the transcript. That costs nothing extra.

---

## Step 1 — Sign up and connect your calendar

1. [fathom.video](https://fathom.video) → sign up with the Google account you
   use for meetings
2. Connect your calendar when it asks — that's how the bot knows to join

**Check:** book a test meeting in your calendar. Fathom should list it as
upcoming.

---

## Step 2 — Get an API key

Fathom → **Settings → Integrations → API** → create a key. Copy it.

API access is on every plan including free, with no per-call charges.

---

## Step 3 — Add the webhook

Fathom → **Settings → Integrations → Webhooks** → add one:

- Event: **New meeting content ready**
- Destination URL:
  ```
  https://leads.curiousmedia.in/api/fathom/webhook
  ```
- Tick **Include transcript**
- Tick **Include summary** and **Include action items**
  (the summary is what appears in the notes box; the transcript is what the
  structured fields are read from, so both are needed)

Copy the **webhook secret** it gives you.

---

## Step 4 — Add two settings to Vercel

**Settings → Environment Variables**, then **redeploy** (Vercel doesn't pick
up new variables without one).

| Name | Value |
|---|---|
| `FATHOM_API_KEY` | from Step 2 |
| `FATHOM_WEBHOOK_SECRET` | from Step 3 |

---

## Step 5 — Test it

1. Book a meeting through the portal, a few minutes out
2. Join it, say a few sentences, end it
3. Wait ~5 minutes for Fathom to process
4. Open the lead → **Meetings** tab — the notes should be there

If they aren't, press **Get notes from the call**. That asks Fathom directly
rather than waiting for the webhook, and it will tell you what it found.

---

## How a recording finds the right lead

Three ways, in order of certainty:

1. **The meeting link matches** — unambiguous, when Fathom includes it
2. **A calendar invitee's email matches the contact**, and the times are close
   — this is the one that usually fires
3. **The time alone**, but only when exactly one meeting is a candidate

It deliberately refuses to guess between two. Attaching a client's transcript
to the wrong company would be far worse than leaving it unattached.

**Recordings that match nothing are kept, not discarded.** Most are internal
calls, which is fine — but a *client* meeting landing there means the matching
is wrong, and you'd want to see it. `GET /api/fathom/unmatched` lists them.

---

## When it goes wrong

**Nothing arrives after a meeting**
Check the webhook URL in Step 3 is exactly right and the deploy has happened
since you added the variables. Then press **Get notes from the call** — it
bypasses the webhook and reports what it found.

**Vercel logs say "rejected a webhook: Signature did not match"**
`FATHOM_WEBHOOK_SECRET` doesn't match the secret Fathom shows. Copy it again.

**"Neither the meeting platform nor Fathom has a recording of this call"**
The bot didn't join. Check Fathom shows the meeting on its calendar, and that
it wasn't blocked from the waiting room.

**Notes are attached to the wrong lead**
Report it — that's a matching bug, not a setting. The recording ID from the
Vercel logs is enough for me to trace it.

---

## One thing to tell your clients

The bot is **visible**. It appears as a participant with your Fathom bot's
name. Under India's DPDP Act you should be telling people you're recording —
a line at the start of the call is normal practice and takes five seconds.
