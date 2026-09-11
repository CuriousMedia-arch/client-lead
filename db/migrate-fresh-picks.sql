-- ---------------------------------------------------------------------------
-- Free contact unlocks become a CHOICE, not a handout.
--
-- Before this, claiming a company automatically opened its three most senior
-- contacts. Nobody chose them, so nobody owned the choice — and on a company
-- with four directors, which three you got came down to import order.
--
-- Now a claim grants an allowance of three free unlocks, banked against that
-- claim. The person holding it spends them on whoever they judge worth
-- reaching, one at a time, at any point while the claim is live. A spent pick
-- is final, and it is written to that company's activity log with the name of
-- the person who spent it.
--
-- Safe to re-run.
-- ---------------------------------------------------------------------------

-- How many free unlocks this claim was granted. Stored per claim rather than
-- read from credit_settings at spend time, so an admin changing the rule does
-- not silently hand extra picks to, or take them from, claims already running.
alter table fresh_claim_credits
  add column if not exists free_allowance integer not null default 0;

-- free_contact_ids changes meaning: it was "the three we picked for you",
-- it is now "the ones you have spent so far". For claims made under the old
-- behaviour those are the same thing, so their allowance is backfilled to
-- whatever they were given and they read as fully spent — which they were.
update fresh_claim_credits
   set free_allowance = coalesce(array_length(free_contact_ids, 1), 0)
 where free_allowance = 0;

-- The admin view lists every free pick ever spent, by lead. Without this it
-- is a sequential scan over every unlock in the system to build one page.
create index if not exists idx_contact_unlocks_lead
  on contact_unlocks (lead_id) where lead_id is not null;

create index if not exists idx_contact_unlocks_source
  on contact_unlocks (source) where source <> 'paid';
