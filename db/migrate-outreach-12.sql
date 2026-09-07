-- Automatic meeting notes: let the background sweep fetch them.
-- Run after migrate-outreach-11.sql. Safe to re-run.
--
-- Transcripts are not ready when a call ends — minutes at best, up to about an
-- hour. So the sweep retries rather than trying once and giving up, and these
-- two columns are what stop it retrying forever on meetings that will never
-- have a recording (nobody switched transcription on, a client hosted it).
alter table opportunity_meetings add column if not exists transcript_attempts integer not null default 0;
alter table opportunity_meetings add column if not exists transcript_next_try  timestamptz;

create index if not exists idx_meet_pending
  on opportunity_meetings (transcript_next_try)
  where notes_generated_at is null;
