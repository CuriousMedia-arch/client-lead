# Connecting the portal to Google

You do this once. Budget 30 minutes. Nothing here needs code.

You will end up with four values to paste into the app's settings. That's the
whole goal — everything before that is getting Google to issue them.

---

## Before you start

You need to be signed in as a **Google Workspace admin on curiousmedia.in**.
Not a personal Gmail. If you sign in with a personal account, the most
important step (Internal) won't be available and the whole thing gets far more
expensive.

Quick check: go to [admin.google.com](https://admin.google.com). If it lets you
in, you're an admin. If it doesn't, get whoever manages the company's Google
accounts to do steps 1–5 with you.

---

## Step 1 — Make a project

A "project" is just a container for everything you're about to create.

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Top-left, click the project dropdown → **New Project**
3. Name it `Curious Lead Portal`
4. **Location** — this is the one that matters. It must say
   **curiousmedia.in**, not "No organisation".
5. Create

**If Location only offers "No organisation":** you're signed in with the wrong
account, or Workspace hasn't been linked to Google Cloud. Fix that before
continuing — carrying on will produce an app that costs money to verify and
shows your salespeople a scary "unverified app" warning.

---

## Step 2 — Switch on the three APIs

By default a project can't talk to anything. You turn on what you need.

Go to **APIs & Services → Library**, search for each of these and click
**Enable**:

- [ ] **Google Calendar API** — creating meetings and Meet links
- [ ] **Google Meet API** — reading the transcript after a call
- [ ] **Gmail API** — sending proposals and forwarding notes

Three separate searches, three Enable buttons. That's it.

---

## Step 3 — Internal. This is the important one.

**Google Auth platform → Audience** (older consoles call this the *OAuth
consent screen*).

Set **User type** to **Internal**.

Why this matters enough to have its own step: Internal means only
curiousmedia.in accounts can use the app. In exchange, Google skips its review
process entirely. External would mean weeks of waiting plus a paid third-party
security audit, repeated every year, for exactly the same features.

**If Internal is greyed out**, the project isn't inside the organisation. Go
back to Step 1.

Then under **Branding**, fill in:

- App name: `Curious Lead Portal`
- Support email: your address
- Developer contact: your address

Save. You do **not** need to list scopes, add test users, or submit anything
for review. That's the Internal payoff.

---

## Step 4 — Create the credentials

**APIs & Services → Credentials → Create Credentials → OAuth client ID**

- Application type: **Web application**
- Name: `Portal`
- Under **Authorised redirect URIs**, click ADD URI and add your live address
  with `/api/google/callback` on the end:

```
https://leads.curiousmedia.in/api/google/callback
```

If you also run the portal on your own machine, add that too:

```
http://localhost:4000/api/google/callback
```

Create. A box appears with a **Client ID** and a **Client secret**. Copy both
somewhere safe now — the secret is shown once.

**About that redirect URI:** it's where Google sends the person back after they
approve. It has to match what the app sends, character for character. `http` vs
`https`, a trailing slash, `www` — any difference and you get
`redirect_uri_mismatch`. That error always means this field, nothing else.

---

## Step 5 — Make one more secret

The app encrypts Google's tokens before storing them, so a leaked database
isn't a leaked set of mailboxes. It needs a key.

Run this anywhere (terminal, or any "random hex generator" online):

```bash
openssl rand -hex 32
```

Copy the long string. That's your `TOKEN_SECRET`.

---

## Step 6 — Paste the four values into the app

You now have:

| Setting | Where it came from |
|---|---|
| `GOOGLE_CLIENT_ID` | Step 4 |
| `GOOGLE_CLIENT_SECRET` | Step 4 |
| `GOOGLE_REDIRECT_URI` | Step 4 — the same URI, copied exactly |
| `TOKEN_SECRET` | Step 5 |

**On Render:** dashboard → your service → **Environment** → Add Environment
Variable, four times → Save. It redeploys itself.

**On Vercel:** project → **Settings → Environment Variables** → add four →
then **Deployments → Redeploy**. Vercel does *not* pick up new variables
without a redeploy, which catches people out.

**On your own machine:** add them to `.env` and restart.

---

## Step 7 — Turn on meeting transcripts

Without this, "Get notes from the call" finds nothing. Transcription is
off by default and relies on someone clicking a button in Meet during every
call, which nobody remembers.

[admin.google.com](https://admin.google.com) → **Apps → Google Workspace →
Google Meet → Gemini settings** (or *Meet video settings*, depending on your
edition) → turn on automatic transcripts.

**If you can't find it**, your Workspace plan probably doesn't include
transcripts — they need Business Standard or above. Everything else in the
portal still works; only automatic notes won't. You can still type notes by
hand, exactly as now.

---

## Step 8 — Try it

1. Open the portal, go to **My Outreach**, open any lead
2. Scroll to **Meetings**. You should see **Connect Google**
3. Click it → Google asks you to approve → you land back on the portal
4. Book a meeting a few minutes from now
5. Check your Google Calendar — the event should be there with a Meet link

If all of that works, you're done. Each salesperson does step 2–3 once for
their own account.

---

## When it goes wrong

**"Access blocked: this app is not verified"**
You're on External, not Internal. Go back to Step 3.

**`redirect_uri_mismatch`**
The URI in Step 4 doesn't exactly match `GOOGLE_REDIRECT_URI`. Compare them
character by character — it's nearly always a missing `s` in `https` or a
trailing slash.

**"Google did not return a refresh token"**
You approved this app before. Go to
[myaccount.google.com/permissions](https://myaccount.google.com/permissions),
remove "Curious Lead Portal", and connect again.

**Meeting saves but there's no Meet link**
Google isn't connected for that user, or Calendar API isn't enabled. The
meeting is never lost — it saves either way and tells you which it was.

**"Nobody switched transcription on during this call"**
Step 7 wasn't done, or the *client* hosted the call. Recordings belong to
whoever created the meeting, so your salesperson has to be the host. Booking
through the portal makes that automatic.

**"Google is still preparing the transcript"**
Normal. It can take up to about 45 minutes after a call ends. Try again later.

---

## Two things to be careful about

**The client secret and TOKEN_SECRET are passwords.** Don't put them in Slack,
don't commit them to GitHub, don't paste them in a doc. Environment variables
only. If one leaks, regenerate it in the console and update the app.

**Each person connects their own account.** The app never gets blanket access
to everyone's mail — it can only ever act as the specific person who clicked
Connect, and they can disconnect themselves at any time. That's deliberate; the
alternative would have given the portal the ability to read every mailbox in
the company, which is far more power than putting a link on a calendar needs.

---

## What you're not doing, and why

You may read about **CASA security assessments**, **OAuth verification**, or
**app review**. None of it applies here — that's all for apps used by people
outside your organisation. Internal apps are exempt. If someone tells you this
needs a security audit, they're describing the External path.

The trade-off: this only ever works for curiousmedia.in staff. If you later
want to sell the portal to another agency, that version needs External and all
of the above applies then. For an internal tool, Internal is the right choice.
