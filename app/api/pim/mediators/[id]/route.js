/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../lib/api-response");

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

function getMediator(id) {
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

function duplicateActiveEnrollment(enrollmentNo, id) {
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
  const enrollmentNo =
    Object.prototype.hasOwnProperty.call(input, "enrollment_no")
      ? input.enrollment_no
      : current.enrollment_no;
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
  if (!enrollmentNo) return "Enrollment number is required.";
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

    const mediator = getMediator(id);

    if (!mediator) {
      return Response.json(
        {
          success: false,
          message: "Mediator not found.",
        },
        { status: 404 }
      );
    }

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

    return Response.json({
      success: true,
      data: {
        mediator,
        activeAssignments: assignments.filter(
          (assignment) => assignment.status === "ACTIVE"
        ),
        assignments,
        sessions,
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

    const current = db.prepare(`
      SELECT *
      FROM mediators
      WHERE id = ?
    `).get(id);

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
      const duplicate = duplicateActiveEnrollment(nextEnrollment, id);
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

    const sql = `
      UPDATE mediators
      SET
        ${updates.map((column) => `${column} = ?`).join(",\n        ")},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    const values = updates.map((column) => input[column]);

    db.prepare(sql).run(...values, id);

    db.prepare(`
      INSERT INTO audit_log (
        table_name,
        record_id,
        action,
        old_value,
        new_value,
        changed_by,
        reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "mediators",
      id,
      "UPDATE",
      JSON.stringify(
        Object.fromEntries(updates.map((column) => [column, current[column]]))
      ),
      JSON.stringify(
        Object.fromEntries(updates.map((column) => [column, input[column]]))
      ),
      user.id,
      "Mediator updated through mediator register."
    );

    const mediator = getMediator(id);

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
