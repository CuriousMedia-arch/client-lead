-- ---------------------------------------------------------------------------
-- Migration: Fresh Leads lifecycle, notifications, extensions, claim history.
-- Run once: Supabase -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Columns the app reads and writes that schema.postgres.sql never declared.
-- The schema file drifted behind the code, so a database built from it alone
-- is missing most of the contact record. Declared here, idempotently, before
-- anything below depends on them.
-- ---------------------------------------------------------------------------
alter table company_contacts add column if not exists email_alt      text;
alter table company_contacts add column if not exists phone_type     text;
alter table company_contacts add column if not exists phone2         text;
alter table company_contacts add column if not exists phone2_type    text;
alter table company_contacts add column if not exists seniority      text;
alter table company_contacts add column if not exists department     text;
alter table company_contacts add column if not exists city           text;
alter table company_contacts add column if not exists country        text;
alter table company_contacts add column if not exists state          text;
alter table company_contacts add column if not exists owner_id       bigint references users(id) on delete set null;
alter table company_contacts add column if not exists claimed_at     timestamptz;
alter table company_contacts add column if not exists deadline_at    timestamptz;
alter table company_contacts add column if not exists closed_at      timestamptz;
alter table company_contacts add column if not exists claim_source   text;
alter table company_contacts add column if not exists status         text not null default 'new';
alter table company_contacts add column if not exists deleted_at     timestamptz;
alter table company_contacts add column if not exists deleted_by     bigint references users(id) on delete set null;
alter table company_contacts add column if not exists verified       boolean not null default false;
alter table company_contacts add column if not exists verified_by    bigint references users(id) on delete set null;
alter table company_contacts add column if not exists verified_at    timestamptz;

alter table companies add column if not exists domain       text;
alter table companies add column if not exists website      text;
alter table companies add column if not exists linkedin     text;
alter table companies add column if not exists industry     text;
alter table companies add column if not exists employees    text;
alter table companies add column if not exists revenue      text;
alter table companies add column if not exists founded      text;
alter table companies add column if not exists city         text;
alter table companies add column if not exists state        text;
alter table companies add column if not exists specialities text;
alter table companies add column if not exists is_sample    boolean not null default false;

alter table leads add column if not exists claimed_at           timestamptz;
alter table leads add column if not exists claim_source         text;
alter table leads add column if not exists deadline_at          timestamptz;
alter table leads add column if not exists closed_at            timestamptz;
alter table leads add column if not exists released_at          timestamptz;
alter table leads add column if not exists fresh_owner_id       bigint references users(id) on delete set null;
alter table leads add column if not exists fresh_claimed_at     timestamptz;
alter table leads add column if not exists fresh_deadline_at    timestamptz;
alter table leads add column if not exists fresh_closed_at      timestamptz;
alter table leads add column if not exists fresh_released_at    timestamptz;
alter table leads add column if not exists fresh_from_newspaper boolean not null default false;
alter table leads add column if not exists in_newspaper         boolean not null default false;

alter table signals add column if not exists pitch text;

create table if not exists contact_activity (
  id         bigint generated always as identity primary key,
  contact_id bigint not null references company_contacts(id) on delete cascade,
  user_id    bigint references users(id) on delete set null,
  kind       text not null default 'note',
  body       text not null,
  stage      text,
  created_at timestamptz not null default now()
);
create index if not exists idx_contact_activity on contact_activity (contact_id, created_at desc);

create table if not exists contact_originals (
  contact_id bigint primary key references company_contacts(id) on delete cascade,
  company text, name text, role text, email text, email_alt text,
  phone text, phone2 text, linkedin text, seniority text, department text,
  city text, country text, state text,
  imported_at timestamptz not null default now()
);

create table if not exists contact_changes (
  id         bigint generated always as identity primary key,
  contact_id bigint not null references company_contacts(id) on delete cascade,
  user_id    bigint references users(id) on delete set null,
  field      text not null,
  old_value  text,
  new_value  text,
  changed_at timestamptz not null default now()
);
create index if not exists idx_contact_changes on contact_changes (contact_id, changed_at desc);

-- A running tally on the row, so a list of 500 contacts doesn't need a count
-- query each. contact_claims remains the record; this is the cached total.
alter table company_contacts add column if not exists claim_count integer not null default 0;

-- --- notifications ----------------------------------------------------------
create table if not exists notifications (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  link_id    bigint,
  dedupe_key text,
  read_at    timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user on notifications (user_id, read_at, created_at desc);
create unique index if not exists idx_notifications_once
  on notifications (user_id, kind, dedupe_key) where dedupe_key is not null;

-- --- deadline extensions ----------------------------------------------------
create table if not exists extension_requests (
  id           bigint generated always as identity primary key,
  contact_id   bigint references company_contacts(id) on delete cascade,
  lead_id      bigint references leads(id) on delete cascade,
  user_id      bigint not null references users(id) on delete cascade,
  reason       text not null,
  status       text not null default 'pending',
  days_granted integer,
  decided_by   bigint references users(id) on delete set null,
  decided_at   timestamptz,
  admin_note   text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_extensions_pending on extension_requests (status, created_at desc);

-- The scan runs on two cadences: the watchlist sweep behind Company Leads and
-- the discovery sweep behind New Leads.
alter table runs add column if not exists mode text not null default 'company';
create index if not exists idx_runs_mode on runs (mode, started_at desc);

-- --- claim history ----------------------------------------------------------
create table if not exists contact_claims (
  id           bigint generated always as identity primary key,
  contact_id   bigint not null references company_contacts(id) on delete cascade,
  user_id      bigint not null references users(id) on delete cascade,
  source       text,
  claimed_at   timestamptz not null default now(),
  released_at  timestamptz,
  release_note text
);

create index if not exists idx_claims_contact on contact_claims (contact_id, claimed_at desc);

-- One row per (contact, person): the count is "how many different people have
-- held this", so someone releasing and re-claiming the same contact must not
-- inflate it. The app's INSERT relies on this constraint existing.
create unique index if not exists idx_claims_unique on contact_claims (contact_id, user_id);

insert into contact_claims (contact_id, user_id, source, claimed_at)
select id, owner_id, coalesce(claim_source, 'all'), coalesce(claimed_at, now())
  from company_contacts
 where owner_id is not null
   and not exists (select 1 from contact_claims cl
                    where cl.contact_id = company_contacts.id
                      and cl.user_id = company_contacts.owner_id
                      and cl.released_at is null);

-- --- the Fresh Leads clock --------------------------------------------------
-- A Fresh claim is no longer one flat deadline. It has three checkpoints:
--   12h  no activity  -> warn, then auto-release after another 12h
--   7d   not replied  -> Newspaper
--   15d  not closed   -> Newspaper
-- last_activity_at is what all of them are measured against.
alter table leads add column if not exists fresh_last_activity_at timestamptz;
alter table leads add column if not exists fresh_warned_at        timestamptz;
alter table leads add column if not exists fresh_release_note     text;
alter table leads add column if not exists release_note           text;

create index if not exists idx_leads_fresh_activity
  on leads (fresh_last_activity_at) where fresh_owner_id is not null;

-- Anything already held starts its clock from now rather than being swept up
-- the moment this ships.
update leads
   set fresh_last_activity_at = coalesce(fresh_last_activity_at, fresh_claimed_at, now())
 where fresh_owner_id is not null;

-- A contact swept up by a Fresh claim remembers who had it, so the Fresh owner
-- can see what was already in flight.
alter table company_contacts add column if not exists taken_from        bigint references users(id) on delete set null;
alter table company_contacts add column if not exists taken_from_status text;
alter table company_contacts add column if not exists release_note      text;

alter table notifications    enable row level security;
alter table extension_requests enable row level security;
alter table contact_claims   enable row level security;

-- Backfill the cached tally now that contact_claims exists.
update company_contacts cc
   set claim_count = (SELECT COUNT(DISTINCT user_id) FROM contact_claims WHERE contact_id = cc.id)
 where exists (SELECT 1 FROM contact_claims WHERE contact_id = cc.id);

