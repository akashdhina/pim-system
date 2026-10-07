/* eslint-disable @typescript-eslint/no-require-imports */

const { officeDate } = require("./pim-time");

const CLOSED_STATUSES = [
  "CLOSED_SETTLED",
  "CLOSED_FAILED",
  "CLOSED_NON_STARTER",
  "WITHDRAWN",
];

const REPORTS = {
  register: {
    title: "PIM Register",
    description: "Registered PIM matters with party, status, and workflow counts. One row per case.",
    dateLabel: "Registration date",
    dateColumn: "c.registration_date",
    defaultSort: "registration_date",
    defaultDirection: "desc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number", "c.dispute_description"],
    searchExists: partySearchExists("c.id"),
    filters: ["status", "outcome", "priority", "category", "mediatorId"],
    sortColumns: {
      pim_number: "c.pim_number",
      received_number: "c.received_number",
      registration_date: "c.registration_date",
      received_date: "c.received_date",
      status_name: "s.name",
      claim_amount: "c.claim_amount",
      priority: "c.priority",
      pending_tasks: "pending_tasks",
      mediator_name: "m.name",
      closed_at: "c.closed_at",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["received_number", "Received number", "text"],
      ["received_date", "Date received", "date"],
      ["registration_date", "Date registered", "date"],
      ["applicant_name", "Applicant", "text"],
      ["opposite_party_name", "Opposite party", "text"],
      ["claim_amount", "Claim amount", "currency"],
      ["status_name", "Current status", "text"],
      ["stage_name", "Current stage", "text"],
      ["pending_action", "Pending action", "text"],
      ["mediator_name", "Mediator", "text"],
      ["outcome_label", "Outcome", "text"],
      ["closed_at", "Closure date", "date"],
    ],
    from: `
      FROM pim_cases c
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN dispute_categories dc ON dc.id = c.dispute_category_id
      LEFT JOIN pim_mediator_assignments ma ON ma.case_id = c.id AND ma.status = 'ACTIVE'
      LEFT JOIN mediators m ON m.id = ma.mediator_id
    `,
    select: `
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.received_date,
        c.registration_date,
        c.claim_amount,
        c.priority,
        c.outcome_type,
        c.closed_at,
        s.code AS status_code,
        s.name AS status_name,
        s.stage AS stage_name,
        dc.name AS category_name,
        m.name AS mediator_name,
        ${multiPartyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        ${multiPartyNameSelect("c.id", "OPPOSITE_PARTY")} AS opposite_party_name,
        CASE c.outcome_type
          WHEN 'SETTLED' THEN 'Settled'
          WHEN 'FAILED' THEN 'Failed'
          WHEN 'NON_STARTER' THEN 'Non-starter'
          WHEN 'WITHDRAWN' THEN 'Withdrawn'
          ELSE NULL
        END AS outcome_label,
        (
          SELECT COUNT(*)
          FROM pim_tasks t
          WHERE t.case_id = c.id
            AND t.status = 'PENDING'
        ) AS pending_tasks,
        (
          SELECT t2.description
          FROM pim_tasks t2
          WHERE t2.case_id = c.id
            AND t2.status = 'PENDING'
          ORDER BY date(t2.due_date), t2.id
          LIMIT 1
        ) AS pending_action,
        (
          SELECT COUNT(*)
          FROM pim_documents d
          WHERE d.case_id = c.id
        ) AS documents_count
    `,
  },
  pending: {
    title: "Pending Action Report",
    description: "Active pending tasks. Terminal cases only appear here if a task was left pending in error (an integrity issue).",
    dateLabel: "Due date",
    dateColumn: "t.due_date",
    defaultSort: "overdue_first",
    defaultDirection: "asc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number", "t.description"],
    searchExists: partySearchExists("c.id"),
    filters: ["status", "priority", "category"],
    baseWhere: ["t.status = 'PENDING'"],
    selectParams: () => [officeDate(), officeDate()],
    sortColumns: {
      pim_number: "c.pim_number",
      status_name: "s.name",
      priority: "c.priority",
      due_date: "t.due_date",
      task_type: "t.task_type_code",
      overdue_first: "is_overdue DESC, t.due_date ASC, c.id",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["status_name", "Current status", "text"],
      ["task_type", "Task type", "text"],
      ["description", "Task", "text"],
      ["due_date", "Due date", "date"],
      ["overdue_label", "Overdue", "text"],
    ],
    from: `
      FROM pim_tasks t
      JOIN pim_cases c ON c.id = t.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN dispute_categories dc ON dc.id = c.dispute_category_id
    `,
    select: `
      SELECT
        t.id,
        c.id AS case_id,
        c.pim_number,
        c.received_number,
        c.priority,
        s.code AS status_code,
        s.name AS status_name,
        dc.name AS category_name,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        t.task_type_code AS task_type,
        t.description,
        t.due_date,
        CASE
          WHEN t.due_date IS NULL THEN 0
          WHEN t.due_date < ? THEN 1
          ELSE 0
        END AS is_overdue,
        CASE
          WHEN t.due_date IS NULL THEN 'No due date'
          WHEN t.due_date < ? THEN 'Overdue'
          ELSE 'On time'
        END AS overdue_label
    `,
  },
  overdue: {
    title: "Overdue Report",
    description: "Pending tasks whose due date has passed. Tasks with no stored due date are never classified as overdue.",
    dateLabel: "Due date",
    dateColumn: "t.due_date",
    defaultSort: "days_overdue",
    defaultDirection: "desc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number", "t.description"],
    searchExists: partySearchExists("c.id"),
    filters: ["status", "priority", "category"],
    baseWhere: [
      "t.status = 'PENDING'",
      "t.due_date IS NOT NULL",
      "t.due_date < ?",
    ],
    baseParams: () => [officeDate()],
    selectParams: () => [officeDate()],
    sortColumns: {
      pim_number: "c.pim_number",
      status_name: "s.name",
      days_overdue: "days_overdue",
      due_date: "t.due_date",
      responsible_stage: "s.stage",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["task_type", "Task", "text"],
      ["due_date", "Due date", "date"],
      ["days_overdue", "Days overdue", "number"],
      ["status_name", "Current status", "text"],
      ["responsible_stage", "Responsible stage", "text"],
    ],
    from: `
      FROM pim_tasks t
      JOIN pim_cases c ON c.id = t.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN dispute_categories dc ON dc.id = c.dispute_category_id
    `,
    select: `
      SELECT
        t.id,
        c.id AS case_id,
        c.pim_number,
        c.received_number,
        c.priority,
        s.code AS status_code,
        s.name AS status_name,
        s.stage AS responsible_stage,
        dc.name AS category_name,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        t.task_type_code AS task_type,
        t.due_date,
        CAST(julianday(?) - julianday(t.due_date) AS INTEGER) AS days_overdue
    `,
  },
  mediators: {
    title: "Mediator Register",
    description: "Mediator panel with assignment and session aggregates.",
    dateLabel: "Empanelment date",
    dateColumn: "m.empanelment_date",
    defaultSort: "name",
    defaultDirection: "asc",
    tieBreaker: "m.id",
    searchColumns: ["m.name", "m.enrollment_no", "m.contact_phone", "m.email"],
    filters: ["active", "category"],
    filterMap: {
      category: "m.category",
    },
    sortColumns: {
      name: "m.name",
      category: "m.category",
      empanelment_date: "m.empanelment_date",
      panel_valid_until: "m.panel_valid_until",
      active_assignments: "active_assignments",
      total_sessions: "total_sessions",
    },
    columns: [
      ["name", "Mediator", "text"],
      ["category", "Category", "text"],
      ["enrollment_no", "Enrollment", "text"],
      ["contact_phone", "Phone", "text"],
      ["empanelment_date", "Empanelment", "date"],
      ["panel_valid_until", "Valid until", "date"],
      ["active_label", "Active", "text"],
      ["active_assignments", "Active assigned cases", "number"],
      ["mediation_pending_cases", "Mediation pending", "number"],
      ["mediation_ongoing_cases", "Mediation ongoing", "number"],
      ["closed_settled_cases", "Closed settled", "number"],
      ["closed_failed_cases", "Closed failed", "number"],
      ["reassigned_away_cases", "Reassigned away", "number"],
      ["total_sessions", "Sessions", "number"],
    ],
    from: `
      FROM mediators m
      LEFT JOIN pim_mediator_assignments a ON a.mediator_id = m.id
      LEFT JOIN pim_cases ac ON ac.id = a.case_id
      LEFT JOIN status_master acs ON acs.id = ac.current_status_id
      LEFT JOIN mediation_sessions ms ON ms.assignment_id = a.id
    `,
    groupBy: "GROUP BY m.id",
    select: `
      SELECT
        m.id,
        m.name,
        m.category,
        m.enrollment_no,
        m.contact_phone,
        m.email,
        m.empanelment_date,
        m.panel_valid_until,
        CASE WHEN m.active = 1 THEN 'Yes' ELSE 'No' END AS active_label,
        SUM(CASE WHEN a.status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_assignments,
        COUNT(DISTINCT a.id) AS total_assignments,
        COUNT(DISTINCT ms.id) AS total_sessions,
        SUM(CASE WHEN ms.effective_session = 1 THEN 1 ELSE 0 END) AS effective_sessions,
        COUNT(DISTINCT CASE WHEN a.status = 'ACTIVE' AND acs.code = 'MEDIATION_PENDING' THEN a.case_id END) AS mediation_pending_cases,
        COUNT(DISTINCT CASE WHEN a.status = 'ACTIVE' AND acs.code = 'MEDIATION_ONGOING' THEN a.case_id END) AS mediation_ongoing_cases,
        COUNT(DISTINCT CASE WHEN a.status = 'ACTIVE' AND acs.code = 'CLOSED_SETTLED' THEN a.case_id END) AS closed_settled_cases,
        COUNT(DISTINCT CASE WHEN a.status = 'ACTIVE' AND acs.code = 'CLOSED_FAILED' THEN a.case_id END) AS closed_failed_cases,
        COUNT(DISTINCT CASE WHEN a.status = 'ENDED' THEN a.case_id END) AS reassigned_away_cases
    `,
  },
  sessions: {
    title: "Mediation Session Register",
    description: "Scheduled and recorded mediation sittings.",
    dateLabel: "Session date",
    dateColumn: "COALESCE(ms.actual_date, ms.scheduled_date)",
    defaultSort: "session_date",
    defaultDirection: "desc",
    tieBreaker: "ms.id",
    searchColumns: ["c.pim_number", "c.received_number", "m.name", "ms.administrative_remarks"],
    searchExists: partySearchExists("c.id"),
    filters: ["sessionStatus", "status", "category", "mediatorId"],
    sortColumns: {
      pim_number: "c.pim_number",
      session_date: "COALESCE(ms.actual_date, ms.scheduled_date)",
      sitting_number: "ms.sitting_number",
      mediator_name: "m.name",
      session_status: "ms.session_status",
      effective_session: "ms.effective_session",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["opposite_party_name", "Opposite party", "text"],
      ["mediator_name", "Mediator", "text"],
      ["sitting_number", "Sitting", "number"],
      ["session_date", "Session date", "date"],
      ["presence", "Presence", "text"],
      ["effective_label", "Effective", "text"],
      ["actual_start_time", "Start", "text"],
      ["actual_end_time", "End", "text"],
      ["duration_minutes", "Duration (min)", "number"],
      ["next_action_label", "Next action", "text"],
      ["session_status", "Status", "text"],
      ["report_label", "Report", "text"],
    ],
    from: `
      FROM mediation_sessions ms
      JOIN pim_cases c ON c.id = ms.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN dispute_categories dc ON dc.id = c.dispute_category_id
      LEFT JOIN pim_mediator_assignments a ON a.id = ms.assignment_id
      LEFT JOIN mediators m ON m.id = a.mediator_id
    `,
    totalsSelect: `
      COUNT(ms.id) AS total_sittings,
      SUM(CASE WHEN ms.effective_session = 1 THEN 1 ELSE 0 END) AS effective_sittings,
      SUM(CASE WHEN ms.effective_session = 1 THEN 0 ELSE 1 END) AS ineffective_sittings,
      SUM(CASE WHEN ms.effective_session = 1 THEN COALESCE(ms.duration_minutes, 0) ELSE 0 END) AS cumulative_effective_duration_minutes
    `,
    select: `
      SELECT
        ms.id,
        c.id AS case_id,
        c.pim_number,
        c.received_number,
        s.name AS status_name,
        dc.name AS category_name,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        ${partyNameSelect("c.id", "OPPOSITE_PARTY")} AS opposite_party_name,
        m.name AS mediator_name,
        ms.sitting_number,
        COALESCE(ms.actual_date, ms.scheduled_date) AS session_date,
        ms.session_status,
        ms.actual_start_time,
        ms.actual_end_time,
        ms.duration_minutes,
        CASE ms.next_action
          WHEN 'FURTHER_MEDIATION' THEN 'Further mediation'
          WHEN 'READY_FOR_SETTLEMENT' THEN 'Ready for settlement'
          WHEN 'READY_FOR_FAILURE' THEN 'Ready for failure'
          ELSE NULL
        END AS next_action_label,
        CASE
          WHEN ms.applicant_present = 1 AND ms.opposite_party_present = 1 THEN 'Both present'
          WHEN ms.applicant_present = 1 THEN 'Applicant only'
          WHEN ms.opposite_party_present = 1 THEN 'Opposite party only'
          ELSE 'Absent'
        END AS presence,
        CASE WHEN ms.effective_session = 1 THEN 'Yes' ELSE 'No' END AS effective_label,
        CASE WHEN ms.report_received = 1 THEN 'Received' ELSE 'Pending' END AS report_label
    `,
  },
  monitoring: {
    title: "60-Day Monitoring",
    description: "Open matters tracked against statutory and internal timelines.",
    dateLabel: "60-day date",
    dateColumn: "c.internal_60_day_date",
    defaultSort: "days_remaining",
    defaultDirection: "asc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number", "c.dispute_description"],
    searchExists: partySearchExists("c.id"),
    selectParams: () => [
      officeDate(),
      officeDate(),
      officeDate(),
    ],
    filters: ["status", "priority", "category"],
    baseWhere: [
      `COALESCE(s.code, '') NOT IN (${CLOSED_STATUSES.map(() => "?").join(",")})`,
      "c.internal_60_day_date IS NOT NULL",
    ],
    baseParams: CLOSED_STATUSES,
    sortColumns: {
      pim_number: "c.pim_number",
      internal_60_day_date: "c.internal_60_day_date",
      statutory_due_date: "c.statutory_due_date",
      days_remaining: "days_remaining",
      status_name: "s.name",
      priority: "c.priority",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["status_name", "Status", "text"],
      ["priority", "Priority", "text"],
      ["statutory_due_date", "Statutory due", "date"],
      ["internal_60_day_date", "Internal 60-day", "date"],
      ["days_remaining", "Days remaining", "number"],
      ["monitoring_status", "Monitoring", "text"],
    ],
    from: `
      FROM pim_cases c
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN dispute_categories dc ON dc.id = c.dispute_category_id
    `,
    select: `
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.priority,
        c.statutory_due_date,
        c.internal_60_day_date,
        s.code AS status_code,
        s.name AS status_name,
        dc.name AS category_name,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        CAST(julianday(c.internal_60_day_date) - julianday(?) AS INTEGER) AS days_remaining,
        CASE
          WHEN c.internal_60_day_date < ? THEN 'Overdue'
          WHEN c.internal_60_day_date <= date(?, '+7 day') THEN 'Due within 7 days'
          ELSE 'On track'
        END AS monitoring_status
    `,
  },
  outcomes: {
    title: "Outcome Statistics",
    description: "Outcome totals and duration statistics by result type.",
    dateLabel: "Outcome date",
    dateColumn: "c.outcome_date",
    defaultSort: "case_count",
    defaultDirection: "desc",
    tieBreaker: "id",
    searchColumns: ["c.outcome_type"],
    filters: ["outcome", "status", "category"],
    sortColumns: {
      outcome_type: "c.outcome_type",
      case_count: "case_count",
      total_claim_amount: "total_claim_amount",
      average_days_to_outcome: "average_days_to_outcome",
      latest_outcome_date: "latest_outcome_date",
    },
    columns: [
      ["outcome_type", "Outcome", "text"],
      ["case_count", "Cases", "number"],
      ["settled_count", "Settled", "number"],
      ["failed_count", "Failed", "number"],
      ["nonstarter_count", "Non-starter", "number"],
      ["withdrawn_count", "Withdrawn", "number"],
      ["total_claim_amount", "Claim total", "currency"],
      ["average_days_to_outcome", "Avg days", "number"],
      ["latest_outcome_date", "Latest outcome", "date"],
    ],
    from: `
      FROM pim_cases c
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN dispute_categories dc ON dc.id = c.dispute_category_id
    `,
    baseWhere: ["c.outcome_type IS NOT NULL"],
    groupBy: "GROUP BY c.outcome_type",
    select: `
      SELECT
        MIN(c.id) AS id,
        COALESCE(c.outcome_type, 'PENDING') AS outcome_type,
        COUNT(c.id) AS case_count,
        SUM(CASE WHEN c.outcome_type = 'SETTLED' THEN 1 ELSE 0 END) AS settled_count,
        SUM(CASE WHEN c.outcome_type = 'FAILED' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN c.outcome_type = 'NON_STARTER' THEN 1 ELSE 0 END) AS nonstarter_count,
        SUM(CASE WHEN c.outcome_type = 'WITHDRAWN' THEN 1 ELSE 0 END) AS withdrawn_count,
        SUM(COALESCE(c.claim_amount, 0)) AS total_claim_amount,
        ROUND(AVG(julianday(c.outcome_date) - julianday(c.registration_date)), 1) AS average_days_to_outcome,
        MAX(c.outcome_date) AS latest_outcome_date
    `,
  },
  documents: {
    title: "Document Register",
    description: "Generated and uploaded documents with case linkage.",
    dateLabel: "Document date",
    dateColumn: "COALESCE(d.document_date, d.created_at)",
    defaultSort: "created_at",
    defaultDirection: "desc",
    tieBreaker: "d.id",
    searchColumns: ["d.document_title", "d.document_type", "c.pim_number", "c.received_number"],
    searchExists: partySearchExists("c.id"),
    filters: ["documentType", "status"],
    sortColumns: {
      document_title: "d.document_title",
      document_type: "d.document_type",
      document_date: "d.document_date",
      created_at: "d.created_at",
      version_no: "d.version_no",
      pim_number: "c.pim_number",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["document_type", "Type", "documentType"],
      ["document_title", "Title", "text"],
      ["document_date", "Document date", "date"],
      ["version_no", "Version", "number"],
      ["current_label", "Current", "text"],
      ["created_at", "Created", "date"],
      ["created_by_name", "Created by", "text"],
    ],
    from: `
      FROM pim_documents d
      JOIN pim_cases c ON c.id = d.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN users u ON u.id = d.created_by
    `,
    baseWhere: ["d.file_path IS NOT NULL", "TRIM(d.file_path) <> ''"],
    select: `
      SELECT
        d.id,
        c.id AS case_id,
        c.pim_number,
        c.received_number,
        s.name AS status_name,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        d.document_type,
        d.document_title,
        d.document_date,
        d.version_no,
        CASE WHEN d.is_current = 1 THEN 'Yes' ELSE 'No' END AS current_label,
        d.created_at,
        u.display_name AS created_by_name
    `,
  },
  notices: {
    title: "Notice / Service Report",
    description: "Form II notices with service/return outcome. Preserves the distinction between a postal refusal and a substantive OP refusal to mediate.",
    dateLabel: "Issue date",
    dateColumn: "n.notice_date",
    defaultSort: "notice_date",
    defaultDirection: "desc",
    tieBreaker: "n.id",
    searchColumns: ["c.pim_number", "c.received_number", "p.name"],
    filters: ["noticeType", "noticeStatus", "returnReason", "status"],
    sortColumns: {
      pim_number: "c.pim_number",
      notice_date: "n.notice_date",
      appearance_date: "n.appearance_date",
      notice_status: "n.status",
      return_reason: "sa.return_reason",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["notice_type_label", "Notice type", "text"],
      ["recipient_name", "Opposite party", "text"],
      ["address_used", "Address used", "text"],
      ["notice_date", "Issue date", "date"],
      ["appearance_date", "Appearance date", "date"],
      ["notice_status", "Service result", "text"],
      ["service_date", "Service date", "date"],
      ["return_reason", "Return reason", "text"],
      ["postal_endorsement", "Postal endorsement", "text"],
      ["status_name", "Next stage", "text"],
    ],
    from: `
      FROM pim_notices n
      JOIN pim_cases c ON c.id = n.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
      LEFT JOIN pim_addresses addr ON addr.id = n.address_id
      LEFT JOIN pim_service_attempts sa ON sa.id = (
        SELECT sa2.id
        FROM pim_service_attempts sa2
        WHERE sa2.notice_id = n.id
        ORDER BY sa2.id DESC
        LIMIT 1
      )
    `,
    select: `
      SELECT
        n.id,
        c.id AS case_id,
        c.pim_number,
        c.received_number,
        s.name AS status_name,
        n.notice_type,
        CASE n.notice_type
          WHEN 'FORM_2_INITIAL' THEN 'Initial Form II'
          WHEN 'FORM_2_FINAL' THEN 'Final Form II'
          ELSE n.notice_type
        END AS notice_type_label,
        p.name AS recipient_name,
        n.notice_date,
        n.appearance_date,
        n.status AS notice_status,
        COALESCE(sa.delivered_date, sa.returned_date, sa.dispatch_date) AS service_date,
        sa.return_reason,
        sa.postal_endorsement,
        (
          addr.address_line1 ||
          COALESCE(', ' || addr.address_line2, '') ||
          COALESCE(', ' || addr.village_town, '') ||
          COALESCE(', ' || addr.district, '') ||
          COALESCE(', ' || addr.state, '') ||
          COALESCE(' - ' || addr.pincode, '')
        ) AS address_used
    `,
  },
  address_correction: {
    title: "Address-Correction Pending",
    description: "Notices returned and awaiting a corrected address (ADDRESS_CORRECTION_PENDING).",
    dateLabel: "Date returned",
    dateColumn: "sa.returned_date",
    defaultSort: "age_days",
    defaultDirection: "desc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number", "p.name"],
    filters: [],
    baseWhere: [
      "s.code = 'ADDRESS_CORRECTION_PENDING'",
      "n.status = 'RETURNED'",
    ],
    selectParams: () => [officeDate()],
    sortColumns: {
      pim_number: "c.pim_number",
      returned_date: "sa.returned_date",
      age_days: "age_days",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["recipient_name", "Opposite party", "text"],
      ["notice_type_label", "Returned notice", "text"],
      ["postal_endorsement", "Postal endorsement", "text"],
      ["returned_date", "Date returned", "date"],
      ["pending_action", "Pending action", "text"],
      ["age_days", "Age (days)", "number"],
    ],
    from: `
      FROM pim_notices n
      JOIN pim_cases c ON c.id = n.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
      LEFT JOIN pim_parties p ON p.id = n.recipient_party_id
      LEFT JOIN pim_service_attempts sa ON sa.id = (
        SELECT sa2.id
        FROM pim_service_attempts sa2
        WHERE sa2.notice_id = n.id
          AND sa2.returned_date IS NOT NULL
        ORDER BY sa2.id DESC
        LIMIT 1
      )
    `,
    select: `
      SELECT
        n.id,
        c.id AS case_id,
        c.pim_number,
        c.received_number,
        p.name AS recipient_name,
        CASE n.notice_type
          WHEN 'FORM_2_INITIAL' THEN 'Initial Form II'
          WHEN 'FORM_2_FINAL' THEN 'Final Form II'
          ELSE n.notice_type
        END AS notice_type_label,
        sa.postal_endorsement,
        sa.return_reason,
        sa.returned_date,
        (
          SELECT t2.description
          FROM pim_tasks t2
          WHERE t2.case_id = c.id
            AND t2.status = 'PENDING'
          ORDER BY date(t2.due_date), t2.id
          LIMIT 1
        ) AS pending_action,
        CAST(julianday(?) - julianday(sa.returned_date) AS INTEGER) AS age_days
    `,
  },
  final_notice_pending: {
    title: "Final Notice Pending",
    description: "Cases where a Final Form II needs preparation, or has been issued and service/response is still awaited. Uses existing status and tasks only.",
    dateLabel: "Registration date",
    dateColumn: "c.registration_date",
    defaultSort: "registration_date",
    defaultDirection: "asc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number"],
    searchExists: partySearchExists("c.id"),
    filters: ["status"],
    baseWhere: [
      `(
        s.code = 'FINAL_NOTICE_PENDING'
        OR (
          s.code = 'SERVICE_PENDING'
          AND EXISTS (
            SELECT 1 FROM pim_notices n
            WHERE n.case_id = c.id
              AND n.notice_type = 'FORM_2_FINAL'
              AND n.id = (SELECT MAX(n2.id) FROM pim_notices n2 WHERE n2.case_id = c.id)
          )
        )
      )`,
    ],
    sortColumns: {
      pim_number: "c.pim_number",
      registration_date: "c.registration_date",
      status_name: "s.name",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["opposite_party_name", "Opposite party", "text"],
      ["status_name", "Current status", "text"],
      ["registration_date", "Registration", "date"],
      ["pending_action", "Pending action", "text"],
    ],
    from: `
      FROM pim_cases c
      LEFT JOIN status_master s ON s.id = c.current_status_id
    `,
    select: `
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.registration_date,
        s.name AS status_name,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        ${partyNameSelect("c.id", "OPPOSITE_PARTY")} AS opposite_party_name,
        (
          SELECT t2.description
          FROM pim_tasks t2
          WHERE t2.case_id = c.id
            AND t2.status = 'PENDING'
          ORDER BY date(t2.due_date), t2.id
          LIMIT 1
        ) AS pending_action
    `,
  },
  fees_pending: {
    title: "Fee Pending Report",
    description: "Case-level mediation fee (Rule 11) with due/received/balance. One row per case. Application fee is excluded.",
    dateLabel: "Registration date",
    dateColumn: "c.registration_date",
    defaultSort: "balance",
    defaultDirection: "desc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number"],
    searchExists: partySearchExists("c.id"),
    filters: ["status", "feeStatus"],
    baseWhere: [
      "f.fee_type = 'MEDIATION_FEE'",
      "(f.amount_due IS NULL OR f.amount_received < f.amount_due)",
    ],
    sortColumns: {
      pim_number: "c.pim_number",
      claim_amount: "c.claim_amount",
      amount_due: "f.amount_due",
      amount_received: "f.amount_received",
      balance: "balance",
      fee_status: "f.status",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["claim_amount", "Claim amount", "currency"],
      ["amount_due", "Mediation fee due", "currency"],
      ["amount_received", "Amount received", "currency"],
      ["balance", "Balance", "currency"],
      ["last_payment_date", "Last payment", "date"],
      ["fee_status", "Status", "text"],
    ],
    from: `
      FROM pim_fees f
      JOIN pim_cases c ON c.id = f.case_id
      LEFT JOIN status_master s ON s.id = c.current_status_id
    `,
    select: `
      SELECT
        f.id,
        c.id AS case_id,
        c.pim_number,
        c.received_number,
        c.claim_amount,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        f.amount_due,
        f.amount_received,
        MAX(COALESCE(f.amount_due, 0) - COALESCE(f.amount_received, 0), 0) AS balance,
        f.received_date AS last_payment_date,
        f.status AS fee_status
    `,
  },
  non_starters: {
    title: "Non-Starter Report",
    description: "Cases closed as non-starter, with reason breakdown and Form III availability.",
    dateLabel: "Outcome date",
    dateColumn: "c.outcome_date",
    defaultSort: "outcome_date",
    defaultDirection: "desc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number"],
    searchExists: partySearchExists("c.id"),
    filters: ["nonstarterReason"],
    filterMap: {
      nonstarterReason: "nr.code",
    },
    baseWhere: ["c.outcome_type = 'NON_STARTER'"],
    sortColumns: {
      pim_number: "c.pim_number",
      outcome_date: "c.outcome_date",
      reason_name: "nr.name",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["opposite_party_name", "Opposite party", "text"],
      ["reason_name", "Reason", "text"],
      ["rule_reference", "Rule reference", "text"],
      ["outcome_date", "Closure date", "date"],
      ["form3_label", "Form III", "text"],
    ],
    from: `
      FROM pim_cases c
      JOIN pim_outcomes o ON o.case_id = c.id
      LEFT JOIN nonstarter_reasons nr ON nr.id = o.nonstarter_reason_id
    `,
    select: `
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.outcome_date,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        ${partyNameSelect("c.id", "OPPOSITE_PARTY")} AS opposite_party_name,
        COALESCE(nr.name, o.reason_text) AS reason_name,
        nr.rule_reference,
        CASE WHEN EXISTS (
          SELECT 1 FROM pim_documents d
          WHERE d.case_id = c.id
            AND d.document_type = 'FORM_3'
            AND d.is_current = 1
            AND d.file_path IS NOT NULL
            AND TRIM(d.file_path) <> ''
        ) THEN 'Available' ELSE 'Not available' END AS form3_label
    `,
  },
  settlements: {
    title: "Settlement Report",
    description: "Cases closed as settled (Form IV).",
    dateLabel: "Closure date",
    dateColumn: "c.closed_at",
    defaultSort: "closed_at",
    defaultDirection: "desc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number"],
    searchExists: partySearchExists("c.id"),
    filters: ["mediatorId"],
    baseWhere: ["c.outcome_type = 'SETTLED'"],
    sortColumns: {
      pim_number: "c.pim_number",
      closed_at: "c.closed_at",
      mediator_name: "m.name",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["opposite_party_name", "Opposite party", "text"],
      ["mediator_name", "Mediator", "text"],
      ["final_sitting_date", "Final sitting date", "date"],
      ["closed_at", "Closure date", "date"],
      ["form4_label", "Form IV", "text"],
      ["settlement_terms_summary", "Settlement terms", "text"],
    ],
    from: `
      FROM pim_cases c
      LEFT JOIN pim_mediator_assignments a ON a.case_id = c.id AND a.status = 'ACTIVE'
      LEFT JOIN mediators m ON m.id = a.mediator_id
      LEFT JOIN pim_outcomes o ON o.case_id = c.id
    `,
    select: `
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.closed_at,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        ${partyNameSelect("c.id", "OPPOSITE_PARTY")} AS opposite_party_name,
        m.name AS mediator_name,
        (
          SELECT MAX(COALESCE(ms.actual_date, ms.scheduled_date))
          FROM mediation_sessions ms
          WHERE ms.case_id = c.id
        ) AS final_sitting_date,
        CASE WHEN EXISTS (
          SELECT 1 FROM pim_documents d
          WHERE d.case_id = c.id
            AND d.document_type = 'FORM_4'
            AND d.is_current = 1
            AND d.file_path IS NOT NULL
            AND TRIM(d.file_path) <> ''
        ) THEN 'Available' ELSE 'Not available' END AS form4_label,
        CASE
          WHEN o.settlement_terms IS NULL THEN NULL
          WHEN LENGTH(o.settlement_terms) > 80 THEN SUBSTR(o.settlement_terms, 1, 80) || '...'
          ELSE o.settlement_terms
        END AS settlement_terms_summary
    `,
  },
  failures: {
    title: "Failure Report",
    description: "Cases closed as failed (Form V). Non-starter cases are excluded.",
    dateLabel: "Closure date",
    dateColumn: "c.closed_at",
    defaultSort: "closed_at",
    defaultDirection: "desc",
    tieBreaker: "c.id",
    searchColumns: ["c.pim_number", "c.received_number"],
    searchExists: partySearchExists("c.id"),
    filters: ["mediatorId"],
    baseWhere: ["c.outcome_type = 'FAILED'"],
    sortColumns: {
      pim_number: "c.pim_number",
      closed_at: "c.closed_at",
      mediator_name: "m.name",
    },
    columns: [
      ["pim_number", "PIM number", "case"],
      ["applicant_name", "Applicant", "text"],
      ["opposite_party_name", "Opposite party", "text"],
      ["mediator_name", "Mediator", "text"],
      ["final_sitting_date", "Final sitting date", "date"],
      ["closed_at", "Closure date", "date"],
      ["reason_text", "Reason", "text"],
      ["form5_label", "Form V", "text"],
    ],
    from: `
      FROM pim_cases c
      LEFT JOIN pim_mediator_assignments a ON a.case_id = c.id AND a.status = 'ACTIVE'
      LEFT JOIN mediators m ON m.id = a.mediator_id
      LEFT JOIN pim_outcomes o ON o.case_id = c.id
    `,
    select: `
      SELECT
        c.id,
        c.pim_number,
        c.received_number,
        c.closed_at,
        ${partyNameSelect("c.id", "APPLICANT")} AS applicant_name,
        ${partyNameSelect("c.id", "OPPOSITE_PARTY")} AS opposite_party_name,
        m.name AS mediator_name,
        (
          SELECT MAX(COALESCE(ms.actual_date, ms.scheduled_date))
          FROM mediation_sessions ms
          WHERE ms.case_id = c.id
        ) AS final_sitting_date,
        o.reason_text,
        CASE WHEN EXISTS (
          SELECT 1 FROM pim_documents d
          WHERE d.case_id = c.id
            AND d.document_type = 'FORM_5'
            AND d.is_current = 1
            AND d.file_path IS NOT NULL
            AND TRIM(d.file_path) <> ''
        ) THEN 'Available' ELSE 'Not available' END AS form5_label
    `,
  },
  audit: {
    title: "Audit Register",
    description: "Audit trail entries across PIM records.",
    dateLabel: "Changed date",
    dateColumn: "a.changed_at",
    defaultSort: "changed_at",
    defaultDirection: "desc",
    tieBreaker: "a.id",
    searchColumns: ["a.table_name", "a.action", "a.reason", "u.display_name"],
    filters: ["action"],
    sortColumns: {
      changed_at: "a.changed_at",
      table_name: "a.table_name",
      action: "a.action",
      changed_by_name: "u.display_name",
      record_id: "a.record_id",
    },
    columns: [
      ["changed_at", "Changed", "date"],
      ["table_name", "Table", "text"],
      ["record_id", "Record", "number"],
      ["action", "Action", "text"],
      ["changed_by_name", "Changed by", "text"],
      ["reason", "Reason", "text"],
    ],
    from: `
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.changed_by
    `,
    select: `
      SELECT
        a.id,
        a.table_name,
        a.record_id,
        a.action,
        a.changed_at,
        a.reason,
        u.display_name AS changed_by_name
    `,
  },
};

function partyNameSelect(caseAlias, role) {
  return `(
    SELECT p.name
    FROM pim_case_parties cp
    JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseAlias}
      AND cp.role = '${role}'
    ORDER BY cp.is_primary DESC, cp.sequence_no
    LIMIT 1
  )`;
}

function multiPartyNameSelect(caseAlias, role) {
  return `(
    ${partyNameSelect(caseAlias, role)} ||
    CASE
      WHEN (
        SELECT COUNT(*)
        FROM pim_case_parties cpx
        WHERE cpx.case_id = ${caseAlias}
          AND cpx.role = '${role}'
      ) > 1
      THEN ' (+' || (
        (
          SELECT COUNT(*)
          FROM pim_case_parties cpx
          WHERE cpx.case_id = ${caseAlias}
            AND cpx.role = '${role}'
        ) - 1
      ) || ')'
      ELSE ''
    END
  )`;
}

function partySearchExists(caseAlias) {
  return `EXISTS (
    SELECT 1
    FROM pim_case_parties cp
    JOIN pim_parties p ON p.id = cp.party_id
    WHERE cp.case_id = ${caseAlias}
      AND p.name LIKE ?
  )`;
}

function positiveInt(value, fallback, max = 100) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    return fallback;
  }

  return Math.min(number, max);
}

function normalizedReportList() {
  return Object.entries(REPORTS).map(([key, report]) => ({
    key,
    title: report.title,
    description: report.description,
    dateLabel: report.dateLabel,
    filters: report.filters || [],
    columns: report.columns.map(([field, label, type]) => ({
      field,
      label,
      type,
      sortable: Boolean(report.sortColumns[field]),
    })),
    defaultSort: report.defaultSort,
    defaultDirection: report.defaultDirection,
  }));
}

function addSearch(report, where, params, search) {
  const text = String(search || "").trim();

  if (!text) return;

  const clauses = (report.searchColumns || []).map((column) => `${column} LIKE ?`);
  const searchParams = clauses.map(() => `%${text}%`);

  if (report.searchExists) {
    clauses.push(report.searchExists);
    searchParams.push(`%${text}%`);
  }

  if (clauses.length) {
    where.push(`(${clauses.join(" OR ")})`);
    params.push(...searchParams);
  }
}

function addFilter(report, where, params, name, value) {
  const text = String(value || "").trim();

  if (!text) return;

  const filterMap = report.filterMap || {};
  const common = {
    status: "s.code",
    outcome: "c.outcome_type",
    priority: "c.priority",
    category: "dc.code",
    active: "m.active",
    documentType: "d.document_type",
    action: "a.action",
    sessionStatus: "ms.session_status",
    mediatorId: "m.id",
    noticeType: "n.notice_type",
    noticeStatus: "n.status",
    returnReason: "sa.return_reason",
    feeStatus: "f.status",
  };
  const column = filterMap[name] || common[name];

  if (!column) return;

  where.push(`${column} = ?`);
  params.push(
    name === "active" || name === "mediatorId" ? Number(text) : text
  );
}

function buildReportQuery(key, searchParams) {
  const report = REPORTS[key] || REPORTS.register;
  const page = positiveInt(searchParams.get("page"), 1, 100000);
  const pageSize = positiveInt(searchParams.get("pageSize"), 20, 100);
  const offset = (page - 1) * pageSize;
  const where = [...(report.baseWhere || [])];
  const selectParams = report.selectParams
    ? report.selectParams()
    : [];
  const baseParamsValue =
    typeof report.baseParams === "function"
      ? report.baseParams()
      : report.baseParams || [];
  const params = [...baseParamsValue];

  addSearch(report, where, params, searchParams.get("search"));

  for (const filterName of report.filters || []) {
    addFilter(report, where, params, filterName, searchParams.get(filterName));
  }

  const dateFrom = String(searchParams.get("dateFrom") || "").trim();
  if (dateFrom) {
    where.push(`${report.dateColumn} >= ?`);
    params.push(dateFrom);
  }

  const dateTo = String(searchParams.get("dateTo") || "").trim();
  if (dateTo) {
    where.push(`${report.dateColumn} <= ?`);
    params.push(dateTo);
  }

  const sortKey = String(searchParams.get("sort") || report.defaultSort);
  const sortColumn = report.sortColumns[sortKey] || report.sortColumns[report.defaultSort];
  const direction = String(searchParams.get("direction") || report.defaultDirection).toLowerCase() === "asc"
    ? "ASC"
    : "DESC";
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const groupBySql = report.groupBy || "";
  const baseSql = `
    ${report.select}
    ${report.from}
    ${whereSql}
    ${groupBySql}
  `;
  const orderSql = `ORDER BY ${sortColumn} ${direction}, ${report.tieBreaker} DESC`;
  const queryParams = [...selectParams, ...params];

  let totalsSql = null;
  let totalsQueryParams = null;
  if (report.totalsSelect) {
    const totalsSelectParams = report.totalsSelectParams
      ? report.totalsSelectParams()
      : selectParams;
    totalsSql = `
      SELECT ${report.totalsSelect}
      ${report.from}
      ${whereSql}
    `;
    totalsQueryParams = [...totalsSelectParams, ...params];
  }

  return {
    report,
    page,
    pageSize,
    offset,
    params,
    queryParams,
    countSql: `SELECT COUNT(*) AS count FROM (${baseSql}) report_count`,
    rowsSql: `
      ${baseSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `,
    exportSql: `
      ${baseSql}
      ${orderSql}
      LIMIT ?
    `,
    totalsSql,
    totalsQueryParams,
  };
}

module.exports = {
  buildReportQuery,
  normalizedReportList,
  CLOSED_STATUSES,
  partyNameSelect,
  // Production-completion sprint (2026-10-07): exported for reuse by
  // lib/pim-data/reports.js (PostgreSQL) - the report definitions
  // (columns, filters, sortColumns, etc.) are dialect-neutral metadata,
  // reused rather than duplicated. Only its SQL-dialect fragments are
  // overridden there.
  REPORTS,
};
