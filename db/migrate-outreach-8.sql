-- ---------------------------------------------------------------------------
-- Migration: choose whose meeting summary appears.
--
-- Run after migrate-outreach-7.sql. Safe to re-run.
--
-- Fathom's summary or the portal's. A setting rather than a code change,
-- because it has a cost attached: Fathom's free plan caps advanced summaries
-- at five a month, so 'fathom' means paying for Premium for anyone who hosts
-- meetings. Being able to switch back without a deploy matters.
--
-- Note this only controls the PROSE shown in the notes box. The structured
-- fields — what they need, budget, timeline, objections, next step — are
-- always extracted from the transcript either way, because the funnel report
-- and the loss reasons read those fields, not the prose.
-- ---------------------------------------------------------------------------

alter table opportunity_meetings add column if not exists fathom_summary text;

insert into content_templates (key, label, hint, sort, body) values
  ('notes_source', 'Who writes the meeting summary',
   'Type "fathom" to use Fathom''s own summary (needs Fathom Premium past 5 meetings a month), or "portal" to have this app write it from the transcript. Either way, the structured fields the reports use are filled in automatically.',
   9, 'fathom')
on conflict (key) do nothing;
