/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../lib/db");
const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  officeDate,
} = require("../../../../lib/pim-time");
const {
  listMediators,
} = require("../../../../lib/pim-data/mediators");
const {
  checkDuplicateActiveEnrollmentPg,
  createMediatorPg,
} = require("../../../../lib/pim-data/mediator-registry");

function positiveInt(value, fallback, max = 100) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    return fallback;
  }

  return Math.min(number, max);
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function validateEmail(email) {
  return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return !phone || /^[0-9+\-\s()]{6,20}$/.test(phone);
}

function validationError(message) {
  return Response.json(
    {
      success: false,
      message,
    },
    { status: 400 }
  );
}

function conflict(message) {
  return Response.json(
    {
      success: false,
      message,
    },
    { status: 409 }
  );
}

function parseMediatorBody(body) {
  const name = clean(body.name);
  const enrollmentNo = clean(body.enrollmentNo);
  const category = clean(body.category) || "ADVOCATE MEDIATOR";
  const contactPhone = clean(body.contactPhone);
  const email = clean(body.email);
  const empanelmentOrderNo = clean(body.empanelmentOrderNo);
  const empanelmentDate = clean(body.empanelmentDate);
  const panelValidUntil = clean(body.panelValidUntil);
  const rotationOrder =
    body.rotationOrder === "" ||
    body.rotationOrder === null ||
    body.rotationOrder === undefined
      ? null
      : Number(body.rotationOrder);
  const conflictDeclarationDate = clean(body.conflictDeclarationDate);
  const remarks = clean(body.remarks);
  const active = body.active === false || body.active === 0 ? 0 : 1;

  return {
    name,
    enrollmentNo,
    category,
    contactPhone,
    email,
    empanelmentOrderNo,
    empanelmentDate,
    panelValidUntil,
    rotationOrder,
    conflictDeclarationDate,
    remarks,
    active,
  };
}

function validateMediatorInput(input, { partial = false } = {}) {
  if (!partial && !input.name) {
    return "Mediator name is required.";
  }

  if (input.name !== undefined && !input.name) {
    return "Mediator name is required.";
  }

  if (!partial && !input.category) {
    return "Category is required.";
  }

  if (input.category !== undefined && !input.category) {
    return "Category is required.";
  }

  // Batch 5H-a (Phase 6) mediator-panel reconciliation: enrollment number is
  // NOT a mandatory mediator field (the DB schema has never required it, and
  // the two real pre-existing mediator records already have enrollment_no
  // NULL - see docs/phase6-batch5h-mediator-registry-migration.md). It is
  // validated only when supplied, never required.
  if (!validatePhone(input.contactPhone)) {
    return "Phone number is not valid.";
  }

  if (!validateEmail(input.email)) {
    return "Email address is not valid.";
  }

  if (
    input.rotationOrder !== null &&
    input.rotationOrder !== undefined &&
    (!Number.isInteger(input.rotationOrder) || input.rotationOrder < 0)
  ) {
    return "Rotation order must be a whole number.";
  }

  if (
    input.empanelmentDate &&
    input.panelValidUntil &&
    input.panelValidUntil < input.empanelmentDate
  ) {
    return "Panel valid until cannot be before empanelment date.";
  }

  return null;
}

// The ORIGINAL SQLite duplicate-enrollment check, kept unused as an instant rollback.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function duplicateActiveEnrollmentSqlite(enrollmentNo, exceptId = null) {
  if (!enrollmentNo) return null;

  return db.prepare(`
    SELECT id, name
    FROM mediators
    WHERE active = 1
      AND enrollment_no = ?
      AND (? IS NULL OR id <> ?)
    LIMIT 1
  `).get(enrollmentNo, exceptId, exceptId);
}

/*
 * Batch 1 (Phase 6): the SQLite query builder below is kept, unused by
 * GET now, purely as an instant rollback - if the PostgreSQL path
 * (lib/pim-data/mediators.js) needs to be reverted, restoring the three
 * lines it replaced in GET is a 1-line diff, not a lost-code problem.
 * Batch 5H migrated POST to PostgreSQL (lib/pim-data/mediator-registry.js);
 * the SQLite insert logic below is kept as postSqlite, unused, for the
 * same rollback purpose.
 */
function mediatorListQuery(searchParams) {
  const page = positiveInt(searchParams.get("page"), 1, 100000);
  const pageSize = positiveInt(searchParams.get("pageSize"), 20, 100);
  const offset = (page - 1) * pageSize;
  const where = [];
  const params = [];
  const search = clean(searchParams.get("search"));

  if (search) {
    where.push(`(
      m.name LIKE ?
      OR m.enrollment_no LIKE ?
      OR m.category LIKE ?
      OR m.contact_phone LIKE ?
      OR m.email LIKE ?
    )`);
    params.push(
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`
    );
  }

  const enrollmentNo = clean(searchParams.get("enrollmentNo"));
  if (enrollmentNo) {
    where.push("m.enrollment_no LIKE ?");
    params.push(`%${enrollmentNo}%`);
  }

  const category = clean(searchParams.get("category"));
  if (category) {
    where.push("m.category = ?");
    params.push(category);
  }

  const active = clean(searchParams.get("active"));
  if (active === "1" || active === "0") {
    where.push("m.active = ?");
    params.push(Number(active));
  }

  const empanelmentFrom = clean(searchParams.get("empanelmentFrom"));
  if (empanelmentFrom) {
    where.push("m.empanelment_date >= ?");
    params.push(empanelmentFrom);
  }

  const empanelmentTo = clean(searchParams.get("empanelmentTo"));
  if (empanelmentTo) {
    where.push("m.empanelment_date <= ?");
    params.push(empanelmentTo);
  }

  const validFrom = clean(searchParams.get("validFrom"));
  if (validFrom) {
    where.push("m.panel_valid_until >= ?");
    params.push(validFrom);
  }

  const validTo = clean(searchParams.get("validTo"));
  if (validTo) {
    where.push("m.panel_valid_until <= ?");
    params.push(validTo);
  }

  const validity = clean(searchParams.get("validity"));
  if (validity === "expired") {
    where.push("m.panel_valid_until IS NOT NULL AND m.panel_valid_until < ?");
    params.push(officeDate());
  } else if (validity === "expiring") {
    where.push("m.panel_valid_until IS NOT NULL AND m.panel_valid_until BETWEEN ? AND date(?, '+30 day')");
    params.push(officeDate(), officeDate());
  } else if (validity === "valid") {
    where.push("(m.panel_valid_until IS NULL OR m.panel_valid_until >= ?)");
    params.push(officeDate());
  }

  const sortColumns = {
    name: "m.name",
    category: "m.category",
    enrollment_no: "m.enrollment_no",
    empanelment_date: "m.empanelment_date",
    panel_valid_until: "m.panel_valid_until",
    active: "m.active",
    active_assignments: "active_assignments",
    total_assignments: "total_assignments",
    total_sessions: "total_sessions",
    effective_sessions: "effective_sessions",
    settled_cases: "settled_cases",
    failed_cases: "failed_cases",
  };
  const sortKey = clean(searchParams.get("sort")) || "name";
  const sortColumn = sortColumns[sortKey] || sortColumns.name;
  const direction =
    String(searchParams.get("direction") || "asc").toLowerCase() === "desc"
      ? "DESC"
      : "ASC";
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const baseSql = `
    SELECT
      m.id,
      m.name,
      m.enrollment_no,
      m.category,
      m.contact_phone,
      m.email,
      m.empanelment_order_no,
      m.empanelment_date,
      m.panel_valid_until,
      m.active,
      m.rotation_order,
      m.conflict_declaration_date,
      m.remarks,
      m.created_at,
      m.updated_at,
      COUNT(DISTINCT a.id) AS total_assignments,
      COUNT(DISTINCT CASE WHEN a.status = 'ACTIVE' THEN a.id END) AS active_assignments,
      COUNT(DISTINCT ms.id) AS total_sessions,
      COUNT(DISTINCT CASE WHEN ms.effective_session = 1 THEN ms.id END) AS effective_sessions,
      COUNT(DISTINCT CASE WHEN c.outcome_type = 'SETTLED' THEN c.id END) AS settled_cases,
      COUNT(DISTINCT CASE WHEN c.outcome_type = 'FAILED' THEN c.id END) AS failed_cases
    FROM mediators m
    LEFT JOIN pim_mediator_assignments a ON a.mediator_id = m.id
    LEFT JOIN mediation_sessions ms ON ms.assignment_id = a.id
    LEFT JOIN pim_cases c ON c.id = a.case_id
    ${whereSql}
    GROUP BY m.id
  `;

  return {
    page,
    pageSize,
    offset,
    params,
    countSql: `SELECT COUNT(*) AS count FROM (${baseSql}) mediator_count`,
    rowsSql: `
      ${baseSql}
      ORDER BY ${sortColumn} ${direction}, m.id DESC
      LIMIT ? OFFSET ?
    `,
  };
}

export async function GET(request) {
  try {
    requirePermission(request, "READ_MEDIATOR");

    // Batch 1 (Phase 6): migrated to PostgreSQL via lib/pim-data/mediators.js.
    // The permission check above is unchanged - still the SQLite-backed
    // lib/pim-auth.js session/user resolution, run before any data access.
    const url = new URL(request.url);
    const data = await listMediators(url.searchParams);

    return Response.json({
      success: true,
      data,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediator register GET error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load mediators.",
      },
      { status: 500 }
    );
  }
}

/*
 * The ORIGINAL SQLite POST body, kept unused as an instant rollback and as
 * the authentic SQLite baseline for scripts/test-pim-mediator-registry-postgres.js
 * (same convention as app/api/pim/nonstarter/[id]/route.js's
 * getNonStarterViewSqlite). Not called by POST.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function postMediatorSqlite(input, userId) {
  const inserted = db.prepare(`
    INSERT INTO mediators (
      name,
      category,
      enrollment_no,
      contact_phone,
      email,
      empanelment_order_no,
      empanelment_date,
      panel_valid_until,
      active,
      rotation_order,
      conflict_declaration_date,
      remarks
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.category,
    input.enrollmentNo,
    input.contactPhone,
    input.email,
    input.empanelmentOrderNo,
    input.empanelmentDate,
    input.panelValidUntil,
    input.active,
    input.rotationOrder,
    input.conflictDeclarationDate,
    input.remarks
      ? `${input.remarks}\nCreated by user ${userId}.`
      : `Created by user ${userId}.`
  );
  const mediatorId = Number(inserted.lastInsertRowid);

  db.prepare(`
    INSERT INTO audit_log (
      table_name,
      record_id,
      action,
      new_value,
      changed_by,
      reason
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "mediators",
    mediatorId,
    "INSERT",
    JSON.stringify({
      name: input.name,
      enrollment_no: input.enrollmentNo,
      category: input.category,
      active: input.active,
    }),
    userId,
    "Mediator added through mediator register."
  );

  return db.prepare(`
    SELECT *
    FROM mediators
    WHERE id = ?
  `).get(mediatorId);
}

export async function POST(request) {
  try {
    const user = requirePermission(request, "MANAGE_MEDIATOR");
    const body = await request.json().catch(() => ({}));
    const input = parseMediatorBody(body);
    const error = validateMediatorInput(input);

    if (error) return validationError(error);

    // Batch 5H (Phase 6): migrated to PostgreSQL via lib/pim-data/mediator-registry.js.
    const duplicate = await checkDuplicateActiveEnrollmentPg(input.enrollmentNo);
    if (duplicate) {
      return conflict(
        `Active mediator with enrollment number ${input.enrollmentNo} already exists.`
      );
    }

    const mediator = await createMediatorPg(
      {
        name: input.name,
        category: input.category,
        enrollment_no: input.enrollmentNo,
        contact_phone: input.contactPhone,
        email: input.email,
        empanelment_order_no: input.empanelmentOrderNo,
        empanelment_date: input.empanelmentDate,
        panel_valid_until: input.panelValidUntil,
        active: input.active,
        rotation_order: input.rotationOrder,
        conflict_declaration_date: input.conflictDeclarationDate,
        remarks: input.remarks
          ? `${input.remarks}\nCreated by user ${user.id}.`
          : `Created by user ${user.id}.`,
      },
      user.id
    );

    return Response.json(
      {
        success: true,
        message: "Mediator added successfully.",
        data: { mediator },
      },
      { status: 201 }
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediator register POST error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to add mediator.",
      },
      { status: 500 }
    );
  }
}
