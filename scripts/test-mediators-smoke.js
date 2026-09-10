/* eslint-disable @typescript-eslint/no-require-imports */

const db = require("../lib/db");

const base = "http://localhost:3000";
const marker = `QA-MED-${Date.now()}`;
const cleanup = [];

async function hit(name, url, options = {}) {
  const response = await fetch(url, options);
  let json = {};

  try {
    json = await response.json();
  } catch {
    json = { message: "non-json response" };
  }

  console.log(name, response.status, json.message || json.success);
  return { response, json };
}

function cleanupRows() {
  for (const item of cleanup.reverse()) {
    if (item.type === "case") {
      db.prepare(`
        DELETE FROM pim_cases
        WHERE id = ?
          AND received_number LIKE ?
      `).run(item.id, `${marker}%`);
    } else if (item.type === "mediator") {
      db.prepare(`
        DELETE FROM audit_log
        WHERE table_name = 'mediators'
          AND record_id = ?
      `).run(item.id);
      db.prepare(`
        DELETE FROM mediators
        WHERE id = ?
          AND enrollment_no LIKE ?
      `).run(item.id, `${marker}%`);
    }
  }
}

async function main() {
  await hit("Secretary view register", `${base}/api/pim/mediators`, {
    headers: { "x-pim-user-id": "2" },
  });

  const add = await hit("Secretary add mediator", `${base}/api/pim/mediators`, {
    method: "POST",
    headers: {
      "x-pim-user-id": "2",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: marker,
      enrollmentNo: marker,
      category: "ADVOCATE MEDIATOR",
      contactPhone: "9123456780",
      email: "qa@example.com",
      empanelmentDate: "2026-08-19",
      panelValidUntil: "2027-08-19",
      active: true,
    }),
  });
  const mediatorId = add.json.data?.mediator?.id;

  if (mediatorId) {
    cleanup.push({ type: "mediator", id: mediatorId });
  }

  await hit("Duplicate enrollment 409", `${base}/api/pim/mediators`, {
    method: "POST",
    headers: {
      "x-pim-user-id": "2",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: `${marker} DUP`,
      enrollmentNo: marker,
      category: "ADVOCATE MEDIATOR",
      active: true,
    }),
  });

  await hit("Chairman cannot edit", `${base}/api/pim/mediators/${mediatorId}`, {
    method: "PATCH",
    headers: {
      "x-pim-user-id": "3",
      "content-type": "application/json",
    },
    body: JSON.stringify({ contactPhone: "9000000001" }),
  });

  await hit("AA cannot edit", `${base}/api/pim/mediators/${mediatorId}`, {
    method: "PATCH",
    headers: {
      "x-pim-user-id": "1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ contactPhone: "9000000001" }),
  });

  await hit("Admin can edit", `${base}/api/pim/mediators/${mediatorId}`, {
    method: "PATCH",
    headers: {
      "x-pim-user-id": "4",
      "content-type": "application/json",
    },
    body: JSON.stringify({ contactPhone: "9000000002" }),
  });

  await hit("Invalid mediator id", `${base}/api/pim/mediators/abc`, {
    headers: { "x-pim-user-id": "2" },
  });

  delete process.env.PIM_DEV_USER_ID;
  const { requirePermission } = require("../lib/pim-auth");
  try {
    requirePermission({ headers: new Headers() }, "READ_MEDIATOR");
    console.log("Missing identity direct failed");
  } catch (error) {
    console.log("Missing identity direct", error.status, error.message);
  }

  const statusId = db.prepare(`
    SELECT id
    FROM status_master
    WHERE code = 'MEDIATOR_ASSIGNMENT_PENDING'
  `).get().id;
  const inactive = db.prepare(`
    INSERT INTO mediators (
      name,
      category,
      enrollment_no,
      active,
      panel_valid_until
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    `${marker} INACTIVE`,
    "ADVOCATE MEDIATOR",
    `${marker}-INACTIVE`,
    0,
    "2027-08-19"
  ).lastInsertRowid;
  const expired = db.prepare(`
    INSERT INTO mediators (
      name,
      category,
      enrollment_no,
      active,
      panel_valid_until
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    `${marker} EXPIRED`,
    "ADVOCATE MEDIATOR",
    `${marker}-EXPIRED`,
    1,
    "2026-01-01"
  ).lastInsertRowid;

  cleanup.push(
    { type: "mediator", id: inactive },
    { type: "mediator", id: expired }
  );

  const case1 = db.prepare(`
    INSERT INTO pim_cases (
      received_number,
      received_date,
      application_date,
      current_status_id
    )
    VALUES (?, ?, ?, ?)
  `).run(`${marker}-C1`, "2026-08-19", "2026-08-19", statusId)
    .lastInsertRowid;
  const case2 = db.prepare(`
    INSERT INTO pim_cases (
      received_number,
      received_date,
      application_date,
      current_status_id
    )
    VALUES (?, ?, ?, ?)
  `).run(`${marker}-C2`, "2026-08-19", "2026-08-19", statusId)
    .lastInsertRowid;

  cleanup.push({ type: "case", id: case1 }, { type: "case", id: case2 });

  await hit("Inactive mediator cannot assign", `${base}/api/pim/mediator/${case1}`, {
    method: "POST",
    headers: {
      "x-pim-user-id": "2",
      "content-type": "application/json",
    },
    body: JSON.stringify({ mediatorId: inactive }),
  });

  await hit("Expired mediator cannot assign", `${base}/api/pim/mediator/${case2}`, {
    method: "POST",
    headers: {
      "x-pim-user-id": "2",
      "content-type": "application/json",
    },
    body: JSON.stringify({ mediatorId: expired }),
  });

  const auth = await hit("Secretary auth permissions", `${base}/api/pim/auth/me`, {
    headers: { "x-pim-user-id": "2" },
  });
  console.log(
    "Secretary ENTER_APPLICATION visible?",
    Boolean(auth.json.permissions?.ENTER_APPLICATION),
    "MANAGE_MEDIATOR?",
    Boolean(auth.json.permissions?.MANAGE_MEDIATOR)
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(cleanupRows);
