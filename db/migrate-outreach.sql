-- ---------------------------------------------------------------------------
-- Migration: My Outreach.
--
-- Everything the outreach module needs, in one file. Run once:
--   Supabase -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run; every statement is IF NOT EXISTS / ON CONFLICT.
--
-- The shape follows the brief: an OPPORTUNITY is the unit of work, not a lead
-- and not a contact. A lead is a name in a database; an opportunity is a thing
-- you are trying to close, and it is what carries the service, the plan, the
-- price, the pitch, the meetings, the proposal versions and — when it dies —
-- the reason it died.
--
-- An opportunity always points at a claim that already exists: either a person
-- claimed from All Leads (contact_id) or a company claimed from Fresh Leads /
-- Newspaper (lead_id). It never replaces the claim or its countdown, it hangs
-- off it. Release the claim and the opportunity goes with it.
-- ---------------------------------------------------------------------------

-- --- the opportunity --------------------------------------------------------
create table if not exists opportunities (
  id                bigint generated always as identity primary key,

  -- Exactly one of these is set. contact_id for an All Leads claim (a person),
  -- lead_id for a Fresh Leads or Newspaper claim (a company).
  contact_id        bigint references company_contacts(id) on delete cascade,
  lead_id           bigint references leads(id) on delete cascade,

  company           text not null,
  owner_id          bigint references users(id) on delete set null,
  source            text not null default 'all',   -- all | fresh | newspaper

  -- The funnel. Every move is also written to opportunity_stages so we can ask
  -- where deals die, not just how many did.
  stage             text not null default 'new',
  -- new | contacted | replied | meeting | proposal | negotiation | won | lost

  -- Item 4: what the system thinks we should sell them, and why.
  service_primary   text,
  service_secondary text,
  service_optional  text,
  service_rationale text,
  service_source    text,                          -- ai | manual
  service_accepted  boolean not null default false,

  -- Items 5-6: the plan, off the rate card or built by hand.
  plan_tier         text,                          -- starter | growth | scale | custom
  plan_name         text,
  plan_config       jsonb not null default '{}'::jsonb,

  -- Item 7: the money, and the guardrail.
  client_budget     numeric(14,2),
  quoted_price      numeric(14,2),
  vendor_cost       numeric(14,2),
  internal_cost     numeric(14,2),
  margin_amount     numeric(14,2),
  margin_pct        numeric(6,2),

  -- Item 24: set when a quote breaches the margin floor or the discount cap.
  approval_status   text,                          -- null | pending | approved | rejected
  approval_note     text,
  approval_reason   text,                          -- why approval was triggered
  approved_by       bigint references users(id) on delete set null,
  approval_at       timestamptz,

  -- What the Today screen reads to decide what is urgent.
  next_action       text,
  next_action_at    timestamptz,
  last_contacted_at timestamptz,
  last_reply_at     timestamptz,

  won_at            timestamptz,
  lost_at           timestamptz,
  won_value         numeric(14,2),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One opportunity per claim. Partial uniques because only one column is ever
-- set — a plain unique would treat the NULL side as always-distinct.
create unique index if not exists idx_opp_contact on opportunities (contact_id)
  where contact_id is not null;
create unique index if not exists idx_opp_lead on opportunities (lead_id)
  where lead_id is not null;

create index if not exists idx_opp_owner  on opportunities (owner_id);
create index if not exists idx_opp_stage  on opportunities (stage);
create index if not exists idx_opp_action on opportunities (next_action_at);

-- --- item 13: where the opportunity failed ----------------------------------
-- Every stage move, kept forever. Lead -> Meeting -> Proposal -> Won as counts
-- is the whole point: "we are fine at meetings and bad at proposals" is a
-- different management problem from "we are bad at sales".
create table if not exists opportunity_stages (
  id             bigint generated always as identity primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  from_stage     text,
  to_stage       text not null,
  user_id        bigint references users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists idx_opp_stages_opp on opportunity_stages (opportunity_id, created_at);
create index if not exists idx_opp_stages_to  on opportunity_stages (to_stage);

-- --- items 12 & 14: the lost-opportunity interview --------------------------
-- Never just "Lost". One row per loss, and it is required before an
-- opportunity can be marked lost.
create table if not exists opportunity_loss (
  opportunity_id     bigint primary key references opportunities(id) on delete cascade,
  primary_reason     text not null,
  secondary_reason   text,
  note               text,
  chose              text,                 -- competitor | internal | nobody | unknown
  competitor_name    text,
  competitor_budget  numeric(14,2),
  disliked           jsonb not null default '[]'::jsonb,
  -- price | idea | timeline | deliverables | trust | relationship
  could_have_changed text,
  reapproach         boolean,
  reapproach_days    integer,              -- 30 | 60 | 90
  reapproach_at      date,
  lost_at_stage      text,                 -- the stage it died in
  created_by         bigint references users(id) on delete set null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_opp_loss_reason on opportunity_loss (primary_reason);
create index if not exists idx_opp_loss_reapp  on opportunity_loss (reapproach_at)
  where reapproach_at is not null;

-- --- items 8-11, 16-17: messages in and out ---------------------------------
-- Outbound is what we generated and sent; inbound is what the client wrote
-- back, with the classification on the same row. Both feed the timeline.
create table if not exists opportunity_messages (
  id             bigint generated always as identity primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  direction      text not null,            -- out | in
  channel        text not null,            -- email | linkedin | whatsapp | call | meeting | note
  subject        text,
  body           text not null,

  -- Item 17, set by the classifier on inbound mail.
  sentiment      text,                     -- positive | neutral | negative
  intent         text,                     -- interested | information | objection | meeting | rejection
  ai_next_action text,
  ai_source      text,                     -- ai | rules

  generated      boolean not null default false,   -- came out of the pitch generator
  sent_at        timestamptz,
  created_by     bigint references users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists idx_opp_msg on opportunity_messages (opportunity_id, created_at desc);

-- --- items 18-19: the follow-up engine --------------------------------------
-- A schedule, not a sender. Steps are created when the first pitch goes out and
-- cancelled the moment a reply is logged — the brief is explicit that nobody
-- wants "just following up" landing after the client has already answered.
create table if not exists opportunity_followups (
  id             bigint generated always as identity primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  step           integer not null,         -- 1 | 2 | 3 | 4
  kind           text not null,            -- reminder | value | angle | nurture
  due_at         date not null,
  status         text not null default 'due',   -- due | done | cancelled
  suggestion     text,
  done_at        timestamptz,
  created_at     timestamptz not null default now()
);

create unique index if not exists idx_opp_fu_step on opportunity_followups (opportunity_id, step);
create index if not exists idx_opp_fu_due on opportunity_followups (due_at) where status = 'due';

-- --- items 20-21: meetings and structured notes -----------------------------
create table if not exists opportunity_meetings (
  id             bigint generated always as identity primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  scheduled_at   timestamptz not null,
  link           text,
  attendees      text,
  outcome        text,
  -- interested | need_proposal | internal_discussion | budget_discussion |
  -- not_interested | followup_later
  requirement    text,
  notes          text,
  structured     jsonb not null default '{}'::jsonb,   -- AI-extracted fields
  created_by     bigint references users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists idx_opp_meet on opportunity_meetings (opportunity_id, scheduled_at desc);

-- --- items 22-23: proposals, versioned --------------------------------------
-- Never updated in place. V1 10L -> V2 8.5L -> V3 7.5L, each row saying who
-- changed it and why, because that history IS the discounting report.
create table if not exists opportunity_proposals (
  id             bigint generated always as identity primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  version        integer not null,
  price          numeric(14,2),
  service        text,
  plan_name      text,
  body           text,
  change_note    text,
  sent_at        timestamptz,
  created_by     bigint references users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create unique index if not exists idx_opp_prop_v on opportunity_proposals (opportunity_id, version);

-- --- items 5-7: the rate card, admin-editable -------------------------------
-- Placeholders now, real numbers later. Nothing in the app hardcodes a price;
-- it all reads from here.
create table if not exists rate_card (
  id           bigint generated always as identity primary key,
  service      text not null,
  tier         text not null,            -- starter | growth | scale
  label        text not null,
  price        numeric(14,2) not null,
  creators     integer,
  views        text,
  deliverables text,
  active       boolean not null default true,
  sort         integer not null default 0
);

create unique index if not exists idx_rate_card_key on rate_card (lower(service), lower(tier));

-- The cost model behind the custom plan builder and the margin guardrail.
-- One row per key so an admin can change the floor without a deploy.
create table if not exists pricing_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by bigint references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- --- seed: placeholder pricing ----------------------------------------------
-- Deliberately round, obviously-fake numbers. They exist so every screen
-- renders and every calculation runs end to end before the real rate card is
-- pasted in. Admin -> Pricing overwrites all of it.
insert into rate_card (service, tier, label, price, creators, views, deliverables, sort) values
  ('Influencer Marketing', 'starter', 'Starter', 300000,  50, '5M views',   '1 Reel per creator', 1),
  ('Influencer Marketing', 'growth',  'Growth',  500000, 100, '12M views',  '1 Reel + 2 Stories', 2),
  ('Influencer Marketing', 'scale',   'Scale',  1000000, 250, '30M views',  '2 Reels + 3 Stories', 3),
  ('Meme Marketing',       'starter', 'Starter', 150000,  20, '4M views',   '1 post per page', 1),
  ('Meme Marketing',       'growth',  'Growth',  350000,  50, '10M views',  '2 posts per page', 2),
  ('Meme Marketing',       'scale',   'Scale',   700000, 120, '25M views',  '3 posts + story', 3),
  ('Content Distribution', 'starter', 'Starter', 200000,  30, '6M views',   'Seeding only', 1),
  ('Content Distribution', 'growth',  'Growth',  400000,  70, '15M views',  'Seeding + amplification', 2),
  ('Content Distribution', 'scale',   'Scale',   800000, 150, '35M views',  'Full distribution retainer', 3),
  ('Curious Studios',      'starter', 'Starter', 250000,   0, 'n/a',        '1 shoot day', 1),
  ('Curious Studios',      'growth',  'Growth',  600000,   0, 'n/a',        '3 shoot days + edit', 2),
  ('Curious Studios',      'scale',   'Scale',  1200000,   0, 'n/a',        'Monthly retainer', 3)
on conflict (lower(service), lower(tier)) do nothing;

insert into pricing_settings (key, value) values
  ('cost_model', jsonb_build_object(
      'creator_rates', jsonb_build_object('nano', 3000, 'micro', 12000, 'macro', 60000),
      'internal_cost_pct', 10,
      'geo_multiplier', jsonb_build_object(
          'India', 1.0, 'North', 1.0, 'South', 1.05, 'Regional', 0.9),
      'language_multiplier', jsonb_build_object(
          'Hindi', 1.0, 'English', 1.1, 'Tamil', 0.95, 'Telugu', 0.95,
          'Marathi', 0.95, 'Bengali', 0.95, 'Kannada', 0.95),
      'deliverable_multiplier', jsonb_build_object(
          'Reels', 1.0, 'YouTube', 1.8, 'Stories', 0.5, 'Static post', 0.6)
  )),
  ('guardrail', jsonb_build_object(
      'healthy_margin_pct', 35,
      'min_margin_pct', 25,
      'max_discount_pct', 20
  )),
  -- When the follow-up sequence fires, and how long a claimed-but-never-
  -- contacted opportunity may sit before the bell starts nagging. The day
  -- numbers are the brief's; nudge_after_hours has no equivalent in the brief
  -- and exists because a lead can otherwise sit silent until its claim dies.
  ('followup_cadence', jsonb_build_object(
      'step1_days', 3,
      'step2_days', 7,
      'step3_days', 14,
      'step4_days', 30,
      'nudge_after_hours', 24
  ))
on conflict (key) do nothing;

-- --- RLS, matching the rest of the schema -----------------------------------
alter table opportunities         enable row level security;
alter table opportunity_stages    enable row level security;
alter table opportunity_loss      enable row level security;
alter table opportunity_messages  enable row level security;
alter table opportunity_followups enable row level security;
alter table opportunity_meetings  enable row level security;
alter table opportunity_proposals enable row level security;
alter table rate_card             enable row level security;
alter table pricing_settings      enable row level security;
