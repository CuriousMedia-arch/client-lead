-- ---------------------------------------------------------------------------
-- Migration: an overall delivery timeline.
-- Run after migrate-outreach-10.sql. Safe to re-run.
--
-- Each deliverable already carries its own due date. This is the engagement's
-- timeline as a whole — "6 weeks from signing", "Sept to Nov" — which is what
-- gets written into a proposal and agreed with the client, and is not the same
-- thing as a list of individual dates.
-- ---------------------------------------------------------------------------

alter table opportunities add column if not exists delivery_timeline text;
