/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * Phase LK-2: Legal Knowledge Base - server-side verified-only read path.
 *
 * This is the SOLE loader ordinary staff-facing code should use to read
 * legal_sources. Per the explicit instruction "Enforce this server-side.
 * Do NOT rely only on UI filtering," every query here hard-codes
 * `verification_state = 'PRIMARY_SOURCE_VERIFIED' and is_active = true` in
 * the WHERE clause itself - never left to a caller to remember to filter.
 * This is in addition to, not a substitute for, the RLS policy on
 * legal_sources (see the LK-2 schema migration) - defense in depth, since
 * today's reads go through a privileged direct connection
 * (lib/pim-postgres.js) that bypasses RLS, same as every other PIM table.
 *
 * DRAFT / DISCOVERED / REJECTED_MISMATCH / SUPERSEDED rows, and inactive
 * rows, are never reachable through any function in this file. An
 * admin/legal-maintainer surface that needs to see those states belongs in
 * a separate module (not built in LK-2 - see
 * lib/pim-data/legal-sources-admin.js for the one write operation LK-2 does
 * implement, verification-state transitions, which is server-side/data-layer
 * only, no API route or UI).
 */

const { getSql } = require("../pim-postgres");

async function getVerifiedLegalSources({ sourceType, topic } = {}) {
  const sql = getSql();

  const rows = await sql`
    select
      id, source_type, authority_level, title, court, case_number, citation,
      decision_date, jurisdiction, effective_from, effective_to,
      source_document_ref, source_url, primary_source_url,
      paragraph_refs, rule_refs, sop_clause_refs, topics,
      case_holding, operational_proposition, negative_rule,
      operational_effect, caution, treatment, superseded_by
    from legal_sources
    where verification_state = 'PRIMARY_SOURCE_VERIFIED'
      and is_active = true
      and (${sourceType ?? null}::text is null or source_type = ${sourceType ?? null})
      and (${topic ?? null}::text is null or ${topic ?? null} = any(topics))
    order by authority_level asc, decision_date desc nulls last, title asc
  `;

  return rows;
}

async function getVerifiedLegalSourcesForStage(statusCode) {
  const sql = getSql();

  const rows = await sql`
    select
      s.id, s.source_type, s.authority_level, s.title, s.court, s.case_number,
      s.citation, s.decision_date, s.jurisdiction,
      s.case_holding, s.operational_proposition, s.negative_rule,
      s.operational_effect, s.caution
    from legal_sources s
    join legal_source_workflow_stages w on w.legal_source_id = s.id
    where w.status_code = ${statusCode}
      and s.verification_state = 'PRIMARY_SOURCE_VERIFIED'
      and s.is_active = true
    order by s.authority_level asc, s.title asc
  `;

  return rows;
}

async function getActiveGuidanceRulesForStage(statusCode) {
  const sql = getSql();

  const rules = await sql`
    select
      g.id, g.guidance_key, g.title, g.trigger_condition, g.severity,
      g.summary, g.staff_action, g.do_not_do
    from legal_guidance_rules g
    join legal_guidance_rule_stages gs on gs.guidance_rule_id = g.id
    where gs.status_code = ${statusCode}
      and g.is_active = true
      and (g.effective_from is null or g.effective_from <= current_date)
      and (g.effective_to is null or g.effective_to >= current_date)
    order by
      case g.severity
        when 'HARD_BLOCK' then 1
        when 'WARNING' then 2
        when 'INFORMATION' then 3
        when 'REFERENCE_ONLY' then 4
      end,
      g.title asc
  `;

  if (rules.length === 0) return [];

  const ruleIds = rules.map((r) => r.id);
  const sources = await sql`
    select
      grs.guidance_rule_id, s.id as source_id, s.source_type,
      s.authority_level, s.title, s.citation, s.jurisdiction
    from legal_guidance_rule_sources grs
    join legal_sources s on s.id = grs.legal_source_id
    where grs.guidance_rule_id in ${sql(ruleIds)}
      and s.verification_state = 'PRIMARY_SOURCE_VERIFIED'
      and s.is_active = true
    order by s.authority_level asc
  `;

  const sourcesByRule = new Map();
  for (const row of sources) {
    const list = sourcesByRule.get(row.guidance_rule_id) || [];
    list.push({
      id: row.source_id,
      source_type: row.source_type,
      authority_level: row.authority_level,
      title: row.title,
      citation: row.citation,
      jurisdiction: row.jurisdiction,
    });
    sourcesByRule.set(row.guidance_rule_id, list);
  }

  return rules.map((rule) => ({
    ...rule,
    sources: sourcesByRule.get(rule.id) || [],
  }));
}

module.exports = {
  getVerifiedLegalSources,
  getVerifiedLegalSourcesForStage,
  getActiveGuidanceRulesForStage,
};
