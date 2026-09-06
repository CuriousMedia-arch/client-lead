-- Delivery timeline: a start and an end, not a single due date.
-- Run after migrate-outreach-10.sql. Safe to re-run.
alter table opportunity_execution add column if not exists start_date date;

-- The old single date was the end of the work, so that is what it becomes.
update opportunity_execution
   set start_date = due_date
 where start_date is null and due_date is not null;

-- "Owner" read as the account owner. It is whoever is accountable for this
-- deliverable, on either side, so the column follows the label.
alter table opportunity_execution add column if not exists stakeholder text;

update opportunity_execution
   set stakeholder = owner_name
 where stakeholder is null and owner_name is not null;
