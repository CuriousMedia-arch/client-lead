-- ---------------------------------------------------------------------------
-- Migration: monthly targets, and the Delivery section.
-- Run after migrate-outreach-8.sql. Safe to re-run.
-- ---------------------------------------------------------------------------

-- --- monthly sales targets --------------------------------------------------
-- One row per person per month. Set by an admin only; a target you can edit
-- yourself is not a target.
--
-- Stored per month rather than as a single number on the user, so raising
-- someone's target in April doesn't silently rewrite what they were measured
-- against in March.
create table if not exists sales_targets (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users(id) on delete cascade,
  period     date not null,                       -- first day of the month
  amount     numeric(14,2) not null default 0,
  set_by     bigint references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_target_user_period
  on sales_targets (user_id, period);

alter table sales_targets enable row level security;

-- --- what a won deal actually brought in ------------------------------------
-- Entered when the deal is closed, and counted against that month's target.
-- Separate from quoted_price on purpose: what was quoted and what was signed
-- are different numbers, and the gap between them is worth being able to see.
alter table opportunities add column if not exists closed_value numeric(14,2);

-- --- Delivery (was Execution Plan) ------------------------------------------
-- Deliverables and timeline were already rows in opportunity_execution. Budget
-- and the two points of contact belong to the engagement as a whole, not to
-- each line, so they sit on the opportunity.
alter table opportunities add column if not exists delivery_budget     numeric(14,2);
alter table opportunities add column if not exists delivery_client_poc text;
alter table opportunities add column if not exists delivery_agency_poc text;

-- Carry the won value across for anything already closed, so this month's
-- numbers don't start from zero on deploy.
update opportunities
   set closed_value = won_value
 where stage = 'won' and closed_value is null and won_value is not null;
