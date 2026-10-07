const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  createFreshNotice,
} = require("../../../../../lib/pim-fresh-notice");
const {
  getForm2DataPg,
  prepareForm2NoticePg,
} = require("../../../../../lib/pim-data/form2");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getCase(caseId) {
  return db
    .prepare(`
      SELECT
        c.*,
        s.code AS status_code,
        s.name AS status_name
      FROM pim_cases c
      LEFT JOIN status_master s
        ON s.id = c.current_status_id
      WHERE c.id = ?
    `)
    .get(caseId);
}

/*
 * The ORIGINAL SQLite GET-path helpers below (getOppositeParties,
 * getFinalNoticeCandidates, getNotices, getForm2Task) are kept unused as
 * an instant rollback and as the authentic SQLite baseline for
 * scripts/test-pim-form2-postgres.js. Not called by GET (Batch 5I
 * migrated it to lib/pim-data/form2.js's getForm2DataPg). getCase stays
 * in active use below, by the kept prepareForm2Sqlite POST baseline.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getOppositeParties(caseId) {
  const parties = db
    .prepare(`
      SELECT
        cp.id AS case_party_id,
        cp.party_id,
        cp.role,
        cp.sequence_no,
        cp.is_primary,
        p.name,
        p.entity_type
      FROM pim_case_parties cp
      JOIN pim_parties p
        ON p.id = cp.party_id
      WHERE cp.case_id = ?
        AND cp.role = 'OPPOSITE_PARTY'
        AND cp.active_to IS NULL
      ORDER BY cp.sequence_no, cp.id
    `)
    .all(caseId);

  return parties.map((party) => {
    const addresses = db
      .prepare(`
        SELECT *
        FROM pim_addresses
        WHERE party_id = ?
          AND is_current = 1
        ORDER BY
          CASE address_type
            WHEN 'POSTAL' THEN 1
            WHEN 'REGISTERED_OFFICE' THEN 2
            WHEN 'ALTERNATE' THEN 3
            ELSE 4
          END,
          id
      `)
      .all(party.party_id);

    /*
     * Final Notice may legitimately need a superseded address
     * (e.g. UNCLAIMED/REFUSED_BY_ADDRESSEE reuse the exact
     * address the returned notice was sent to). Current-only
     * `addresses` above remains the Initial-notice default;
     * `allAddresses` lets the Final Notice UI offer every
     * address on record for this party.
     */
    const allAddresses = db
      .prepare(`
        SELECT *
        FROM pim_addresses
        WHERE party_id = ?
        ORDER BY is_current DESC, id DESC
      `)
      .all(party.party_id);

    return {
      ...party,
      addresses,
      allAddresses,
    };
  });
}

/*
 * Returned notices for this case that have not yet had a Final
 * Notice prepared for the same recipient party. Mirrors the
 * Phase 2 address-correction candidate query - never silently
 * picks "the latest" when more than one remains; the caller
 * must select one explicitly.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getFinalNoticeCandidates(caseId) {
  return db
    .prepare(`
      SELECT
        sa.id AS service_attempt_id,
        sa.return_reason,
        sa.postal_endorsement,
        sa.returned_date,
        n.id AS notice_id,
        n.notice_type,
        n.notice_date,
        n.appearance_date,
        n.recipient_party_id,
        n.address_id AS notice_address_id,
        p.name AS recipient_name
      FROM pim_service_attempts sa
      JOIN pim_notices n ON n.id = sa.notice_id
      LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
      WHERE n.case_id = ?
        AND n.status = 'RETURNED'
        AND NOT EXISTS (
          SELECT 1
          FROM pim_notices fresh
          WHERE fresh.case_id = n.case_id
            AND fresh.recipient_party_id = n.recipient_party_id
            AND fresh.notice_type = 'FORM_2_FINAL'
            AND fresh.id > n.id
        )
      ORDER BY sa.id DESC
    `)
    .all(caseId);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getNotices(caseId) {
  return db
    .prepare(`
      SELECT
        n.*,
        p.name AS recipient_name,
        d.document_title,
        d.document_date,
        d.file_path AS document_file_path,
        CASE
          WHEN d.file_path IS NOT NULL
            AND d.file_path <> ''
          THEN 1
          ELSE 0
        END AS document_has_file,
        d.version_no AS document_version_no,
        d.is_current AS document_is_current,
        d.created_at AS document_created_at
      FROM pim_notices n
      LEFT JOIN pim_parties p
        ON p.id = n.recipient_party_id
      LEFT JOIN pim_documents d
        ON d.id = n.document_id
       AND d.case_id = n.case_id
      WHERE n.case_id = ?
      ORDER BY n.id DESC
    `)
    .all(caseId);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getForm2Task(caseId) {
  return db
    .prepare(`
      SELECT *
      FROM pim_tasks
      WHERE case_id = ?
        AND task_type_code IN ('FORM2', 'FINAL_NOTICE_FOLLOWUP')
        AND status = 'PENDING'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(caseId);
}

function getEventId(code) {
  const row = db
    .prepare(
      "SELECT id FROM event_types WHERE code = ?"
    )
    .get(code);

  if (!row) {
    throw new Error(
      `Event not found: ${code}`
    );
  }

  return row.id;
}

function addDocket(
  caseId,
  eventCode,
  entryText,
  actionRequired = null,
  nextDate = null,
  userId = null
) {
  const eventId = getEventId(eventCode);

  db.prepare(`
    INSERT INTO pim_docket
    (
      case_id,
      docket_date,
      event_type_id,
      entry_text,
      action_required,
      next_date,
      entered_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    caseId,
    today(),
    eventId,
    entryText,
    actionRequired,
    nextDate,
    userId
  );
}

export async function GET(request, { params }) {
  try {
    requirePermission(request, "READ_CASE");

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    // Batch 5I (Phase 6): migrated to PostgreSQL via lib/pim-data/form2.js.
    const data = await getForm2DataPg(caseId);

    if (!data) {
      return Response.json(
        {
          success: false,
          message: "PIM case not found.",
        },
        { status: 404 }
      );
    }

    return Response.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(
      "Form-2 GET error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load Form-2 data.",
      },
      { status: 500 }
    );
  }
}

/*
 * The ORIGINAL SQLite POST body, kept unused as an instant rollback and
 * as the authentic SQLite baseline for scripts/test-pim-form2-postgres.js
 * (same convention as every prior batch's kept -Sqlite function). Not
 * called by POST.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function prepareForm2Sqlite(caseId, { partyId, addressId, appearanceDate, appearanceTime, noticeType, remarks }, userId) {
  return db.transaction(() => {
    const caseData = getCase(caseId);

    if (!caseData) {
      throw new Error("PIM case not found.");
    }

    const expectedStatus = noticeType === "FORM_2_FINAL" ? "FINAL_NOTICE_PENDING" : "FORM2_PENDING";

    if (caseData.status_code !== expectedStatus) {
      throw new Error(
        noticeType === "FORM_2_FINAL"
          ? `This case is not available for Final Notice preparation. Current status: ${caseData.status_name}`
          : `This case is not available for Form-2 preparation. Current status: ${caseData.status_name}`
      );
    }

    const party = db.prepare(`
      SELECT cp.party_id, cp.role, p.name
      FROM pim_case_parties cp
      JOIN pim_parties p ON p.id = cp.party_id
      WHERE cp.case_id = ? AND cp.party_id = ? AND cp.role = 'OPPOSITE_PARTY' AND cp.active_to IS NULL
    `).get(caseId, partyId);

    if (!party) {
      throw new Error("Selected party is not an active opposite party in this case.");
    }

    const address =
      noticeType === "FORM_2_FINAL"
        ? db.prepare(`SELECT * FROM pim_addresses WHERE id = ? AND party_id = ?`).get(addressId, partyId)
        : db.prepare(`SELECT * FROM pim_addresses WHERE id = ? AND party_id = ? AND is_current = 1`).get(addressId, partyId);

    if (!address) {
      throw new Error(
        noticeType === "FORM_2_FINAL"
          ? "Selected address does not belong to this opposite party."
          : "Selected address is not a current address of the opposite party."
      );
    }

    const existing = db.prepare(`
      SELECT id FROM pim_notices
      WHERE case_id = ? AND recipient_party_id = ? AND notice_type = ?
        AND status IN ('PREPARED', 'SIGNED', 'DISPATCHED')
      LIMIT 1
    `).get(caseId, partyId, noticeType);

    if (existing) {
      throw new Error(
        noticeType === "FORM_2_FINAL"
          ? "A Final Notice for this opposite party already exists."
          : "A Form-2 notice for this opposite party already exists."
      );
    }

    let noticeId;

    if (noticeType === "FORM_2_FINAL") {
      noticeId = createFreshNotice({
        caseId, recipientPartyId: partyId, addressId, noticeType: "FORM_2_FINAL",
        noticeDate: today(), appearanceDate, appearanceTime, preparedBy: userId, remarks: remarks || null,
      });
    } else {
      const notice = db.prepare(`
        INSERT INTO pim_notices
          (case_id, notice_type, form_no, notice_date, appearance_date, appearance_time,
           recipient_party_id, address_id, prepared_by, status, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(caseId, noticeType, "FORM-2", today(), appearanceDate, appearanceTime, partyId, addressId, userId, "PREPARED", remarks || null);

      noticeId = Number(notice.lastInsertRowid);
    }

    addDocket(
      caseId, "FORM2_PREPARED",
      noticeType === "FORM_2_FINAL"
        ? `Final Form-2 notice prepared for opposite party ${party.name}.`
        : `Form-2 prepared for opposite party ${party.name}.`,
      "Form-2 issue / dispatch", null, userId
    );

    return { noticeId, caseId, partyId, addressId, appearanceDate, appearanceTime, noticeType, status: "PREPARED" };
  })();
}

export async function POST(request, { params }) {
  try {
    const user = requirePermission(
      request,
      "ISSUE_NOTICE"
    );

    const { id } = await params;
    const caseId = Number(id);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return Response.json(
        {
          success: false,
          message: "Invalid case ID.",
        },
        { status: 400 }
      );
    }

    const body = await request.json();

    const partyId = Number(
      body.partyId
    );

    const addressId = Number(
      body.addressId
    );

    const appearanceDate =
      String(
        body.appearanceDate || ""
      ).trim();

    const appearanceTime =
      String(
        body.appearanceTime || ""
      ).trim();

    const noticeType =
      body.noticeType === "FORM_2_FINAL"
        ? "FORM_2_FINAL"
        : "FORM_2_INITIAL";

    if (
      !Number.isInteger(partyId) ||
      partyId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Opposite party is required.",
        },
        { status: 400 }
      );
    }

    if (
      !Number.isInteger(addressId) ||
      addressId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Service address is required.",
        },
        { status: 400 }
      );
    }

    if (!appearanceDate) {
      return Response.json(
        {
          success: false,
          message:
            "Appearance date is required.",
        },
        { status: 400 }
      );
    }

    if (!appearanceTime) {
      return Response.json(
        {
          success: false,
          message:
            "Appearance time is required.",
        },
        { status: 400 }
      );
    }

    // Batch 5I (Phase 6): migrated to PostgreSQL via lib/pim-data/form2.js.
    // Batch 5J: SOP clause 5(a) contact-particulars affidavit, captured
    // at Prepare time (see lib/pim-data/form2.js's resolveContactAffidavit
    // for the enforced invariant - never silently defaulted to received).
    const result = await prepareForm2NoticePg(caseId, {
      partyId, addressId, appearanceDate, appearanceTime, noticeType,
      remarks: body.remarks || null,
      contactAffidavitReceived: body.contactAffidavitReceived === true,
      contactAffidavitDate: body.contactAffidavitDate || null,
    }, user.id);

    return Response.json({
      success: true,
      message:
        "Form-2 prepared successfully.",
      data: result,
    });
  } catch (error) {
    console.error(
      "Form-2 POST error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to prepare Form-2.",
      },
      { status: 400 }
    );
  }
}
