-- ---------------------------------------------------------------------------
-- Migration: Fresh claims are company-level.
--
-- Run after migrate-outreach-2.sql. Safe to re-run.
--
-- The model this enforces:
--
--   An All Leads claim is a claim on a PERSON. It stands on its own and gets
--   its own opportunity in My Outreach.
--
--   A Fresh Leads claim is a claim on a COMPANY, for that company's news
--   window. Its contacts come along for the ride and go back when the window
--   closes. They are not separate claims and must not become separate
--   opportunities — one Fresh company with five contacts is ONE thing to work,
--   not six.
-- ---------------------------------------------------------------------------

-- Which person we're currently talking to on a company-level opportunity.
--
-- Deliberately NOT reusing contact_id: that column means "this opportunity IS
-- an All Leads claim on this person" and carries a unique index enforcing one
-- opportunity per claim. Overloading it would make a Fresh opportunity
-- indistinguishable from a personal claim and collide the moment two Fresh
-- opportunities pointed at contacts of the same company.
alter table opportunities
  add column if not exists focus_contact_id bigint references company_contacts(id) on delete set null;

create index if not exists idx_opp_focus on opportunities (focus_contact_id)
  where focus_contact_id is not null;

-- --- clean up what the old behaviour created --------------------------------
-- Every contact swept up by a Fresh claim was given its own opportunity. Those
-- are the duplicate cards. Delete only the ones nobody has done anything on —
-- no messages, no meetings, no proposals, no price — so no real work is lost.
-- Anything that HAS been worked is left alone and can be tidied by hand.
delete from opportunities o
 where o.contact_id is not null
   and exists (
     select 1 from company_contacts cc
      where cc.id = o.contact_id and cc.claim_source = 'fresh'
   )
   and o.last_contacted_at is null
   and o.quoted_price is null
   and not exists (select 1 from opportunity_messages  m where m.opportunity_id = o.id)
   and not exists (select 1 from opportunity_meetings  m where m.opportunity_id = o.id)
   and not exists (select 1 from opportunity_proposals p where p.opportunity_id = o.id);
