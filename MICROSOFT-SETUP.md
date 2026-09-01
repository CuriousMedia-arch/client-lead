# Connecting the portal to Microsoft 365

You already pay for this. Teams gives meeting links and transcripts, Outlook
sends the mail — no Google Workspace, no notetaker subscription.

Two people are involved: **you**, and **whoever administers your Microsoft
tenant**. Steps 1–3 need admin rights. Send them this file if it's easier.

---

## What you get

- Booking a meeting in the portal creates the Outlook invite, generates a
  **Teams link**, and emails the attendees
- After the call, **Get notes from the call** pulls the Teams transcript and
  turns it into structured notes
- Proposals and notes send **from your own Outlook address**, so replies come
  back to you

---

## Step 1 — Register the app *(admin)*

1. [entra.microsoft.com](https://entra.microsoft.com) → **App registrations** →
   **New registration**
2. Name: `Curious Lead Portal`
3. Supported account types: **Accounts in this organizational directory only**
4. Redirect URI: platform **Web**, value:
   ```
   https://leads.curiousmedia.in/api/microsoft/callback
   ```
5. Register

From the Overview page, copy two values:

- **Application (client) ID**
- **Directory (tenant) ID**

---

## Step 2 — Create a client secret *(admin)*

**Certificates & secrets** → **New client secret** → 24 months → Add.

Copy the **Value** column, not Secret ID. It is shown once and never again.

---

## Step 3 — Permissions *(admin)*

**API permissions** → **Add a permission** → **Microsoft Graph** →
**Delegated permissions**. Add all six:

- [ ] `offline_access`
- [ ] `User.Read`
- [ ] `Calendars.ReadWrite`
- [ ] `OnlineMeetings.ReadWrite`
- [ ] `OnlineMeetingTranscript.Read.All`
- [ ] `Mail.Send`

Then **Grant admin consent** and confirm every row says *Granted*.

**Delegated, not Application.** Delegated means the portal acts as the person
who signed in and can only ever see their own meetings and send as themselves.
Application permissions would let it read every meeting in the company — far
more power than this needs, and not something to hold by accident.

---

## Step 4 — Turn on transcript API access *(admin)*

**This one is easy to miss and nothing works without it.** Microsoft added a
tenant-wide switch, enforced from 29 July 2026, and it is **off by default**.
With it off, transcript requests fail no matter how the permissions are set.

1. [admin.teams.microsoft.com](https://admin.teams.microsoft.com)
2. **Meetings → Meeting settings**
3. Under **Transcript API access**, turn **Microsoft Graph access** → **On**
4. Select **Configure** and turn **Include speaker attribution** → **On**
   (without it, notes can't tell who said what)

While there, check **Meetings → Meeting policies** has **Transcription**
turned on, otherwise there is no transcript to fetch in the first place.

---

## Step 5 — Add four settings to Vercel *(you)*

**Settings → Environment Variables**, then **redeploy** — Vercel does not pick
up new variables without one.

| Name | Value |
|---|---|
| `MS_CLIENT_ID` | Application (client) ID, from Step 1 |
| `MS_CLIENT_SECRET` | the secret **Value**, from Step 2 |
| `MS_TENANT_ID` | Directory (tenant) ID, from Step 1 |
| `MS_REDIRECT_URI` | `https://leads.curiousmedia.in/api/microsoft/callback` |

`TOKEN_SECRET` should already be set from the earlier setup. If not, generate
one and add it — it encrypts the stored tokens.

---

## Checking it worked, at any point

Two ways, same checks. Both walk the whole chain and stop at the first broken
link, naming the console that fixes it.

**In the portal:** My Outreach → any lead → **Meetings** tab →
**Check what's missing**.

**From a terminal:**

```bash
node scripts/checkMicrosoft.js        # just the four settings
node scripts/checkMicrosoft.js 1      # the full chain, as user 1
```

Output looks like this:

```
  ok   Credentials are set on the server
  ok   Redirect URI looks right
  ok   You have connected your Microsoft account
  ok   Microsoft accepts the credentials
  ok   Can read your profile (User.Read)
  ok   Can create calendar invites (Calendars.ReadWrite)
 FAIL  Transcript access is switched on
       → Teams admin centre → Meetings → Meeting settings → Transcript API
         access → turn Microsoft Graph access ON
```

That last line is the message to forward to whoever administers the tenant.
It never prints the client secret, so it is safe to paste into a chat.

---

## Step 6 — Connect and test *(you)*

1. My Outreach → open any lead → **Meetings** tab
2. **Connect Microsoft** → approve → you land back on the portal
3. Book a meeting a few minutes out
4. Check Outlook: the invite should be there with a Teams link
5. Join it, say a few words with transcription running, end the call
6. Wait a few minutes, then **Get notes from the call**

Each salesperson does steps 1–2 once for their own account.

---

## When it goes wrong

**"Microsoft is blocking transcript access for your whole organisation"**
Step 4 wasn't done, or hasn't propagated. It can take up to 30 minutes.

**"Nobody switched transcription on during this call"**
Transcription wasn't running. Turn it on in Meeting policies so it starts
automatically, or press *Start transcript* during the call.

**`AADSTS50011: redirect URI mismatch`**
The URI in Step 1 and `MS_REDIRECT_URI` don't match exactly. Compare character
by character — usually a missing `s` in `https` or a trailing slash.

**"Microsoft did not return a refresh token"**
`offline_access` is missing from Step 3.

**Meeting saves but no Teams link**
Microsoft isn't connected for that user, or `Calendars.ReadWrite` wasn't
granted. The meeting is never lost — it saves either way and says which
happened.

**Nothing happens when you click Connect Microsoft**
The four variables in Step 5 aren't set, or the deploy hasn't been redone
since adding them.

---

## Notes

- **Transcripts are not instant.** A few minutes after the call is normal.
- **The organiser owns the transcript.** Your salesperson must host the call —
  booking through the portal makes that automatic.
- **Tokens are encrypted at rest** with `TOKEN_SECRET`, and each person
  connects their own account and can disconnect it themselves.
- **Google still works.** If someone connects a Google account instead, the
  portal uses it. If both, Microsoft wins — it's where the mail and calendar
  actually live.
