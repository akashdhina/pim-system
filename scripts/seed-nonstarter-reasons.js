const db = require("../lib/db");

const reasons = [
  {
    code: "FINAL_NOTICE_UNACKNOWLEDGED",
    name: "Final notice remained unacknowledged / no response received",
    rule_reference:
      "Rule 3(3)-(4), Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018",
    requires_authority_decision: 0,
    remarks:
      "Use after final notice remains unacknowledged."
  },
  {
    code: "OP_REFUSED_MEDIATION",
    name: "Opposite party refused to participate in mediation",
    rule_reference:
      "Rule 3(4), Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018",
    requires_authority_decision: 0,
    remarks:
      "Use where refusal to participate is recorded."
  },
  {
    code: "OP_FAILED_TO_APPEAR_AFTER_TIME",
    name: "Opposite party failed to appear on the alternate date fixed after seeking time",
    rule_reference:
      "Rule 3(5)-(6), Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018",
    requires_authority_decision: 0,
    remarks:
      "Use only after an alternate date was actually granted."
  },
  {
    code: "BOTH_PARTIES_NOT_WILLING",
    name: "Both parties expressed unwillingness to proceed with mediation",
    rule_reference:
      "Rule 3(4), Commercial Courts (Pre-Institution Mediation and Settlement) Rules, 2018",
    requires_authority_decision: 0,
    remarks:
      "Use where unwillingness/non-participation is documented."
  },
  {
    code: "MEDIATION_FEE_NOT_SUBMITTED",
    name: "Required mediation fee was not submitted and the process could not proceed",
    rule_reference:
      "Operational ground; verify against applicable current DLSA/TNSLSA practice",
    requires_authority_decision: 1,
    remarks:
      "Keep authority review enabled until local practice is confirmed."
  }
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO nonstarter_reasons
  (
    code,
    name,
    rule_reference,
    requires_authority_decision,
    active,
    remarks
  )
  VALUES (?, ?, ?, ?, 1, ?)
`);

const seed = db.transaction(() => {
  for (const reason of reasons) {
    insert.run(
      reason.code,
      reason.name,
      reason.rule_reference,
      reason.requires_authority_decision,
      reason.remarks
    );
  }
});

seed();

console.log("NON-STARTER REASONS SEEDED");
console.table(
  db.prepare(`
    SELECT
      id,
      code,
      name,
      rule_reference,
      requires_authority_decision,
      active
    FROM nonstarter_reasons
    ORDER BY id
  `).all()
);

db.close();