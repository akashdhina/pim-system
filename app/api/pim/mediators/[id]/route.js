/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");
const {
  getMediatorDetailPg,
} = require("../../../../../lib/pim-data/mediator-registry-read");
const {
  checkDuplicateActiveEnrollmentPg,
  getMediatorRawPg,
  updateMediatorPg,
} = require("../../../../../lib/pim-data/mediator-registry");

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
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

/*
 * The ORIGINAL SQLite single-mediator aggregate query, kept unused (by the
 * route handlers; still called from getMediatorDetailSqlite below) as an
 * instant rollback and as the authentic SQLite baseline for
 * scripts/test-pim-mediator-registry-postgres.js.
 */
function getMediatorSqlite(id) {
  return db.prepare(`
    SELECT
      m.*,
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
    WHERE m.id = ?
    GROUP BY m.id
  `).get(id);
}

/*
 * The ORIGINAL SQLite GET body (mediator + assignments + sessions), kept
 * unused as an instant rollback and as the authentic SQLite parity
 * baseline. Returns exactly what GET puts under `data`, or null for a
 * missing mediator (route maps that to 404).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getMediatorDetailSqlite(id) {
  const mediator = getMediatorSqlite(id);
  if (!mediator) return null;

  const assignments = db.prepare(`
    SELECT
      a.*,
      c.pim_number,
      c.received_number,
      c.outcome_type,
      s.name AS status_name
    FROM pim_mediator_assignments a
    JOIN pim_cases c ON c.id = a.case_id
    LEFT JOIN status_master s ON s.id = c.current_status_id
    WHERE a.mediator_id = ?
    ORDER BY
      CASE WHEN a.status = 'ACTIVE' THEN 0 ELSE 1 END,
      a.assignment_date DESC,
      a.id DESC
  `).all(id);

  const sessions = db.prepare(`
    SELECT
      ms.*,
      c.pim_number,
      c.received_number
    FROM mediation_sessions ms
    JOIN pim_mediator_assignments a ON a.id = ms.assignment_id
    JOIN pim_cases c ON c.id = ms.case_id
    WHERE a.mediator_id = ?
    ORDER BY COALESCE(ms.actual_date, ms.scheduled_date) DESC, ms.id DESC
    LIMIT 50
  `).all(id);

  return {
    mediator,
    activeAssignments: assignments.filter(
      (assignment) => assignment.status === "ACTIVE"
    ),
    assignments,
    sessions,
  };
}

// The ORIGINAL SQLite duplicate-enrollment check, kept unused as an instant rollback.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function duplicateActiveEnrollmentSqlite(enrollmentNo, id) {
  if (!enrollmentNo) return null;

  return db.prepare(`
    SELECT id, name
    FROM mediators
    WHERE active = 1
      AND enrollment_no = ?
      AND id <> ?
    LIMIT 1
  `).get(enrollmentNo, id);
}

function validateEmail(email) {
  return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return !phone || /^[0-9+\-\s()]{6,20}$/.test(phone);
}

function parsePatch(body) {
  const input = {};
  const fields = [
    ["name", "name"],
    ["category", "category"],
    ["enrollmentNo", "enrollment_no"],
    ["contactPhone", "contact_phone"],
    ["email", "email"],
    ["empanelmentOrderNo", "empanelment_order_no"],
    ["empanelmentDate", "empanelment_date"],
    ["panelValidUntil", "panel_valid_until"],
    ["conflictDeclarationDate", "conflict_declaration_date"],
    ["remarks", "remarks"],
  ];

  for (const [bodyKey, dbKey] of fields) {
    if (Object.prototype.hasOwnProperty.call(body, bodyKey)) {
      input[dbKey] = clean(body[bodyKey]);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "active")) {
    input.active = body.active === true || body.active === 1 ? 1 : 0;
  }

  if (Object.prototype.hasOwnProperty.call(body, "rotationOrder")) {
    input.rotation_order =
      body.rotationOrder === "" ||
      body.rotationOrder === null ||
      body.rotationOrder === undefined
        ? null
        : Number(body.rotationOrder);
  }

  return input;
}

function validatePatch(input, current) {
  const name =
    Object.prototype.hasOwnProperty.call(input, "name")
      ? input.name
      : current.name;
  const category =
    Object.prototype.hasOwnProperty.call(input, "category")
      ? input.category
      : current.category;
  const email =
    Object.prototype.hasOwnProperty.call(input, "email")
      ? input.email
      : current.email;
  const phone =
    Object.prototype.hasOwnProperty.call(input, "contact_phone")
      ? input.contact_phone
      : current.contact_phone;
  const empanelmentDate =
    Object.prototype.hasOwnProperty.call(input, "empanelment_date")
      ? input.empanelment_date
      : current.empanelment_date;
  const panelValidUntil =
    Object.prototype.hasOwnProperty.call(input, "panel_valid_until")
      ? input.panel_valid_until
      : current.panel_valid_until;

  if (!name) return "Mediator name is required.";
  if (!category) return "Category is required.";
  // Batch 5H-a (Phase 6) mediator-panel reconciliation: enrollment number is
  // NOT mandatory (see the matching comment in mediators/route.js's
  // validateMediatorInput). A PATCH that never touches enrollment_no must
  // not be blocked just because the current stored value is NULL - two real
  // mediators (Rajesh, Ravikumar) already have a NULL enrollment_no today.
  if (!validatePhone(phone)) return "Phone number is not valid.";
  if (!validateEmail(email)) return "Email address is not valid.";

  if (
    input.rotation_order !== null &&
    input.rotation_order !== undefined &&
    (!Number.isInteger(input.rotation_order) || input.rotation_order < 0)
  ) {
    return "Rotation order must be a whole number.";
  }

  if (
    empanelmentDate &&
    panelValidUntil &&
    panelValidUntil < empanelmentDate
  ) {
    return "Panel valid until cannot be before empanelment date.";
  }

  return null;
}

export async function GET(request, { params }) {
  try {
    requirePermission(request, "READ_MEDIATOR");

    const { id: idParam } = await params;
    const id = Number(idParam);

    if (!Number.isInteger(id) || id <= 0) {
      return validationError("Invalid mediator ID.");
    }

    // Batch 5H (Phase 6): migrated to PostgreSQL via lib/pim-data/mediator-registry-read.js.
    const detail = await getMediatorDetailPg(id);

    if (!detail) {
      return Response.json(
        {
          success: false,
          message: "Mediator not found.",
        },
        { status: 404 }
      );
    }

    return Response.json({
      success: true,
      data: {
        mediator: detail.mediator,
        activeAssignments: detail.assignments.filter(
          (assignment) => assignment.status === "ACTIVE"
        ),
        assignments: detail.assignments,
        sessions: detail.sessions,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediator detail GET error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load mediator.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request, { params }) {
  try {
    const user = requirePermission(request, "MANAGE_MEDIATOR");
    const { id: idParam } = await params;
    const id = Number(idParam);

    if (!Number.isInteger(id) || id <= 0) {
      return validationError("Invalid mediator ID.");
    }

    // Batch 5H (Phase 6): migrated to PostgreSQL via lib/pim-data/mediator-registry.js.
    const current = await getMediatorRawPg(id);

    if (!current) {
      return Response.json(
        {
          success: false,
          message: "Mediator not found.",
        },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const input = parsePatch(body);
    const error = validatePatch(input, current);

    if (error) return validationError(error);

    const nextEnrollment =
      Object.prototype.hasOwnProperty.call(input, "enrollment_no")
        ? input.enrollment_no
        : current.enrollment_no;
    const nextActive =
      Object.prototype.hasOwnProperty.call(input, "active")
        ? input.active
        : current.active;

    if (nextActive === 1) {
      const duplicate = await checkDuplicateActiveEnrollmentPg(nextEnrollment, id);
      if (duplicate) {
        return conflict(
          `Active mediator with enrollment number ${nextEnrollment} already exists.`
        );
      }
    }

    const allowedColumns = [
      "name",
      "category",
      "enrollment_no",
      "contact_phone",
      "email",
      "empanelment_order_no",
      "empanelment_date",
      "panel_valid_until",
      "active",
      "rotation_order",
      "conflict_declaration_date",
      "remarks",
    ];
    const updates = allowedColumns.filter((column) =>
      Object.prototype.hasOwnProperty.call(input, column)
    );

    if (!updates.length) {
      return validationError("No mediator fields were supplied.");
    }

    const updateValues = Object.fromEntries(
      updates.map((column) => [column, input[column]])
    );
    const oldValues = Object.fromEntries(
      updates.map((column) => [column, current[column]])
    );

    const mediator = await updateMediatorPg(id, updateValues, {
      oldValues,
      newValues: updateValues,
      userId: user.id,
      reason: "Mediator updated through mediator register.",
    });

    return Response.json({
      success: true,
      message: "Mediator updated successfully.",
      data: {
        mediator,
        updatedBy: user.id,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Mediator detail PATCH error:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to update mediator.",
      },
      { status: 500 }
    );
  }
}
