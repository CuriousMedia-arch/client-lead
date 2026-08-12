-- ---------------------------------------------------------------------------
-- Curious Media / Lead Intelligence — full Postgres schema for Supabase.
-- Run once: Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run; every statement is IF NOT EXISTS / ON CONFLICT.
-- ---------------------------------------------------------------------------

-- --- team -------------------------------------------------------------------
create table if not exists users (
  id            bigint generated always as identity primary key,
  username      text not null unique,
  display_name  text not null,
  password_hash text not null,
  role          text not null default 'member',   -- 'admin' | 'member'
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  id         text primary key,
  user_id    bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sessions_expires on sessions (expires_at);

-- --- watchlist --------------------------------------------------------------
create table if not exists companies (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  keywords   jsonb not null default '[]'::jsonb,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists sites (
  id         bigint generated always as identity primary key,
  name       text not null,
  domain     text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists topics (
  id      bigint generated always as identity primary key,
  keyword text not null unique,
  active  boolean not null default false
);

-- --- leads ------------------------------------------------------------------
create table if not exists leads (
  id                bigint generated always as identity primary key,
  company_id        bigint not null unique references companies(id) on delete cascade,
  status            text not null default 'new',
  -- new | working | contacted | replied | qualified | won | lost
  owner_id          bigint references users(id) on delete set null,
  contact_name      text,
  contact_role      text,
  contact_email     text,
  contact_phone     text,
  last_contacted_at timestamptz,
  next_followup_at  date,
  last_signal_at    timestamptz,
  score             integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_leads_owner  on leads (owner_id);
create index if not exists idx_leads_status on leads (status);

-- --- signals ----------------------------------------------------------------
create table if not exists signals (
  id             bigint generated always as identity primary key,
  lead_id        bigint not null references leads(id) on delete cascade,
  company        text not null,
  title          text,
  url            text not null unique,
  author         text,
  published      timestamptz,
  site           text,
  section_title  text,
  body           text,
  summary        text,
  why_it_matters text,
  signal_type    text not null default 'other',
  score          integer not null default 40,
  enriched       boolean not null default false,
  run_id         bigint,
  created_at     timestamptz not null default now()
);

create index if not exists idx_signals_lead    on signals (lead_id);
create index if not exists idx_signals_created on signals (created_at desc);
create index if not exists idx_signals_type    on signals (signal_type);

-- --- outreach log -----------------------------------------------------------
create table if not exists activity (
  id         bigint generated always as identity primary key,
  lead_id    bigint not null references leads(id) on delete cascade,
  user_id    bigint references users(id) on delete set null,
  kind       text not null,   -- note | email | call | linkedin | meeting | status | claim
  body       text,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_lead on activity (lead_id, created_at desc);

-- --- scrape run history -----------------------------------------------------
create table if not exists runs (
  id          bigint generated always as identity primary key,
  trigger     text not null default 'manual',   -- manual | schedule | startup
  status      text not null default 'running',  -- running | done | failed
  queries     integer not null default 0,
  fetched     integer not null default 0,
  new_signals integer not null default 0,
  errors      integer not null default 0,
  message     text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- --- people directory -------------------------------------------------------
create table if not exists company_contacts (
  id         bigint generated always as identity primary key,
  company    text not null,          -- must match the watchlist name, e.g. 'Meesho'
  name       text not null,
  role       text,
  email      text,
  phone      text,
  linkedin   text,
  notes      text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_company_contacts_company on company_contacts (lower(company));
create unique index if not exists idx_company_contacts_unique
  on company_contacts (lower(company), lower(name));

-- ---------------------------------------------------------------------------
-- The app connects as the Postgres owner, which bypasses RLS. We still enable
-- it everywhere so nothing is readable if the anon key ever leaks.
-- ---------------------------------------------------------------------------
alter table users            enable row level security;
alter table sessions         enable row level security;
alter table companies        enable row level security;
alter table sites            enable row level security;
alter table topics           enable row level security;
alter table leads            enable row level security;
alter table signals          enable row level security;
alter table activity         enable row level security;
alter table runs             enable row level security;
alter table company_contacts enable row level security;

-- ---------------------------------------------------------------------------
-- Fresh Leads (discovery)
--
-- The watchlist sweep only finds companies you already named. The discovery
-- sweep queries the same sources by business-event keyword with no company
-- filter, and Gemini reads each article to say which company it is about.
--
-- Those companies land here as origin='discovered', approval='pending', and
-- active=false — they show up in the Fresh Leads tab and can be claimed, but
-- they are NOT scanned on the daily cycle until an admin approves them.
-- ---------------------------------------------------------------------------
alter table companies add column if not exists origin   text not null default 'watchlist';
alter table companies add column if not exists approval text not null default 'approved';

-- origin:   'watchlist' (you added it) | 'discovered' (the sweep found it)
-- approval: 'approved'  (scanned daily) | 'pending' (Fresh only) | 'rejected' (ignored forever)

create index if not exists idx_companies_approval on companies (approval);

-- Matching a discovered name against what we already have has to be
-- case-insensitive, or "zomato" and "Zomato" become two companies.
create unique index if not exists idx_companies_name_lower on companies (lower(name));
