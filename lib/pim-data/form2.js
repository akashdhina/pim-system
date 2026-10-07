/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL implementation of Phase 6 Batch 5I's Form II workflow -
 * Prepare -> Generate -> Issue/Dispatch, through SERVICE_PENDING. See
 * docs/phase6-batch5i-form2-migration.md.
 *
 * No-Storage document model: a PostgreSQL-generated Form-2 document is
 * never written to a permanent file (no Supabase Storage, no local
 * filesystem persistence - no fs.mkdirSync/fs.writeFileSync anywhere in
 * this file). Generate resolves and freezes the exact template values
 * used into render_data (JSONB) and stores only that plus metadata;
 * file_path is always NULL for a row this module writes - never a
 * fabricated path. Download re-renders the DOCX buffer on demand,
 * solely from that frozen snapshot, never from current (possibly
 * since-changed) live party/case/address data - so a historical version
 * always reproduces the same legally/business-relevant content it had
 * when generated, even after a later address correction or similar edit.
 *
 * Downstream postal-service follow-up (returned notices, address
 * correction, Final Notice re-service) is explicitly NOT part of this
 * batch - Issue creates only the FIRST pim_service_attempts row and
 * transitions the case to SERVICE_PENDING, exactly matching the existing
 * SQLite route's own atomic "Issue & Dispatch" action (see the Batch 5I
 * audit: the status transition and the service-attempt insert do not
 * cleanly separate in this codebase - they are one business action
 * behind one button).
 *
 * Concurrency: every mutating function here locks the row(s) its
 * invariant depends on (SELECT ... FOR UPDATE) BEFORE re-checking guards
 * and writing - the same "lock first, recheck after" pattern
 * lib/pim-data/pim-numbering.js already established, applied here to
 * three different invariants: one active Initial notice per
 * case+party+type (Prepare locks the case), one current document per
 * notice with a correct version sequence (Generate locks the notice),
 * and a notice can only be issued once (Issue locks the notice, then
 * re-reads the case).
 */

const path = require("path");
const { withTransaction, getSql } = require("../pim-postgres");
const { officeDate, officeTime } = require("../pim-time");
const { getStatusId, addStatusHistory, addDocket } = require("./workflow-helpers");
const { toWire } = require("./wire-compat");
const {
  renderForm2Template,
  buildForm2RenderValues,
  form2DocumentTitle,
} = require("../pim-document");

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "pim", "Form 2.docx");

const CASE_WIRE = { timestamps: ["updated_at", "created_at"] };
const PARTY_WIRE = { flags: ["is_primary"] };
const ADDRESS_WIRE = { flags: ["is_current"] };
const NOTICE_WIRE = { flags: ["document_has_render_data", "document_is_current", "contact_affidavit_received"] };
const TASK_WIRE = { flags: ["auto_generated"] };
const DOCUMENT_WIRE = { flags: ["generated_by_system", "is_current"], timestamps: ["created_at"] };

/*
 * This project's configured postgres.js client (lib/pim-postgres.js)
 * returns a jsonb column as a raw JSON STRING, not an auto-parsed
 * object (confirmed live - it is not merely unconfigured, the value
 * genuinely arrives as a string over the wire from this client).
 * Every reader of render_data must go through this, or a downstream
 * consumer that expects a plain object (docxtemplater's .render(),
 * a test asserting a property on it) silently gets `undefined` for
 * every key instead of a real value - not a thrown error, so it is
 * easy to miss.
 */
function parseRenderData(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? JSON.parse(value) : value;
}

function documentToWire(row) {
  if (!row) return row;
  return { ...toWire(row, DOCUMENT_WIRE), render_data: parseRenderData(row.render_data) };
}

// ---------------------------------------------------------------------
// GET loader - read-only, mirrors app/api/pim/form2/[id]/route.js's GET
// ---------------------------------------------------------------------

async function getCasePg(client, caseId) {
  const [row] = await client`
    SELECT c.*, s.code AS status_code, s.name AS status_name
    FROM pim_cases c
    LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
  `;
  return row ? toWire(row, CASE_WIRE) : null;
}

async function getOppositePartiesPg(client, caseId) {
  const parties = await client`
    SELECT
      cp.id AS case_party_id, cp.party_id, cp.role, cp.sequence_no, cp.is_primary,
      p.name, p.entity_type
    FROM pim_case_parties cp
    JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId}
      AND cp.role = 'OPPOSITE_PARTY'
      AND cp.active_to IS NULL
    ORDER BY cp.sequence_no, cp.id
  `;

  const out = [];
  for (const party of parties) {
    const addresses = await client`
      SELECT * FROM pim_addresses
      WHERE party_id = ${party.party_id} AND is_current = true
      ORDER BY
        CASE address_type
          WHEN 'POSTAL' THEN 1 WHEN 'REGISTERED_OFFICE' THEN 2 WHEN 'ALTERNATE' THEN 3 ELSE 4
        END,
        id
    `;
    const allAddresses = await client`
      SELECT * FROM pim_addresses
      WHERE party_id = ${party.party_id}
      ORDER BY is_current DESC, id DESC
    `;
    out.push({
      ...toWire(party, PARTY_WIRE),
      addresses: addresses.map((a) => toWire(a, ADDRESS_WIRE)),
      allAddresses: allAddresses.map((a) => toWire(a, ADDRESS_WIRE)),
    });
  }
  return out;
}

async function getFinalNoticeCandidatesPg(client, caseId) {
  const rows = await client`
    SELECT
      sa.id AS service_attempt_id, sa.return_reason, sa.postal_endorsement, sa.returned_date,
      n.id AS notice_id, n.notice_type, n.notice_date, n.appearance_date,
      n.recipient_party_id, n.address_id AS notice_address_id,
      p.name AS recipient_name
    FROM pim_service_attempts sa
    JOIN pim_notices n ON n.id = sa.notice_id
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    WHERE n.case_id = ${caseId}
      AND n.status = 'RETURNED'
      AND NOT EXISTS (
        SELECT 1 FROM pim_notices fresh
        WHERE fresh.case_id = n.case_id
          AND fresh.recipient_party_id = n.recipient_party_id
          AND fresh.notice_type = 'FORM_2_FINAL'
          AND fresh.id > n.id
      )
    ORDER BY sa.id DESC
  `;
  return rows;
}

async function getNoticesPg(client, caseId) {
  const rows = await client`
    SELECT
      n.*,
      p.name AS recipient_name,
      d.document_title, d.document_date,
      CASE WHEN d.render_data IS NOT NULL THEN true ELSE false END AS document_has_render_data,
      d.version_no AS document_version_no,
      d.is_current AS document_is_current,
      d.created_at AS document_created_at
    FROM pim_notices n
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    LEFT JOIN pim_documents d ON d.id = n.document_id AND d.case_id = n.case_id
    WHERE n.case_id = ${caseId}
    ORDER BY n.id DESC
  `;
  return rows.map((r) => toWire(r, NOTICE_WIRE));
}

async function getForm2TaskPg(client, caseId) {
  const [row] = await client`
    SELECT * FROM pim_tasks
    WHERE case_id = ${caseId}
      AND task_type_code IN ('FORM2', 'FINAL_NOTICE_FOLLOWUP')
      AND status = 'PENDING'
    ORDER BY id DESC
    LIMIT 1
  `;
  return row ? toWire(row, TASK_WIRE) : null;
}

async function getForm2DataPg(caseId) {
  const sql = getSql();

  const caseData = await getCasePg(sql, caseId);
  if (!caseData) return null;

  const [oppositeParties, notices, task] = await Promise.all([
    getOppositePartiesPg(sql, caseId),
    getNoticesPg(sql, caseId),
    getForm2TaskPg(sql, caseId),
  ]);

  const finalNoticeCandidates =
    caseData.status_code === "FINAL_NOTICE_PENDING"
      ? await getFinalNoticeCandidatesPg(sql, caseId)
      : [];

  return {
    case: caseData,
    oppositeParties,
    notices,
    task,
    finalNoticeCandidates,
  };
}

// ---------------------------------------------------------------------
// Prepare - one new pim_notices row + one docket entry. No document, no
// filesystem, no case-status transition (matches the existing route).
// ---------------------------------------------------------------------

const FRESH_NOTICE_APPEARANCE_WINDOW_DAYS = 10;

/*
 * Batch 5J: SOP clause 5(a) contact-particulars affidavit. Resolves the
 * two raw input fields into the pair this module actually stores,
 * enforcing the approved business invariant at the one place every
 * Prepare path (Initial via the direct INSERT below, Final via
 * createFreshNoticeTx) funnels through:
 *   - `received` must be the literal boolean `true` to count as
 *     received - never inferred from the mere presence of an address/
 *     phone/email, and never implicitly true when simply omitted.
 *   - when NOT received, the date is always discarded (NULL), even if
 *     the caller supplied one - "should normally be NULL" is enforced
 *     as a hard rule here, not left to caller discipline.
 *   - when received, the supplied date is kept (or NULL if the caller
 *     didn't supply one - clause 5(a)'s affidavit date is optional
 *     metadata, not a second required field).
 */
function resolveContactAffidavit(contactAffidavitReceived, contactAffidavitDate) {
  const received = contactAffidavitReceived === true;
  return { received, date: received ? (contactAffidavitDate || null) : null };
}

/*
 * PostgreSQL twin of lib/pim-fresh-notice.js's createFreshNotice -
 * same validation, same INSERT shape, `tx`-scoped (no default client,
 * matching every other Batch 5D+ workflow helper's convention: a
 * PostgreSQL transaction client has no single shared "default
 * connection" a caller could accidentally omit).
 */
async function createFreshNoticeTx(tx, {
  caseId, recipientPartyId, addressId, noticeType, noticeDate,
  appearanceDate, appearanceTime, preparedBy = null, remarks = null,
  contactAffidavitReceived = undefined, contactAffidavitDate = null,
}) {
  if (!caseId || !recipientPartyId || !addressId) {
    throw new Error("caseId, recipientPartyId and addressId are required to create a fresh notice.");
  }
  if (noticeType !== "FORM_2_INITIAL" && noticeType !== "FORM_2_FINAL") {
    throw new Error(`Invalid notice type for a fresh notice: ${noticeType}`);
  }
  if (!noticeDate) throw new Error("noticeDate is required to create a fresh notice.");
  if (!appearanceDate) throw new Error("Appearance date is required for the fresh notice.");
  if (!appearanceTime) throw new Error("Appearance time is required for the fresh notice.");

  const maxAppearanceDate = new Date(new Date(`${noticeDate}T00:00:00+05:30`).getTime());
  maxAppearanceDate.setUTCDate(maxAppearanceDate.getUTCDate() + FRESH_NOTICE_APPEARANCE_WINDOW_DAYS);
  const maxAppearanceDateStr = maxAppearanceDate.toISOString().slice(0, 10);
  if (appearanceDate > maxAppearanceDateStr) {
    throw new Error(
      `Appearance date for a fresh Initial Form-2 notice cannot be more than ${FRESH_NOTICE_APPEARANCE_WINDOW_DAYS} days after the notice date (${noticeDate}).`
    );
  }

  const [existing] = await tx`
    SELECT id FROM pim_notices
    WHERE case_id = ${caseId} AND recipient_party_id = ${recipientPartyId}
      AND notice_type = ${noticeType} AND status IN ('PREPARED', 'SIGNED', 'DISPATCHED')
    LIMIT 1
  `;
  if (existing) {
    throw new Error("An active Form-2 notice for this opposite party already exists.");
  }

  const affidavit = resolveContactAffidavit(contactAffidavitReceived, contactAffidavitDate);

  const [row] = await tx`
    INSERT INTO pim_notices
      (case_id, notice_type, form_no, notice_date, appearance_date, appearance_time,
       recipient_party_id, address_id, prepared_by, status, remarks,
       contact_affidavit_received, contact_affidavit_date)
    VALUES
      (${caseId}, ${noticeType}, 'FORM-2', ${noticeDate}, ${appearanceDate}, ${appearanceTime},
       ${recipientPartyId}, ${addressId}, ${preparedBy}, 'PREPARED', ${remarks},
       ${affidavit.received}, ${affidavit.date})
    RETURNING id
  `;
  return row.id;
}

async function prepareForm2NoticeTx(tx, caseId, input, userId) {
  const {
    partyId, addressId, appearanceDate, appearanceTime, noticeType, remarks,
    contactAffidavitReceived, contactAffidavitDate,
  } = input;

  // Lock the case row FIRST - two concurrent Prepare requests for this
  // case (a double-click, or two different opposite parties prepared in
  // quick succession) serialize here, so the duplicate-active-notice
  // check below can never race against a concurrent insert.
  const [caseRow] = await tx`
    SELECT id, current_status_id FROM pim_cases WHERE id = ${caseId} FOR UPDATE
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  const expectedStatusCode = noticeType === "FORM_2_FINAL" ? "FINAL_NOTICE_PENDING" : "FORM2_PENDING";
  const expectedStatusId = await getStatusId(tx, expectedStatusCode);

  if (caseRow.current_status_id !== expectedStatusId) {
    const [{ name: statusName }] = await tx`SELECT name FROM status_master WHERE id = ${caseRow.current_status_id}`;
    throw new Error(
      noticeType === "FORM_2_FINAL"
        ? `This case is not available for Final Notice preparation. Current status: ${statusName}`
        : `This case is not available for Form-2 preparation. Current status: ${statusName}`
    );
  }

  const [party] = await tx`
    SELECT cp.party_id, cp.role, p.name
    FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseId} AND cp.party_id = ${partyId}
      AND cp.role = 'OPPOSITE_PARTY' AND cp.active_to IS NULL
  `;
  if (!party) throw new Error("Selected party is not an active opposite party in this case.");

  const address =
    noticeType === "FORM_2_FINAL"
      ? (await tx`SELECT * FROM pim_addresses WHERE id = ${addressId} AND party_id = ${partyId}`)[0]
      : (await tx`SELECT * FROM pim_addresses WHERE id = ${addressId} AND party_id = ${partyId} AND is_current = true`)[0];

  if (!address) {
    throw new Error(
      noticeType === "FORM_2_FINAL"
        ? "Selected address does not belong to this opposite party."
        : "Selected address is not a current address of the opposite party."
    );
  }

  const [existing] = await tx`
    SELECT id FROM pim_notices
    WHERE case_id = ${caseId} AND recipient_party_id = ${partyId} AND notice_type = ${noticeType}
      AND status IN ('PREPARED', 'SIGNED', 'DISPATCHED')
    LIMIT 1
  `;
  if (existing) {
    throw new Error(
      noticeType === "FORM_2_FINAL"
        ? "A Final Notice for this opposite party already exists."
        : "A Form-2 notice for this opposite party already exists."
    );
  }

  let noticeId;
  if (noticeType === "FORM_2_FINAL") {
    noticeId = await createFreshNoticeTx(tx, {
      caseId, recipientPartyId: partyId, addressId, noticeType: "FORM_2_FINAL",
      noticeDate: officeDate(), appearanceDate, appearanceTime,
      preparedBy: userId, remarks: remarks || null,
      contactAffidavitReceived, contactAffidavitDate,
    });
  } else {
    const affidavit = resolveContactAffidavit(contactAffidavitReceived, contactAffidavitDate);

    const [row] = await tx`
      INSERT INTO pim_notices
        (case_id, notice_type, form_no, notice_date, appearance_date, appearance_time,
         recipient_party_id, address_id, prepared_by, status, remarks,
         contact_affidavit_received, contact_affidavit_date)
      VALUES
        (${caseId}, ${noticeType}, 'FORM-2', ${officeDate()}, ${appearanceDate}, ${appearanceTime},
         ${partyId}, ${addressId}, ${userId}, 'PREPARED', ${remarks || null},
         ${affidavit.received}, ${affidavit.date})
      RETURNING id
    `;
    noticeId = row.id;
  }

  await addDocket(
    tx, caseId, "FORM2_PREPARED",
    noticeType === "FORM_2_FINAL"
      ? `Final Form-2 notice prepared for opposite party ${party.name}.`
      : `Form-2 prepared for opposite party ${party.name}.`,
    "Form-2 issue / dispatch", null, userId
  );

  return {
    noticeId, caseId, partyId, addressId, appearanceDate, appearanceTime,
    noticeType, status: "PREPARED",
  };
}

async function prepareForm2NoticePg(caseId, input, userId) {
  return withTransaction((tx) => prepareForm2NoticeTx(tx, caseId, input, userId));
}

// ---------------------------------------------------------------------
// Generate - resolves render_data once, stores it + metadata. No
// document buffer is rendered at this step (rendering is deferred
// entirely to Download) and no file is ever written.
// ---------------------------------------------------------------------

async function resolveForm2RenderInputsTx(tx, noticeId) {
  const [notice] = await tx`
    SELECT
      n.*, c.pim_number, c.received_number, c.application_date, c.registration_date,
      p.name AS recipient_name, su.display_name AS signed_by_name, su.designation AS signed_by_designation
    FROM pim_notices n
    JOIN pim_cases c ON c.id = n.case_id
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    LEFT JOIN users su ON su.id = n.signed_by
    WHERE n.id = ${noticeId}
  `;
  if (!notice) throw new Error("Form-2 notice record was not found.");
  if (notice.form_no !== "FORM-2") throw new Error("The selected notice is not a Form-2 notice.");
  if (notice.notice_type !== "FORM_2_INITIAL" && notice.notice_type !== "FORM_2_FINAL") {
    throw new Error(`Unsupported Form-2 notice type for document generation: ${notice.notice_type}`);
  }

  const [applicant] = await tx`
    SELECT p.id, p.name
    FROM pim_case_parties cp JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${notice.case_id} AND cp.role = 'APPLICANT' AND cp.is_primary = true
    ORDER BY cp.sequence_no, cp.id LIMIT 1
  `;
  if (!applicant) throw new Error("Primary applicant was not found.");

  if (!notice.recipient_party_id || !notice.recipient_name) {
    throw new Error("Form-2 recipient opposite party was not found.");
  }

  let address = null;
  if (notice.address_id) {
    [address] = await tx`SELECT * FROM pim_addresses WHERE id = ${notice.address_id}`;
  }
  if (!address) {
    [address] = await tx`
      SELECT * FROM pim_addresses
      WHERE party_id = ${notice.recipient_party_id} AND is_current = true
      ORDER BY
        CASE address_type
          WHEN 'POSTAL' THEN 1 WHEN 'REGISTERED_OFFICE' THEN 2 WHEN 'ALTERNATE' THEN 3 ELSE 4
        END, id
      LIMIT 1
    `;
  }

  return {
    notice,
    applicant,
    oppositeParty: { id: notice.recipient_party_id, name: notice.recipient_name },
    address: address || null,
  };
}

async function generateForm2DocumentTx(tx, noticeId, { regenerate = false } = {}, userId) {
  // Lock the notice row FIRST: this serializes concurrent Generate calls
  // for the SAME notice, which fixes two races at once - a plain
  // MAX(version_no)+1 read is only safe because nothing else can be
  // reading/writing pim_documents for this notice at the same time, and
  // two concurrent non-regenerate calls will have the second one see the
  // first's committed document and correctly short-circuit to reused.
  const [notice] = await tx`
    SELECT id, case_id, document_id FROM pim_notices WHERE id = ${noticeId} FOR UPDATE
  `;
  if (!notice) throw new Error("Form-2 notice record was not found.");

  let linkedDocument = null;
  if (notice.document_id) {
    [linkedDocument] = await tx`
      SELECT * FROM pim_documents
      WHERE id = ${notice.document_id} AND case_id = ${notice.case_id}
        AND document_type IN ('FORM_2', 'FORM2')
    `;
  }

  if (!regenerate && linkedDocument && linkedDocument.render_data) {
    return { reused: true, caseId: notice.case_id, noticeId, document: documentToWire(linkedDocument) };
  }

  const data = await resolveForm2RenderInputsTx(tx, noticeId);
  const renderData = buildForm2RenderValues(data);
  const documentTitle = form2DocumentTitle(data);

  const [{ next_version: versionNo }] = await tx`
    SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
    FROM pim_documents
    WHERE notice_id = ${noticeId} AND document_type IN ('FORM_2', 'FORM2')
  `;

  await tx`
    UPDATE pim_documents SET is_current = false
    WHERE notice_id = ${noticeId} AND document_type IN ('FORM_2', 'FORM2') AND is_current = true
  `;

  const remarksText =
    linkedDocument && !linkedDocument.render_data
      ? "Generated Form-2 render data for existing document row with no stored render inputs."
      : regenerate
        ? "Regenerated official Form-2 notice."
        : "Generated official Form-2 notice.";

  /*
   * render_data is inserted as an explicit ::jsonb cast over a plain
   * JSON string parameter, rather than relying on postgres.js to infer
   * a jsonb type for a bare JS object (it does not - a plain object has
   * no special-cased serializer, see node_modules/postgres's inferType).
   * Reads do NOT come back auto-parsed on this project's configured
   * client (confirmed live) - a jsonb column arrives as a raw JSON
   * string, so every reader goes through parseRenderData()/
   * documentToWire() below, never `row.render_data` directly.
   */
  const [document] = await tx`
    INSERT INTO pim_documents
      (case_id, notice_id, document_type, document_title, document_date, file_path,
       generated_by_system, version_no, is_current, remarks, created_by, render_data)
    VALUES
      (${notice.case_id}, ${noticeId}, 'FORM_2', ${documentTitle}, ${data.notice.notice_date || officeDate()},
       NULL, true, ${versionNo}, true, ${remarksText}, ${userId}, ${JSON.stringify(renderData)}::jsonb)
    RETURNING *
  `;

  await tx`UPDATE pim_notices SET document_id = ${document.id} WHERE id = ${noticeId}`;

  return { reused: false, caseId: notice.case_id, noticeId, document: documentToWire(document) };
}

async function generateForm2DocumentPg(noticeId, options, userId) {
  return withTransaction((tx) => generateForm2DocumentTx(tx, noticeId, options, userId));
}

// ---------------------------------------------------------------------
// Download - renders solely from the frozen render_data snapshot. No
// file_path, no live party/address/case re-read, no filesystem access.
// ---------------------------------------------------------------------

async function downloadForm2DocumentPg(caseId, documentId) {
  const sql = getSql();
  const [document] = await sql`
    SELECT * FROM pim_documents
    WHERE id = ${documentId} AND case_id = ${caseId}
      AND document_type IN ('FORM_2', 'FORM2')
  `;
  if (!document) return null;

  const wired = documentToWire(document);
  if (!wired.render_data) return { document: wired, buffer: null };

  const buffer = renderForm2Template(TEMPLATE_PATH, wired.render_data);
  const fileName = `FORM-2-N${document.notice_id}-v${document.version_no}.docx`;

  return { document: wired, buffer, fileName };
}

// ---------------------------------------------------------------------
// Issue/dispatch - through SERVICE_PENDING only. Downstream postal-
// service follow-up is a later batch (see the Batch 5I audit).
// ---------------------------------------------------------------------

async function issueForm2NoticeTx(tx, caseId, input, userId) {
  const { noticeId, addressId, dispatchMode = "REGISTERED_POST", postalReceiptNo = null, trackingNo = null, remarks = null } = input;

  // Lock the notice row FIRST - a same-notice double-click/concurrent
  // Issue serializes here; the loser re-reads notice.status after the
  // winner commits and correctly rejects on the ordinary "already
  // dispatched" guard below, never reaching a second service-attempt
  // insert, a second status-history pair, or a second task completion.
  const [notice] = await tx`
    SELECT n.*, p.name AS recipient_name,
           d.id AS generated_document_id, d.render_data AS generated_render_data
    FROM pim_notices n
    LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
    LEFT JOIN pim_documents d ON d.id = n.document_id AND d.case_id = n.case_id
    WHERE n.id = ${noticeId} AND n.case_id = ${caseId}
    FOR UPDATE OF n
  `;
  if (!notice) throw new Error("Form-2 notice not found.");

  const [caseRow] = await tx`
    SELECT c.id, c.current_status_id, s.name AS status_name
    FROM pim_cases c LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE c.id = ${caseId}
    FOR UPDATE OF c
  `;
  if (!caseRow) throw new Error("PIM case not found.");

  const isFinal = notice.notice_type === "FORM_2_FINAL";
  const pendingStatusCode = isFinal ? "FINAL_NOTICE_PENDING" : "FORM2_PENDING";
  const issuedStatusCode = isFinal ? "FINAL_NOTICE_ISSUED" : "FORM2_ISSUED";
  const pendingStatusId = await getStatusId(tx, pendingStatusCode);

  if (caseRow.current_status_id !== pendingStatusId) {
    throw new Error(
      isFinal
        ? `This case is not available for Final Notice issue. Current status: ${caseRow.status_name}`
        : `This case is not available for Form-2 issue. Current status: ${caseRow.status_name}`
    );
  }

  if (notice.status !== "PREPARED") {
    return { conflict: true, message: `This notice cannot be issued. Current notice status: ${notice.status}` };
  }

  if (!notice.generated_document_id || !notice.generated_render_data) {
    throw new Error(
      isFinal
        ? "Generate the official Final Notice document before issuing and dispatching this notice."
        : "Generate the official Form-2 document before issuing and dispatching this notice."
    );
  }

  let resolvedAddressId;
  if (isFinal) {
    if (!notice.address_id) {
      throw new Error("This Final Notice has no address on record. Re-prepare it with a selected address.");
    }
    resolvedAddressId = notice.address_id;
  } else {
    if (!Number.isInteger(addressId) || addressId <= 0) {
      throw new Error("Service address is required.");
    }
    const [address] = await tx`
      SELECT * FROM pim_addresses
      WHERE id = ${addressId} AND party_id = ${notice.recipient_party_id} AND is_current = true
    `;
    if (!address) throw new Error("Selected address is not a current address of the notice recipient.");
    resolvedAddressId = addressId;
  }

  await tx`
    UPDATE pim_notices
    SET status = 'DISPATCHED', dispatch_date = ${officeDate()}, remarks = COALESCE(${remarks}, remarks)
    WHERE id = ${noticeId}
  `;

  const [service] = await tx`
    INSERT INTO pim_service_attempts
      (notice_id, address_id, dispatch_mode, dispatch_date, postal_receipt_no, tracking_no, remarks)
    VALUES
      (${noticeId}, ${resolvedAddressId}, ${dispatchMode}, ${officeDate()}, ${postalReceiptNo}, ${trackingNo}, ${remarks})
    RETURNING id
  `;

  const issuedStatusId = await getStatusId(tx, issuedStatusCode);
  const servicePendingStatusId = await getStatusId(tx, "SERVICE_PENDING");

  await addStatusHistory(
    tx, caseId, pendingStatusId, issuedStatusId,
    isFinal ? "Final Notice issued/dispatched for service." : "Form-2 issued/dispatched for service.",
    userId
  );
  await addStatusHistory(
    tx, caseId, issuedStatusId, servicePendingStatusId,
    isFinal ? "Final Notice dispatch recorded; service pending." : "Form-2 dispatch recorded; service pending.",
    userId
  );

  await tx`
    UPDATE pim_cases SET current_status_id = ${servicePendingStatusId}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${caseId}
  `;

  await addDocket(
    tx, caseId, isFinal ? "FINAL_NOTICE" : "FORM2_DISPATCHED",
    isFinal
      ? `Final Notice dispatched to ${notice.recipient_name || "opposite party"}.`
      : `Form-2 dispatched to ${notice.recipient_name || "opposite party"}.`,
    "Service pending", null, userId
  );

  // Guarded completion (same invariant as lib/pim-data/scrutiny.js's
  // completeTaskPg): WHERE status='PENDING' + a row-count check, so this
  // can never double-complete even if something outside this notice's
  // own lock somehow raced it.
  const taskTypeCode = isFinal ? "FINAL_NOTICE_FOLLOWUP" : "FORM2";
  const [task] = await tx`
    SELECT id, status FROM pim_tasks
    WHERE case_id = ${caseId} AND task_type_code = ${taskTypeCode} AND status = 'PENDING'
    ORDER BY id DESC LIMIT 1
  `;
  if (task) {
    const updated = await tx`
      UPDATE pim_tasks
      SET status = 'COMPLETED', completed_date = ${officeDate()}, completed_time = ${officeTime()}, completed_by = ${userId}
      WHERE id = ${task.id} AND status = 'PENDING'
      RETURNING id
    `;
    if (updated.length === 1) {
      await tx`
        INSERT INTO pim_task_history (task_id, old_status, new_status, changed_by, remarks)
        VALUES (${task.id}, 'PENDING', 'COMPLETED', ${userId},
          ${isFinal ? "Final Notice issued and dispatch recorded." : "Form-2 issued and dispatch recorded."})
      `;
    }
  }

  return {
    caseId, noticeId, documentId: notice.generated_document_id,
    serviceAttemptId: service.id, dispatchDate: officeDate(), dispatchMode,
    statusCode: "SERVICE_PENDING",
  };
}

async function issueForm2NoticePg(caseId, input, userId) {
  return withTransaction((tx) => issueForm2NoticeTx(tx, caseId, input, userId));
}

module.exports = {
  getForm2DataPg,
  resolveContactAffidavit,
  createFreshNoticeTx,
  prepareForm2NoticeTx,
  prepareForm2NoticePg,
  resolveForm2RenderInputsTx,
  generateForm2DocumentTx,
  generateForm2DocumentPg,
  downloadForm2DocumentPg,
  issueForm2NoticeTx,
  issueForm2NoticePg,
};
