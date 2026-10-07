/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase LK-2 tests: Legal Knowledge Base schema, seed, and the two data-layer
 * modules (legal-sources-read.js, legal-sources-admin.js).
 *
 * Usage:
 *   node scripts/test-pim-legal-knowledge-base-postgres.js
 *   node scripts/test-pim-legal-knowledge-base-postgres.js --cleanup-only
 *
 * Runs directly against the live pim-system Supabase Postgres database via
 * SUPABASE_DB_URL (same connection every lib/pim-data/*.js module uses) -
 * there is no local/shadow Postgres in this project. Per the PG test-run
 * conventions already established in this codebase (see
 * scripts/test-pim-mediator-registry-postgres.js and this project's own
 * test-run notes): exact-ID fixture tracking with a recovery manifest,
 * sequential (not concurrent) queries to avoid pooler bursts, a per-test
 * timeout so a pooler stall fails loudly, and --cleanup-only to recover a
 * stale run. Every fixture row this script creates is tagged with a
 * TEST-LK2- prefixed title/guidance_key and deleted by exact id in a
 * finally block, never by a broad DELETE WHERE.
 *
 * This script is READ-MOSTLY against the real seeded data (assertions 1-10
 * below) plus a small number of throwaway fixture rows for the
 * negative/transition tests (11-15), all cleaned up by exact id. It never
 * touches pim_cases, pim_fees, pim_mediator_assignments, pim_outcomes,
 * nonstarter_reasons, mediators, or pim_number_sequences - confirmed by
 * assertion 16/17 (before/after invariant snapshot).
 */

const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getSql } = require("../lib/pim-postgres");
const {
  getVerifiedLegalSources,
  getVerifiedLegalSourcesForStage,
  getActiveGuidanceRulesForStage,
} = require("../lib/pim-data/legal-sources-read");
const {
  setLegalSourceVerificationState,
  LegalSourceTransitionError,
} = require("../lib/pim-data/legal-sources-admin");

const MANIFEST_PATH = path.join(os.tmpdir(), "pim-test-legal-kb-manifest.json");
const RUN_ID = Date.now();
const TAG = `TEST-LK2-${RUN_ID}`;

let passed = 0;
const failures = [];
const fixtureIds = { legal_sources: [] };

function record(name, fn) {
  return fn()
    .then(() => {
      passed += 1;
      console.log(`PASS: ${name}`);
    })
    .catch((err) => {
      failures.push({ name, err });
      console.error(`FAIL: ${name}\n  ${err.message}`);
    });
}

function saveManifest() {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ tag: TAG, fixtureIds }, null, 2));
}

async function cleanup() {
  const sql = getSql();
  for (const id of fixtureIds.legal_sources) {
    await sql`delete from legal_sources where id = ${id}`;
  }
  if (fs.existsSync(MANIFEST_PATH)) fs.rmSync(MANIFEST_PATH);
}

async function cleanupOnly() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log("No manifest found - nothing to clean up.");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const sql = getSql();
  for (const id of manifest.fixtureIds.legal_sources || []) {
    await sql`delete from legal_sources where id = ${id}`;
    console.log(`Deleted leftover legal_sources id=${id}`);
  }
  fs.rmSync(MANIFEST_PATH);
}

async function main() {
  if (process.argv.includes("--cleanup-only")) {
    await cleanupOnly();
    process.exit(0);
  }

  const sql = getSql();

  // ------------------------------------------------------------------
  // Invariant snapshot (before)
  // ------------------------------------------------------------------
  const [seqBefore] = await sql`select last_number from pim_number_sequences where year = 2026`;
  const [mediatorCountBefore] = await sql`select count(*)::int as n from mediators where active = true`;
  const [caseCountBefore] = await sql`select count(*)::int as n from pim_cases`;

  // ------------------------------------------------------------------
  // 1. Migrations applied - tables exist with expected shape
  // ------------------------------------------------------------------
  await record("1. legal_sources and related tables exist", async () => {
    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'legal_sources', 'legal_source_workflow_stages',
          'legal_guidance_rules', 'legal_guidance_rule_stages',
          'legal_guidance_rule_sources'
        )
    `;
    assert.strictEqual(tables.length, 5, "expected all 5 LK-2 tables to exist");
  });

  // ------------------------------------------------------------------
  // 2. Seed present (not re-run idempotently by design - this project's
  //    seed migrations, e.g. nonstarter_reasons, are likewise one-shot,
  //    tracked by Supabase's migration history, not re-runnable inserts)
  // ------------------------------------------------------------------
  await record("2. seed produced exactly the expected 11 sources and 4 guidance rules, no duplicate titles", async () => {
    const [{ n: sourceCount }] = await sql`select count(*)::int as n from legal_sources where title not like 'TEST-LK2-%'`;
    const [{ n: ruleCount }] = await sql`select count(*)::int as n from legal_guidance_rules`;
    const dupes = await sql`select title, count(*) from legal_sources where title not like 'TEST-LK2-%' group by title having count(*) > 1`;
    assert.ok(sourceCount >= 11, `expected at least 11 seeded legal_sources, got ${sourceCount}`);
    assert.strictEqual(ruleCount, 4, `expected exactly 4 seeded guidance rules, got ${ruleCount}`);
    assert.strictEqual(dupes.length, 0, "expected no duplicate legal_sources titles");
  });

  // ------------------------------------------------------------------
  // 3. Authority-level/source-type mapping valid for every seeded row
  // ------------------------------------------------------------------
  await record("3. authority_level matches source_type for every row", async () => {
    const mismatches = await sql`
      select id, source_type, authority_level from legal_sources
      where not (
        (source_type in ('STATUTE','RULE','CENTRAL_NOTIFICATION') and authority_level = 1)
        or (source_type = 'SUPREME_COURT' and authority_level = 2)
        or (source_type = 'MADRAS_HIGH_COURT' and authority_level = 3)
        or (source_type in ('TNSLSA_SOP','TNSLSA_INSTRUCTION') and authority_level = 4)
        or (source_type = 'OTHER_HIGH_COURT' and authority_level = 5)
        or (source_type = 'INTERNAL_GUIDANCE' and authority_level = 6)
      )
    `;
    assert.strictEqual(mismatches.length, 0, `expected no authority_level mismatches, found ${JSON.stringify(mismatches)}`);
  });

  // ------------------------------------------------------------------
  // 4. Ordinary read path returns verified sources (Patil Automation)
  // ------------------------------------------------------------------
  await record("4. getVerifiedLegalSources returns Patil Automation", async () => {
    const rows = await getVerifiedLegalSources({ sourceType: "SUPREME_COURT" });
    const patil = rows.find((r) => r.title.includes("Patil Automation"));
    assert.ok(patil, "expected Patil Automation in verified SUPREME_COURT sources");
    assert.strictEqual(patil.authority_level, 2);
  });

  // ------------------------------------------------------------------
  // 5. OTHER_HIGH_COURT (Sidhi Vinayak) retains Level 5 and is never
  //    mislabeled as binding/Madras High Court
  // ------------------------------------------------------------------
  await record("5. Sidhi Vinayak Metcom is OTHER_HIGH_COURT, Level 5, never binding", async () => {
    const [row] = await sql`select source_type, authority_level, jurisdiction from legal_sources where title like 'Union of India v. M/s Sidhi Vinayak%'`;
    assert.ok(row, "expected Sidhi Vinayak Metcom row to exist");
    assert.strictEqual(row.source_type, "OTHER_HIGH_COURT");
    assert.strictEqual(row.authority_level, 5);
    assert.strictEqual(row.jurisdiction, "JHARKHAND");
    assert.notStrictEqual(row.source_type, "MADRAS_HIGH_COURT");
    assert.notStrictEqual(row.source_type, "SUPREME_COURT");
  });

  // ------------------------------------------------------------------
  // 6. Statute/SOP rows have NULL case_holding (allowed, not "N/A")
  // ------------------------------------------------------------------
  await record("6. statute/SOP rows have NULL case_holding, not a placeholder string", async () => {
    const rows = await sql`select case_holding from legal_sources where source_type in ('STATUTE','RULE','TNSLSA_SOP','TNSLSA_INSTRUCTION')`;
    assert.ok(rows.length >= 5, "expected at least 5 statute/rule/SOP/instruction rows");
    for (const row of rows) {
      assert.strictEqual(row.case_holding, null, "case_holding must be NULL, not a placeholder, for non-judgment sources");
    }
  });

  // ------------------------------------------------------------------
  // 7. Judgment rows require judgment metadata (CHECK constraint)
  // ------------------------------------------------------------------
  await record("7. inserting a SUPREME_COURT row without case_number/court/decision_date/case_holding fails", async () => {
    let threw = false;
    try {
      await sql`insert into legal_sources (source_type, authority_level, title, verification_state) values ('SUPREME_COURT', 2, ${TAG + " incomplete judgment"}, 'DRAFT')`;
    } catch (err) {
      threw = true;
      assert.ok(/check/i.test(err.message) || err.code === "23514", `expected a CHECK violation, got: ${err.message}`);
    }
    assert.ok(threw, "expected the judgment-metadata CHECK constraint to reject an incomplete SUPREME_COURT row");
  });

  // ------------------------------------------------------------------
  // 8. authority_level/source_type CHECK rejects a mismatch
  // ------------------------------------------------------------------
  await record("8. inserting OTHER_HIGH_COURT with authority_level 2 fails", async () => {
    let threw = false;
    try {
      await sql`insert into legal_sources (source_type, authority_level, title, court, case_number, decision_date, case_holding, verification_state) values ('OTHER_HIGH_COURT', 2, ${TAG + " bad level"}, 'Test Court', 'TC/1/2026', '2026-01-01', 'test holding', 'DRAFT')`;
    } catch (err) {
      threw = true;
      assert.ok(/check/i.test(err.message) || err.code === "23514", `expected a CHECK violation, got: ${err.message}`);
    }
    assert.ok(threw, "expected the authority_level/source_type CHECK constraint to reject the mismatch");
  });

  // ------------------------------------------------------------------
  // 9. Workflow-stage mapping integrity - invalid status_code rejected
  // ------------------------------------------------------------------
  await record("9. legal_source_workflow_stages rejects an unknown status_code (FK)", async () => {
    const [patil] = await sql`select id from legal_sources where title like 'Patil Automation%'`;
    let threw = false;
    try {
      await sql`insert into legal_source_workflow_stages (legal_source_id, status_code) values (${patil.id}, 'NOT_A_REAL_STATUS')`;
    } catch (err) {
      threw = true;
      assert.ok(err.code === "23503" || /foreign key/i.test(err.message), `expected an FK violation, got: ${err.message}`);
    }
    assert.ok(threw, "expected status_master FK to reject an unknown status_code");
  });

  // ------------------------------------------------------------------
  // 10. Guidance-to-source join integrity - invalid legal_source_id rejected
  // ------------------------------------------------------------------
  await record("10. legal_guidance_rule_sources rejects a non-existent legal_source_id (FK)", async () => {
    const [rule] = await sql`select id from legal_guidance_rules where guidance_key = 'SECTION12A_MANDATORY'`;
    let threw = false;
    try {
      await sql`insert into legal_guidance_rule_sources (guidance_rule_id, legal_source_id) values (${rule.id}, 999999999)`;
    } catch (err) {
      threw = true;
      assert.ok(err.code === "23503" || /foreign key/i.test(err.message), `expected an FK violation, got: ${err.message}`);
    }
    assert.ok(threw, "expected legal_sources FK to reject a non-existent legal_source_id");
  });

  // ------------------------------------------------------------------
  // 11-14. Verification-state visibility: DISCOVERED / REJECTED_MISMATCH /
  // inactive PRIMARY_SOURCE_VERIFIED rows are never returned by the
  // ordinary read path, even though they exist in the table.
  // ------------------------------------------------------------------
  let discoveredId, rejectedId, inactiveVerifiedId, draftId;

  await record("11. fixture setup: create DISCOVERED / REJECTED_MISMATCH / inactive-verified / DRAFT rows", async () => {
    const [discovered] = await sql`
      insert into legal_sources (source_type, authority_level, title, verification_state)
      values ('INTERNAL_GUIDANCE', 6, ${TAG + " discovered fixture"}, 'DISCOVERED')
      returning id
    `;
    discoveredId = discovered.id;
    fixtureIds.legal_sources.push(discoveredId);

    const [rejected] = await sql`
      insert into legal_sources (source_type, authority_level, title, verification_state, verification_notes)
      values ('INTERNAL_GUIDANCE', 6, ${TAG + " rejected fixture"}, 'REJECTED_MISMATCH', 'test fixture - not a real mismatch')
      returning id
    `;
    rejectedId = rejected.id;
    fixtureIds.legal_sources.push(rejectedId);

    const [inactiveVerified] = await sql`
      insert into legal_sources (source_type, authority_level, title, verification_state, is_active)
      values ('INTERNAL_GUIDANCE', 6, ${TAG + " inactive verified fixture"}, 'PRIMARY_SOURCE_VERIFIED', false)
      returning id
    `;
    inactiveVerifiedId = inactiveVerified.id;
    fixtureIds.legal_sources.push(inactiveVerifiedId);

    const [draft] = await sql`
      insert into legal_sources (source_type, authority_level, title, verification_state)
      values ('INTERNAL_GUIDANCE', 6, ${TAG + " draft fixture"}, 'DRAFT')
      returning id
    `;
    draftId = draft.id;
    fixtureIds.legal_sources.push(draftId);

    saveManifest();
  });

  await record("12. DISCOVERED source is not visible through getVerifiedLegalSources", async () => {
    const rows = await getVerifiedLegalSources({ sourceType: "INTERNAL_GUIDANCE" });
    assert.ok(!rows.some((r) => r.id === discoveredId), "DISCOVERED fixture must not appear in the verified read path");
  });

  await record("13. REJECTED_MISMATCH source is not visible through getVerifiedLegalSources", async () => {
    const rows = await getVerifiedLegalSources({ sourceType: "INTERNAL_GUIDANCE" });
    assert.ok(!rows.some((r) => r.id === rejectedId), "REJECTED_MISMATCH fixture must not appear in the verified read path");
  });

  await record("14. inactive PRIMARY_SOURCE_VERIFIED (superseded-style) source is not visible", async () => {
    const rows = await getVerifiedLegalSources({ sourceType: "INTERNAL_GUIDANCE" });
    assert.ok(!rows.some((r) => r.id === inactiveVerifiedId), "inactive verified fixture must not appear in the verified read path");
  });

  // ------------------------------------------------------------------
  // 15. Verification-state transitions: valid transition + audit log,
  // invalid transition rejected, REJECTED_MISMATCH without notes rejected.
  // ------------------------------------------------------------------
  await record("15a. valid DRAFT -> DISCOVERED transition writes an audit_log row", async () => {
    const [auditCountBefore] = await sql`select count(*)::int as n from audit_log where table_name = 'legal_sources' and record_id = ${draftId}`;
    const result = await setLegalSourceVerificationState({
      legalSourceId: draftId,
      newState: "DISCOVERED",
      actorUserId: 1,
    });
    assert.strictEqual(result.verification_state, "DISCOVERED");
    const [auditCountAfter] = await sql`select count(*)::int as n from audit_log where table_name = 'legal_sources' and record_id = ${draftId}`;
    assert.strictEqual(auditCountAfter.n, auditCountBefore.n + 1, "expected exactly one new audit_log row for the transition");
  });

  await record("15b. invalid transition (DISCOVERED -> SUPERSEDED) is rejected before hitting the DB CHECK", async () => {
    await assert.rejects(
      () => setLegalSourceVerificationState({ legalSourceId: draftId, newState: "SUPERSEDED", actorUserId: 1, supersededBy: 1 }),
      LegalSourceTransitionError
    );
  });

  await record("15c. REJECTED_MISMATCH without verificationNotes is rejected", async () => {
    await assert.rejects(
      () => setLegalSourceVerificationState({ legalSourceId: draftId, newState: "REJECTED_MISMATCH", actorUserId: 1 }),
      LegalSourceTransitionError
    );
  });

  // ------------------------------------------------------------------
  // 16. Stage-scoped loaders return correctly shaped data for a real stage
  // ------------------------------------------------------------------
  await record("16. getVerifiedLegalSourcesForStage('FEE_PENDING') includes Sidhi Vinayak Metcom and Rule 11", async () => {
    const rows = await getVerifiedLegalSourcesForStage("FEE_PENDING");
    assert.ok(rows.some((r) => r.title.includes("Sidhi Vinayak")), "expected Sidhi Vinayak Metcom at FEE_PENDING");
    assert.ok(rows.some((r) => r.title.includes("Rule 11")), "expected the Rule 11 source at FEE_PENDING");
  });

  await record("17. getActiveGuidanceRulesForStage('FEE_PENDING') includes FEE_PARTIAL_APPLICANT_UNPAID with its sources", async () => {
    const rules = await getActiveGuidanceRulesForStage("FEE_PENDING");
    const rule = rules.find((r) => r.guidance_key === "FEE_PARTIAL_APPLICANT_UNPAID");
    assert.ok(rule, "expected FEE_PARTIAL_APPLICANT_UNPAID at FEE_PENDING");
    assert.strictEqual(rule.severity, "WARNING");
    assert.ok(rule.sources.length >= 2, "expected at least 2 cited sources (Rule 11 + Sidhi Vinayak)");
    assert.ok(!rule.sources.some((s) => s.source_type === "OTHER_HIGH_COURT" && rule.severity === "HARD_BLOCK"), "an OTHER_HIGH_COURT-only rule must never be HARD_BLOCK");
  });

  await record("18. no seeded HARD_BLOCK rule exists in LK-2", async () => {
    const [{ n }] = await sql`select count(*)::int as n from legal_guidance_rules where severity = 'HARD_BLOCK'`;
    assert.strictEqual(n, 0, "LK-2 must not seed any HARD_BLOCK guidance rule");
  });

  // ------------------------------------------------------------------
  // 19/20. Invariant snapshot (after) - no PIM workflow mutation at all
  // ------------------------------------------------------------------
  await record("19. PIM-number sequence (2026) unchanged by this entire test run", async () => {
    const [seqAfter] = await sql`select last_number from pim_number_sequences where year = 2026`;
    assert.strictEqual(seqAfter.last_number, seqBefore.last_number);
    assert.strictEqual(seqBefore.last_number, 118, "expected the known production invariant last_number = 118");
  });

  await record("20. mediator roster and pim_cases row count unchanged by this entire test run", async () => {
    const [mediatorCountAfter] = await sql`select count(*)::int as n from mediators where active = true`;
    const [caseCountAfter] = await sql`select count(*)::int as n from pim_cases`;
    assert.strictEqual(mediatorCountAfter.n, mediatorCountBefore.n);
    assert.strictEqual(mediatorCountBefore.n, 5, "expected the known production invariant of 5 active mediators");
    assert.strictEqual(caseCountAfter.n, caseCountBefore.n, "expected zero net change to pim_cases row count");
  });

  await cleanup();

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  - ${f.name}: ${f.err.message}`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  try {
    await cleanup();
  } catch (cleanupErr) {
    console.error("Cleanup also failed - run with --cleanup-only:", cleanupErr);
  }
  process.exitCode = 1;
});
