-- ---------------------------------------------------------------------------
-- Migration: the clock changes meaning as the deal moves.
--
-- Run after migrate-outreach-3.sql. Safe to re-run.
--
-- Until now an opportunity had one flat deadline that meant "your claim runs
-- out then", and it never moved. Three problems came out of that:
--
--   * The card said "24h to close this" when 24h was actually the time to send
--     a first message. Wrong on its face.
--   * The deadline never extended, so a lead you contacted stayed permanently
--     inside the urgent window and could never show as anything else — which
--     is why a logged reply never appeared under "They replied".
--   * There was no way to say "you have a week to get an answer" as distinct
--     from "you have a week to close it".
--
-- So the deadline now carries a KIND, and each kind resets it:
--
--   contact  24 hours from claiming to send the first message
--   reply     7 days from that message to get an answer
--   close     7 days from their answer to win or lose it
--
-- Miss any of them and the lead goes back to the pool.
-- ---------------------------------------------------------------------------

alter table opportunities add column if not exists deadline_at   timestamptz;
alter table opportunities add column if not exists deadline_kind text;

create index if not exists idx_opp_deadline on opportunities (deadline_at)
  where deadline_at is not null;

-- Carry the old silence deadline across. silent_until meant exactly the
-- 'contact' kind, so nobody's clock resets or jumps on deploy.
update opportunities
   set deadline_at   = coalesce(deadline_at, silent_until),
       deadline_kind = coalesce(deadline_kind, 'contact')
 where silent_until is not null
   and deadline_at is null;

-- Anything already contacted gets a reply window starting now rather than
-- inheriting a deadline it never had. Starting it now is the generous reading,
-- and the alternative — back-dating from last_contacted_at — would expire live
-- conversations the moment this migration ran.
update opportunities
   set deadline_at   = now() + interval '7 days',
       deadline_kind = case when last_reply_at is not null then 'close' else 'reply' end
 where stage not in ('won','lost')
   and last_contacted_at is not null
   and deadline_at is null;

-- --- repeat attempts on the same contact ------------------------------------
-- The old unique indexes allowed exactly ONE opportunity per contact or lead,
-- ever. That was fine while an opportunity lived as long as the claim, but a
-- released lead now keeps its history — so a second attempt six months later
-- needs a second row, and the first must survive as the record of what was
-- tried.
--
-- The constraint that actually matters is "only one OPEN opportunity at a
-- time", which is what these replacements say.
drop index if exists idx_opp_contact;
drop index if exists idx_opp_lead;

create unique index if not exists idx_opp_contact_open on opportunities (contact_id)
  where contact_id is not null and stage not in ('won','lost');

create unique index if not exists idx_opp_lead_open on opportunities (lead_id)
  where lead_id is not null and stage not in ('won','lost');

-- --- the windows, admin-editable --------------------------------------------
update pricing_settings
   set value = value
             || jsonb_build_object('contact_hours', 24)
             || jsonb_build_object('reply_days', 7)
             || jsonb_build_object('close_days', 7)
             || jsonb_build_object('nudge_after_hours', 12)
 where key = 'followup_cadence';

insert into pricing_settings (key, value) values
  ('followup_cadence', jsonb_build_object(
      'step1_days', 3, 'step2_days', 7, 'step3_days', 14, 'step4_days', 30,
      'contact_hours', 24, 'reply_days', 7, 'close_days', 7,
      'nudge_after_hours', 12
  ))
on conflict (key) do nothing;
