-- ---------------------------------------------------------------------------
-- Migration: Microsoft Teams meetings.
--
-- Run after migrate-outreach-5.sql. Safe to re-run.
--
-- Curious Media runs on Microsoft 365, so Teams is the meeting provider —
-- the licences already exist. The Google integration stays alongside it;
-- lib/meetings.js picks whichever a person has connected.
-- ---------------------------------------------------------------------------

create table if not exists microsoft_accounts (
  user_id       bigint primary key references users(id) on delete cascade,
  email         text,
  -- Encrypted at rest by lib/tokens.js, same as the Google tokens.
  refresh_token text not null,
  scopes        text,
  connected_at  timestamptz not null default now(),
  last_used_at  timestamptz,
  last_error    text
);

alter table microsoft_accounts enable row level security;

-- Which provider made a given meeting. Needed because the columns below hold
-- a Google Meet link on one row and a Teams link on the next, and fetching a
-- transcript goes to a completely different API depending on which.
alter table opportunity_meetings add column if not exists provider text;

-- Everything already booked predates Microsoft, so it is Google's.
update opportunity_meetings
   set provider = 'google'
 where provider is null
   and meet_link is not null;
