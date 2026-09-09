-- ---------------------------------------------------------------------------
-- Credits for Fresh Leads claims.
--
-- Claiming a company from Fresh Leads costs credits. The claim buys three
-- things at once:
--
--   1. The company's three most senior contacts, revealed for free.
--   2. An exclusive hold — while the claim is live, nobody else can claim or
--      unlock ANY contact at that company, from Fresh Leads or All Leads.
--   3. A settlement when the claim ends, which pays back more than it cost if
--      the lead converts and costs extra if it was claimed and never worked.
--
-- Every number here is a default, not a rule carved into the code: admins
-- edit them in Admin > Credit rules, and the app reads this table rather
-- than any hardcoded constant.
--
-- Safe to re-run.
-- ---------------------------------------------------------------------------

-- --- the rules -------------------------------------------------------------
-- One row, forever. The check constraint is what enforces that: a second
-- insert collides on the primary key instead of silently creating a rival
-- set of rules that half the app would read and half would ignore.
create table if not exists credit_settings (
  id                      smallint primary key default 1,

  -- What one Fresh Leads claim costs.
  fresh_claim_cost        integer not null default 15,

  -- How many of that company's contacts come free with the claim. The most
  -- senior ones, because those are the expensive ones to unlock by hand.
  free_contacts_per_claim integer not null default 3,

  -- Converted: the claim pays back this many times what it cost. 3 means a
  -- 15-credit claim returns 45.
  win_multiplier          numeric(5,2) not null default 3,

  -- Lost, but there was a real conversation. Percentage of the claim cost
  -- returned, by how many times the contact actually replied.
  refund_pct_3plus        integer not null default 50,   -- 3 or more replies
  refund_pct_2            integer not null default 40,   -- exactly 2
  refund_pct_1            integer not null default 25,   -- exactly 1

  -- Claimed, worked, never got an answer: nothing back, nothing extra taken.
  -- (No column — zero is the whole rule.)

  -- Claimed and nothing was ever sent. The cost is gone AND this comes off
  -- on top, because holding a company nobody else could touch and doing
  -- nothing with it is the expensive failure.
  no_work_penalty         integer not null default 10,

  -- How many Fresh claims one person may hold at once.
  max_active_claims       integer not null default 8,

  updated_at              timestamptz not null default now(),
  updated_by              bigint references users(id) on delete set null,

  constraint credit_settings_singleton check (id = 1)
);

insert into credit_settings (id) values (1) on conflict (id) do nothing;

-- --- every credit movement, in order --------------------------------------
-- Without this the balance is a number nobody can argue with. With it, "why
-- do I have 22 credits" has an answer that fits on one screen.
create table if not exists credit_ledger (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references users(id) on delete cascade,

  -- Signed: negative spends, positive returns. Summing this column for a
  -- user should always land on their balance, minus their starting grant.
  amount        integer not null,
  balance_after integer not null,

  -- claim | unlock | free_unlock | win_bonus | partial_refund | penalty |
  -- admin_adjust | grant
  kind          text not null,

  lead_id       bigint references leads(id) on delete set null,
  contact_id    bigint references company_contacts(id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_credit_ledger_user on credit_ledger (user_id, created_at desc);
create index if not exists idx_credit_ledger_lead on credit_ledger (lead_id);

-- --- one row per paid Fresh claim -----------------------------------------
-- The charge and its eventual settlement live on the same row, so a claim can
-- never be settled twice: settled_at going non-null is the lock.
create table if not exists fresh_claim_credits (
  id                bigint generated always as identity primary key,
  lead_id           bigint not null references leads(id) on delete cascade,
  user_id           bigint not null references users(id) on delete cascade,

  credits_spent     integer not null,
  -- Which contacts came free with this claim. Kept so releasing can leave
  -- them unlocked for the person who paid, without also making every
  -- contact they ever paid for look like a freebie.
  free_contact_ids  bigint[] not null default '{}',

  claimed_at        timestamptz not null default now(),

  -- Filled in when the claim ends. Null means still running.
  settled_at        timestamptz,
  outcome           text,        -- won | lost | no_reply | no_work | released
  reply_rounds      integer,     -- how many times they actually got an answer
  settlement_amount integer      -- signed: +45 on a win, -10 on a dead claim
);

create index if not exists idx_fcc_lead on fresh_claim_credits (lead_id);
create index if not exists idx_fcc_user on fresh_claim_credits (user_id);

-- One live claim per lead. A second charge on a lead already being worked is
-- a bug, and this is where it gets caught rather than in a support ticket.
create unique index if not exists idx_fcc_open_lead
  on fresh_claim_credits (lead_id) where settled_at is null;

-- The active-claim cap counts these, so the lookup has to be cheap.
create index if not exists idx_fcc_open_user
  on fresh_claim_credits (user_id) where settled_at is null;

-- --- free unlocks are still unlocks ----------------------------------------
-- They go in contact_unlocks like any other, so every read path that already
-- checks "has this person unlocked that contact" keeps working untouched.
-- The source column is only so the ledger and the UI can tell the person
-- they got these three for free.
alter table contact_unlocks add column if not exists source text not null default 'paid';
alter table contact_unlocks add column if not exists lead_id bigint references leads(id) on delete set null;
