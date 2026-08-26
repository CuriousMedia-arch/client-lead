-- ---------------------------------------------------------------------------
-- Migration: My Outreach, round two.
--
-- Run once in Supabase → SQL Editor, after migrate-outreach.sql.
-- Safe to re-run; every statement is IF NOT EXISTS / ON CONFLICT.
--
-- Three things:
--   1. Bell read-state, so the dot is red only for something you haven't seen.
--   2. Admin delete for newspaper leads, with an optional company blocklist.
--   3. A silence deadline on every opportunity — send the first message inside
--      24 hours or the lead goes back to the pool.
-- ---------------------------------------------------------------------------

-- --- 1. bell read-state -----------------------------------------------------
-- One timestamp per user. An alert shows a red dot only if it became true
-- after this moment, so opening the bell clears it and it stays clear until
-- something genuinely new happens. Storing the timestamp rather than a list of
-- dismissed ids means a problem that comes BACK (they reply again, a new
-- reminder falls due) correctly lights the dot a second time.
alter table users add column if not exists alerts_seen_at timestamptz;

-- --- 2. admin delete for newspaper leads ------------------------------------
-- Soft delete, matching how company_contacts already works. The row stays so
-- nothing referencing it breaks, and an admin can see what was removed.
alter table leads add column if not exists deleted_at    timestamptz;
alter table leads add column if not exists deleted_by    bigint references users(id) on delete set null;
alter table leads add column if not exists delete_reason text;

create index if not exists idx_leads_deleted on leads (deleted_at) where deleted_at is not null;

-- The blocklist is the "and don't bring it back" half. Without it the scraper
-- re-finds the same company next week and the admin deletes it again forever.
create table if not exists company_blocklist (
  id         bigint generated always as identity primary key,
  company    text not null,
  reason     text,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_blocklist_company on company_blocklist (lower(company));

alter table company_blocklist enable row level security;

-- --- 3. send-or-lose-it deadline --------------------------------------------
-- Set when the opportunity is created; cleared the moment a first message is
-- logged. While it is set and in the past, the lead is overdue for release.
--
-- A separate column rather than reusing created_at because the window is
-- configurable (pricing_settings → followup_cadence.release_after_hours) and
-- because clearing it is how "they've been contacted" is recorded — one field
-- to read instead of a join against the messages table on every list.
alter table opportunities add column if not exists silent_until timestamptz;

create index if not exists idx_opp_silent on opportunities (silent_until)
  where silent_until is not null;

-- Backfill: anything already claimed and never contacted gets a fresh window
-- from now, not from whenever it was claimed. Nobody should log in after this
-- migration and find their leads already gone.
update opportunities
   set silent_until = now() + interval '24 hours'
 where silent_until is null
   and stage = 'new'
   and last_contacted_at is null;

-- The release window joins the other cadence settings so it is admin-editable
-- in the same place. jsonb_set rather than a fresh insert, because
-- followup_cadence already exists from the first migration.
update pricing_settings
   set value = jsonb_set(value, '{release_after_hours}', '24'::jsonb, true)
 where key = 'followup_cadence'
   and not (value ? 'release_after_hours');

insert into pricing_settings (key, value) values
  ('followup_cadence', jsonb_build_object(
      'step1_days', 3, 'step2_days', 7, 'step3_days', 14, 'step4_days', 30,
      'nudge_after_hours', 12, 'release_after_hours', 24
  ))
on conflict (key) do nothing;
