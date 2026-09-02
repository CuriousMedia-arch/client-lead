-- ---------------------------------------------------------------------------
-- Migration: Fathom transcripts.
--
-- Run after migrate-outreach-6.sql. Safe to re-run.
--
-- Fathom's bot joins the call and records it itself, so transcripts work on a
-- free Google account and on any platform — no Workspace, no tenant switch,
-- nobody's admin. We take only the transcript; the notes are written by
-- lib/outreachAI.js, which knows the company, the service and the price.
-- ---------------------------------------------------------------------------

alter table opportunity_meetings add column if not exists transcript_source   text;
alter table opportunity_meetings add column if not exists fathom_recording_id text;
alter table opportunity_meetings add column if not exists fathom_share_url    text;

create index if not exists idx_meet_fathom on opportunity_meetings (fathom_recording_id)
  where fathom_recording_id is not null;

-- Anything already transcribed came from the meeting provider itself.
update opportunity_meetings
   set transcript_source = 'provider'
 where transcript_source is null
   and transcript_text is not null;

-- --- recordings that matched no meeting -------------------------------------
-- Fathom records internal calls too, so most of these are expected and
-- harmless. They are kept rather than dropped because a CLIENT meeting landing
-- here is what a matching bug looks like, and silently discarding them would
-- hide it. The admin screen reads this table.
create table if not exists fathom_unmatched (
  id           bigint generated always as identity primary key,
  recording_id text unique,
  title        text,
  started_at   timestamptz,
  emails       jsonb not null default '[]'::jsonb,
  share_url    text,
  transcript   text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_fathom_unmatched_at on fathom_unmatched (created_at desc);

alter table fathom_unmatched enable row level security;
