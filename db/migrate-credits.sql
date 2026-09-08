-- ---------------------------------------------------------------------------
-- Contact-unlock credits.
--
-- New joinees start with 50 credits, managers/admins with 180. Revealing one
-- contact's email/phone spends credits by their seniority: 51 for
-- Founder/Co-Founder/Director/Head-of-anything, 12 for Manager, 5 for
-- everyone else. 51 > 50 is deliberate — a fresher's starting balance can
-- never afford a single high-level contact on its own.
--
-- Safe to re-run: the column add is IF NOT EXISTS, and the admin backfill
-- only touches rows still sitting at the just-added default, so a credit
-- balance an admin has since adjusted by hand is never stomped on rerun.
-- ---------------------------------------------------------------------------

alter table users add column if not exists credits integer not null default 50;

update users set credits = 180 where role = 'admin' and credits = 50;

-- One unlock per (contact, user), forever — once spent, a contact's details
-- stay visible to that person without paying again.
create table if not exists contact_unlocks (
  id            bigint generated always as identity primary key,
  contact_id    bigint not null references company_contacts(id) on delete cascade,
  user_id       bigint not null references users(id) on delete cascade,
  credits_spent integer not null,
  unlocked_at   timestamptz not null default now(),
  unique (contact_id, user_id)
);

create index if not exists idx_contact_unlocks_user    on contact_unlocks (user_id);
create index if not exists idx_contact_unlocks_contact on contact_unlocks (contact_id);

alter table contact_unlocks enable row level security;
