-- ---------------------------------------------------------------------------
-- Migration: Google Meet, execution plans, editable templates.
--
-- Run after migrate-outreach-4.sql. Safe to re-run.
-- ---------------------------------------------------------------------------

-- --- 1. connected Google accounts -------------------------------------------
-- One row per salesperson who has connected their own Google account.
--
-- Deliberately per-user rather than one domain-wide service account: a service
-- account with domain delegation could read every mailbox in the company,
-- which is a far larger blast radius than "put a Meet link on my own meeting"
-- needs. Each person connects their own and can disconnect it themselves.
create table if not exists google_accounts (
  user_id       bigint primary key references users(id) on delete cascade,
  email         text,
  -- Encrypted at rest by lib/google.js. If this table ever leaks, plaintext
  -- refresh tokens would be equivalent to handing over the mailboxes.
  refresh_token text not null,
  scopes        text,
  connected_at  timestamptz not null default now(),
  last_used_at  timestamptz,
  last_error    text
);

alter table google_accounts enable row level security;

-- --- 2. Meet fields on meetings ---------------------------------------------
alter table opportunity_meetings add column if not exists calendar_event_id text;
alter table opportunity_meetings add column if not exists meet_link         text;
alter table opportunity_meetings add column if not exists conference_record text;
alter table opportunity_meetings add column if not exists transcript_state  text;
-- pending | ready | none | error
alter table opportunity_meetings add column if not exists transcript_text   text;
alter table opportunity_meetings add column if not exists notes_generated_at timestamptz;
alter table opportunity_meetings add column if not exists notes_sent_at     timestamptz;
alter table opportunity_meetings add column if not exists notes_sent_to     text;

create index if not exists idx_meet_event on opportunity_meetings (calendar_event_id)
  where calendar_event_id is not null;

-- --- 3. execution plan ------------------------------------------------------
-- What we actually deliver once it's won: one row per deliverable, with a date
-- and a named owner. Kept separate from the package because a package is what
-- was sold and this is what was promised — they drift, and the drift is the
-- thing worth being able to see.
create table if not exists opportunity_execution (
  id             bigint generated always as identity primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  deliverable    text not null,
  owner_name     text,
  owner_id       bigint references users(id) on delete set null,
  due_date       date,
  status         text not null default 'pending',
  -- pending | in_progress | done | blocked
  notes          text,
  sort           integer not null default 0,
  created_by     bigint references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_exec_opp on opportunity_execution (opportunity_id, sort, due_date);

alter table opportunity_execution enable row level security;

-- --- 4. editable content templates ------------------------------------------
-- Everything a human supplies rather than the code: the guidance the AI
-- recommender reads, the proposal email wording, the deck link, and the four
-- follow-up messages. In the database so they can be changed without a deploy.
create table if not exists content_templates (
  key        text primary key,
  label      text not null,
  body       text,
  hint       text,
  sort       integer not null default 0,
  updated_by bigint references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table content_templates enable row level security;

insert into content_templates (key, label, hint, sort, body) values
  ('service_guidance', 'AI service recommender — guidance',
   'What the AI should know when deciding which service to pitch. Which services suit which kind of brand, what disqualifies one, house rules.',
   1, ''),
  ('proposal_email', 'Proposal & packages — email template',
   'The covering email sent with a proposal. Use {{company}}, {{contact}}, {{service}}, {{package}}, {{price}}, {{sender}}.',
   2, ''),
  ('deck_link', 'Packages & company overview deck',
   'Link to the deck (Google Slides or PDF). Attached to proposal emails and offered in the workspace.',
   3, ''),
  ('followup_1', 'Follow-up 1 — gentle nudge',
   'Sent a few days after the first message. Short. Use {{company}}, {{contact}}, {{sender}}.', 4, ''),
  ('followup_2', 'Follow-up 2 — add value',
   'Lead with something useful — a case study or an observation, not another ask.', 5, ''),
  ('followup_3', 'Follow-up 3 — different angle',
   'Change the approach entirely. Reference something recent about them.', 6, ''),
  ('followup_4', 'Follow-up 4 — move to nurture',
   'Stop chasing. Leave the door open for when something relevant happens.', 7, ''),
  ('meeting_notes_email', 'Meeting notes — forwarding email',
   'Covering note when meeting notes are forwarded. Use {{company}}, {{contact}}, {{date}}, {{sender}}.',
   8, '')
on conflict (key) do nothing;

-- --- 5. the loss interview: competitor budget is gone -----------------------
-- Question 3 asked for an approximate competitor budget. Salespeople were
-- guessing, and a guessed number that later gets counted is worse than no
-- number. The column is dropped rather than hidden so nothing reads it by
-- accident later.
alter table opportunity_loss drop column if exists competitor_budget;

-- --- 6. cost and margin come out --------------------------------------------
-- Pricing is now budget vs quoted price only. The columns are left in place
-- (dropping them would lose the history of deals already priced) but nothing
-- writes or reads them from here on.
--
-- Manager approval survives, driven purely by discount against the package's
-- list price — no cost or margin involved.
update pricing_settings
   set value = jsonb_build_object('max_discount_pct', coalesce((value->>'max_discount_pct')::numeric, 20))
 where key = 'guardrail';
