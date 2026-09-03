-- ---------------------------------------------------------------------------
-- Migration: a Fathom account per person.
-- Run after migrate-outreach-9.sql. Safe to re-run.
--
-- Fathom's bot joins meetings from the calendar of whoever owns the account,
-- so each person who hosts client calls has their own — and each of those has
-- its own API key and its own webhook secret. One shared secret in an env var
-- only ever worked for one person; everyone else's webhooks were rejected
-- with a signature error and their notes silently never arrived.
-- ---------------------------------------------------------------------------

create table if not exists fathom_accounts (
  user_id        bigint primary key references users(id) on delete cascade,
  -- Both encrypted at rest by lib/tokens.js, same as the OAuth tokens.
  api_key        text,
  webhook_secret text not null,
  label          text,
  connected_at   timestamptz not null default now(),
  last_seen_at   timestamptz,
  last_error     text
);

alter table fathom_accounts enable row level security;

-- Which person's Fathom account a recording arrived from, so a transcript is
-- always traceable to the account that produced it.
alter table opportunity_meetings add column if not exists fathom_user_id bigint;
