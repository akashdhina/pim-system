-- Phase 6 Batch 5J: SOP clause 5(a) contact-particulars affidavit
-- (notice-level: the affidavit attests to the contact details used to
-- serve THIS specific notice, not a case-level or party-level fact).
alter table pim_notices
  add column if not exists contact_affidavit_received boolean,
  add column if not exists contact_affidavit_date date;

-- NO_CORRECTED_ADDRESS was previously created ad hoc by the SQLite
-- route's own INSERT OR IGNORE on first use; pre-seeded here as proper
-- master data (additive, matching every other event_types row's
-- convention), consistent with every other batch's practice of not
-- writing master data as a side effect of a business transaction.
insert into event_types (id, code, name, category, active)
overriding system value
values (69, 'NO_CORRECTED_ADDRESS', 'No Corrected Address Available', 'NOTICE', true)
on conflict (id) do nothing;

select setval(pg_get_serial_sequence('event_types', 'id'), (select max(id) from event_types));
