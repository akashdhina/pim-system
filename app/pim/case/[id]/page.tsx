"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getCaseAction,
  getTaskAction,
} from "../../../../lib/pim-action-link";
import { documentTypeLabel } from "../../../../lib/pim-document-labels";

type CaseData = {
  id: number;
  entry_type: string | null;
  pim_number: string | null;
  received_number: string | null;
  received_date: string | null;
  application_date: string | null;
  registration_date: string | null;
  claim_amount: number | null;
  dispute_description: string | null;
  status_code: string;
  status_name: string;
  outcome_type: string | null;
  outcome_date: string | null;
  statutory_due_date: string | null;
  internal_60_day_date: string | null;
  priority: string | null;
  remarks: string | null;
  closed_at: string | null;
};

type Data = {
  case: CaseData;
  parties: any[];
  addresses: any[];
  advocates: any[];
  statusHistory: any[];
  docket: any[];
  tasks: any[];
  notices: any[];
  serviceAttempts: any[];
  responses: any[];
  fees: any[];
  feeSummary: {
    mediationFee: { amountDue: number | null; amountReceived: number; balance: number | null; status: string } | null;
    applicationFee: { amountDue: number | null; amountReceived: number; balance: number | null; status: string } | null;
  };
  mediatorAssignments: any[];
  sessions: any[];
  cumulativeDurationMinutes: number;
  outcome: any;
  documents: any[];
  warnings: { code: string; message: string }[];
};

function money(value: any) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "-";
  }

  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "-";
  }

  return `₹${amount.toLocaleString("en-IN")}`;
}

function date(value: any) {
  if (!value) {
    return "-";
  }

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return value;
  }

  return d.toLocaleDateString("en-IN");
}

function formatDuration(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined) {
    return "-";
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

function noticeLabel(noticeType: string) {
  return noticeType === "FORM_2_FINAL" ? "Final Notice" : "Initial Notice";
}

function namesByRole(parties: any[], role: string) {
  const names = parties
    .filter((party) => party.role === role)
    .map(
      (party) =>
        party.name + (party.is_primary ? " (Primary)" : "")
    );

  return names.length > 0 ? names.join("; ") : "Not recorded";
}

/*
 * Extra staff-friendly context for a handful of statuses where
 * the plain status_master.name alone doesn't convey the next
 * concrete step (rule 14). Never changes the stored status code.
 */
const STATUS_NOTES: Record<string, string> = {
  FORM2_PENDING: "Initial Notice preparation pending.",
  MEDIATOR_ASSIGNED: "Mediator assigned - first mediation date to be fixed.",
  MEDIATION_PENDING: "First mediation sitting pending.",
  MEDIATION_ONGOING: "Mediation in progress - further sittings may be recorded.",
  ADDRESS_CORRECTION_PENDING: "Notice returned - corrected address required.",
  FINAL_NOTICE_PENDING: "Final Notice preparation pending.",
  OUTCOME_FORM_PENDING: "Mediation concluded - outcome (settlement/failure) to be recorded.",
  AUTHORITY_DECISION_PENDING: "Awaiting authority decision on non-starter closure.",
};

function statusClass(status: string) {
  if (status.startsWith("CLOSED")) {
    return "bg-green-100 text-green-800";
  }

  if (
    status.includes("PENDING") ||
    status.includes("ONGOING")
  ) {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-blue-100 text-blue-800";
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-white p-5 shadow-sm">
      <h2 className="mb-4 border-b pb-3 text-lg font-semibold">
        {title}
      </h2>

      {children}
    </section>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: any;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </div>

      <div className="mt-1 text-sm text-gray-900">
        {value ?? "-"}
      </div>
    </div>
  );
}

function formatAddress(values: any[]) {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (
      value === null ||
      value === undefined
    ) {
      continue;
    }

    const text = String(value).trim();

    if (!text) {
      continue;
    }

    const components =
      text
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    for (const component of components) {
      const key =
        component
          .replace(/\s+/g, " ")
          .toLowerCase();

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      parts.push(
        component.replace(/\s+/g, " ")
      );
    }
  }

  return parts.join(", ") || "-";
}

function documentLabel(type: string) {
  return documentTypeLabel(type);
}

const terminalStatuses = new Set([
  "CLOSED_SETTLED",
  "CLOSED_FAILED",
  "CLOSED_NON_STARTER",
  "WITHDRAWN",
]);

function nextPendingTask(data: Data) {
  const task = data.tasks
    .filter((item) => item.status === "PENDING")
    .sort((a, b) => {
      const aDue = a.due_date || "9999-12-31";
      const bDue = b.due_date || "9999-12-31";
      return (
        aDue.localeCompare(bDue) ||
        Number(a.id) - Number(b.id)
      );
    })[0];

  if (!task) return null;

  const session =
    task.task_type_code === "SESSION_RECORD"
      ? data.sessions.find(
          (item) =>
            item.session_status === "SCHEDULED" &&
            (!task.due_date ||
              item.scheduled_date === task.due_date)
        )
      : null;

  return {
    ...task,
    case_id: data.case.id,
    session_id: session?.id || null,
  };
}

function isOverdue(value: string | null) {
  return Boolean(
    value &&
      value <
        new Date().toISOString().slice(0, 10)
  );
}

function stageStatus(
  data: Data,
  statusCodes: string[],
  completed: boolean
) {
  const current = statusCodes.includes(data.case.status_code);
  if (completed) return "Completed";
  if (current) return "Current";
  return "Pending";
}

function workflowStages(data: Data) {
  const c = data.case;
  const statusCodes = new Set(
    data.statusHistory.map((item) => item.to_status_code)
  );
  const taskCodes = new Set(
    data.tasks.map((item) => item.task_type_code)
  );
  const doneTasks = new Set(
    data.tasks
      .filter((item) => item.status === "COMPLETED")
      .map((item) => item.task_type_code)
  );
  const hasTerminal = terminalStatuses.has(c.status_code);
  const nonStarter = c.outcome_type === "NON_STARTER";

  /*
   * APPLICATION_FEE is the filing fee collected at receipt.
   * It must not complete the later mediation-fee stage.
   */
  const mediationFeeRecords = data.fees.filter(
    (fee) => fee.fee_type === "MEDIATION_FEE"
  );
  const mediationFeeReceived = mediationFeeRecords.some(
    (fee) =>
      fee.status === "RECEIVED" &&
      Number(fee.amount_received || 0) > 0
  );

  const stages = [
    {
      label: "Received",
      status: "Completed",
      note: date(c.received_date),
    },
    {
      label: "Scrutiny",
      status: stageStatus(
        data,
        ["SCRUTINY_PENDING", "DEFECT_PENDING"],
        doneTasks.has("SCRUTINY") ||
          statusCodes.has("PIM_NUMBER_PENDING") ||
          statusCodes.has("SECRETARY_APPROVAL_PENDING") // legacy-imported cases only
      ),
      note: taskCodes.has("SCRUTINY") ? "Task recorded" : "Awaiting task",
    },
    {
      // Batch 5H-b: PIM-number assignment (staff-operated) replaces
      // Secretary approval as this checkpoint - a legacy-imported case may
      // still show SECRETARY_APPROVAL_PENDING here historically.
      label: "PIM Number Assignment",
      status: stageStatus(
        data,
        ["PIM_NUMBER_PENDING", "SECRETARY_APPROVAL_PENDING"],
        Boolean(c.registration_date) || statusCodes.has("REGISTERED")
      ),
      note: date(c.registration_date),
    },
    {
      label: "PIM Registered",
      status: c.pim_number ? "Completed" : "Pending",
      note: c.pim_number || "-",
    },
    {
      label: "Form-2",
      status: stageStatus(
        data,
        ["FORM2_PENDING", "FORM2_ISSUED"],
        data.notices.length > 0 || doneTasks.has("FORM2") || doneTasks.has("FORM_2")
      ),
      note: `${data.notices.length} notice(s)`,
    },
    {
      label: "Service",
      status: stageStatus(
        data,
        [
          "SERVICE_PENDING",
          "NOTICE_RETURNED",
          "ADDRESS_CORRECTION_PENDING",
          "FINAL_NOTICE_PENDING",
          "FINAL_NOTICE_ISSUED",
        ],
        data.serviceAttempts.length > 0
      ),
      note: `${data.serviceAttempts.length} attempt(s)`,
    },
    {
      label: "OP Response",
      status: stageStatus(
        data,
        ["OP_APPEARANCE_PENDING", "OP_APPEARED", "OP_CONSENT_PENDING", "OP_CONSENTED", "OP_REFUSED"],
        data.responses.length > 0
      ),
      note: `${data.responses.length} response(s)`,
    },
    {
      label: "Consent",
      status: data.responses.some((item) => item.consent === 1)
        ? "Completed"
        : data.case.status_code.includes("CONSENT")
          ? "Current"
          : nonStarter || hasTerminal
            ? "Not applicable"
            : "Pending",
      note: "-",
    },
    {
      label: "Mediation Fee",
      status: stageStatus(
        data,
        ["FEE_PENDING"],
        mediationFeeReceived
      ),
      note: mediationFeeReceived
        ? `${mediationFeeRecords.length} mediation fee record(s)`
        : c.status_code === "FEE_PENDING"
          ? "Mediation fee pending"
          : "Not reached",
    },
    {
      label: "Mediator Assigned",
      status: stageStatus(
        data,
        ["MEDIATOR_ASSIGNMENT_PENDING"],
        data.mediatorAssignments.length > 0
      ),
      note: data.mediatorAssignments[0]?.mediator_name || "-",
    },
    {
      label: "First Mediation Fixed",
      status: stageStatus(
        data,
        ["MEDIATOR_ASSIGNED", "MEDIATION_PENDING"],
        data.sessions.length > 0
      ),
      note: date(data.sessions[0]?.scheduled_date || null),
    },
    {
      label: "Mediation Sessions",
      status: stageStatus(
        data,
        ["MEDIATION_ONGOING"],
        data.sessions.some((item) => item.session_status !== "SCHEDULED")
      ),
      note: `${data.sessions.length} sitting(s)`,
    },
    {
      label: "Outcome",
      status: data.outcome
        ? "Completed"
        : c.status_code === "OUTCOME_FORM_PENDING"
          ? "Current"
          : "Pending",
      note: c.outcome_type || "-",
    },
    {
      label: "Approval",
      status: data.outcome?.approved_by
        ? "Completed"
        : data.outcome && !nonStarter
          ? "Current"
          : nonStarter
            ? "Not applicable"
            : "Pending",
      note: data.outcome?.approved_by_name || "-",
    },
    {
      label: "Closed",
      status: hasTerminal ? "Completed" : "Pending",
      note: c.outcome_type || c.status_name,
    },
  ];

  if (nonStarter) {
    return stages.filter(
      (stage) =>
        ![
          "Consent",
          "Mediation Fee",
          "Mediator Assigned",
          "First Mediation Fixed",
          "Mediation Sessions",
          "Approval",
        ].includes(stage.label)
    );
  }

  return stages;
}

function timelineClass(status: string) {
  switch (status) {
    case "Completed":
      return "border-green-200 bg-green-50 text-green-800";
    case "Current":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "Not applicable":
      return "border-gray-200 bg-gray-50 text-gray-500";
    default:
      return "border-gray-200 bg-white text-gray-700";
  }
}

export default function PIMCasePage() {
  const [data, setData] =
    useState<Data | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState("");

  useEffect(() => {
    const parts =
      window.location.pathname.split("/");

    const lastPart =
      parts[parts.length - 1];

    const match =
      lastPart.match(/\d+$/);

    const id =
      match ? match[0] : lastPart;

    if (!id || !/^\d+$/.test(id)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Invalid case ID.");
      setLoading(false);
      return;
    }

    fetch(`/api/pim/case/${id}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const contentType =
          response.headers.get(
            "content-type"
          ) || "";

        if (
          !contentType.includes(
            "application/json"
          )
        ) {
          throw new Error(
            `Case API returned a non-JSON response (HTTP ${response.status}).`
          );
        }

        const json =
          await response.json();

        if (
          !response.ok ||
          !json.success
        ) {
          throw new Error(
            json.message ||
              "Unable to load case."
          );
        }

        return json;
      })
      .then((json) => {
        setData(json.data);
      })
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load case."
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          Loading PIM case...
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
          {error}
        </div>
      </main>
    );
  }

  if (!data) {
    return null;
  }

  const c = data.case;
  const documentsWithFiles = data.documents.filter(
    (document: any) => document.has_file === 1
  );
  const pendingTask = nextPendingTask(data);
  const terminal = terminalStatuses.has(
    c.status_code
  );

  /*
   * Prefer the pending task action when one exists.
   * If the workflow intentionally has no pending task
   * (for example SECRETARY_APPROVAL_PENDING), resolve
   * the next action from the case status.
   */
  const action = terminal
    ? null
    : pendingTask
      ? getTaskAction(pendingTask)
      : getCaseAction({
          id: c.id,
          case_id: c.id,
          status_code: c.status_code,
          pending_task_id: null,
          pending_task_type_code: null,
          pending_session_id: null,
        });

  return (
    <main className="min-h-screen bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">

        {/* HEADER */}

        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">

            <div>
              <div className="text-sm text-gray-500">
                PIM Case File
              </div>

              <h1 className="mt-1 text-2xl font-bold">
                {c.pim_number ||
                  "PIM Not Assigned"}
              </h1>

              <div className="mt-1 text-sm text-gray-600">
                Received No:{" "}
                {c.received_number || "-"}
                {" · "}Registered:{" "}
                {date(c.registration_date)}
                {c.claim_amount != null && (
                  <>
                    {" · "}Claim: {money(c.claim_amount)}
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <span
                className={`rounded-full px-3 py-1 text-sm font-medium ${statusClass(
                  c.status_code
                )}`}
              >
                {c.status_name}
              </span>

              <span className="rounded-full bg-gray-100 px-3 py-1 text-sm">
                Priority:{" "}
                {c.priority || "-"}
              </span>
              {c.entry_type === "LEGACY" && (
                <span className="rounded-full bg-indigo-100 px-3 py-1 text-sm font-medium text-indigo-800">
                  Legacy Case
                </span>
              )}
              {terminal && c.closed_at && (
                <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800">
                  Closed: {date(c.closed_at)}
                </span>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Applicant(s)"
              value={namesByRole(data.parties, "APPLICANT")}
            />
            <Field
              label="Opposite Party(ies)"
              value={namesByRole(data.parties, "OPPOSITE_PARTY")}
            />
            <Field
              label="Active Mediator"
              value={
                data.mediatorAssignments.find((a) => a.status === "ACTIVE")
                  ?.mediator_name || "Not assigned"
              }
            />
            <Field
              label="Stage Note"
              value={STATUS_NOTES[c.status_code] || c.status_name}
            />
          </div>
        </div>

        {data.warnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-5">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-800">
              Data Integrity Warnings ({data.warnings.length})
            </h2>
            <ul className="list-inside list-disc space-y-1 text-sm text-amber-900">
              {data.warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>{warning.message}</li>
              ))}
            </ul>
          </div>
        )}

        <Section title="Next Action">
          <div className="grid gap-5 md:grid-cols-5">
            <Field
              label="Current Status"
              value={c.status_name}
            />
            <Field
              label="Pending Task"
              value={
                terminal
                  ? "No further workflow action"
                  : pendingTask?.description ||
                    (action?.label
                      ? "Status-based workflow action"
                      : "No pending task")
              }
            />
            <Field
              label="Due Date"
              value={
                pendingTask
                  ? date(pendingTask.due_date)
                  : "-"
              }
            />
            <Field
              label="Overdue"
              value={
                pendingTask &&
                isOverdue(pendingTask.due_date)
                  ? "Yes"
                  : "No"
              }
            />
            <div className="flex items-end">
              {terminal ? (
                <span className="rounded border px-4 py-2 text-sm text-gray-500">
                  No further workflow action
                </span>
              ) : action?.href ? (
                <Link
                  href={action.href}
                  className="rounded bg-black px-4 py-2 text-sm font-medium text-white"
                >
                  {action.label}
                </Link>
              ) : action?.missingPage ? (
                <span className="rounded border px-4 py-2 text-sm text-gray-500">
                  Page pending
                </span>
              ) : (
                <span className="rounded border px-4 py-2 text-sm text-gray-500">
                  No action
                </span>
              )}
            </div>
          </div>
        </Section>

        <Section title="Workflow Timeline">
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
            {workflowStages(data).map((stage) => (
              <div
                key={stage.label}
                className={`rounded-lg border p-3 ${timelineClass(stage.status)}`}
              >
                <div className="text-xs font-medium uppercase">
                  {stage.status}
                </div>
                <div className="mt-1 font-semibold">
                  {stage.label}
                </div>
                <div className="mt-1 text-xs opacity-80">
                  {stage.note}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* CASE TIMELINE (docket - the curated narrative of record;
            every status transition already has a matching docket
            entry, so this is deliberately the single chronological
            source rather than re-deriving a second list from
            status_history and risking duplicate entries). */}

        <Section title="Case Timeline">
          {data.docket.length === 0 ? (
            <p className="text-sm text-gray-500">
              No timeline events recorded.
            </p>
          ) : (
            <div className="space-y-4">
              {data.docket.map(
                (entry) => (
                  <div
                    key={entry.id}
                    className="relative border-l-2 border-gray-300 pl-5"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-xs text-gray-500">
                        {date(entry.docket_date)}
                      </span>
                      {entry.event_category && (
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                          {entry.event_category}
                        </span>
                      )}
                    </div>

                    <div className="font-semibold">
                      {entry.event_name ||
                        entry.event_code ||
                        "Docket Entry"}
                    </div>

                    <div className="mt-1 text-sm text-gray-700">
                      {entry.entry_text}
                    </div>

                    {entry.action_required && (
                      <div className="mt-1 text-xs font-medium text-amber-700">
                        Action:{" "}
                        {
                          entry.action_required
                        }
                      </div>
                    )}

                    {entry.next_date && (
                      <div className="mt-1 text-xs text-gray-500">
                        Next date:{" "}
                        {date(
                          entry.next_date
                        )}
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}
        </Section>

        {/* CASE SUMMARY */}

        <Section title="Case Summary">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Received Date"
              value={date(
                c.received_date
              )}
            />

            <Field
              label="Application Date"
              value={date(
                c.application_date
              )}
            />

            <Field
              label="Registration Date"
              value={date(
                c.registration_date
              )}
            />

            <Field
              label="Claim Amount"
              value={money(
                c.claim_amount
              )}
            />

            <Field
              label="Internal 60-Day Date"
              value={date(
                c.internal_60_day_date
              )}
            />

            <Field
              label="Statutory Due Date"
              value={date(
                c.statutory_due_date
              )}
            />

            <Field
              label="Outcome"
              value={
                c.outcome_type || "-"
              }
            />

            <Field
              label="Outcome Date"
              value={date(
                c.outcome_date
              )}
            />
          </div>

          <div className="mt-5">
            <Field
              label="Dispute Description"
              value={
                c.dispute_description ||
                "Not provided"
              }
            />
          </div>

          {c.remarks && (
            <div className="mt-5">
              <Field
                label="Remarks"
                value={c.remarks}
              />
            </div>
          )}
        </Section>

        {/* PARTIES */}

        <Section title="Parties">
          <div className="grid gap-5 md:grid-cols-2">
            {data.parties.length === 0 ? (
              <p className="text-sm text-gray-500">
                No parties recorded.
              </p>
            ) : (
              data.parties.map((party) => {
                const address =
                  data.addresses.find(
                    (a) =>
                      a.party_id ===
                      party.party_id
                  );

                const advocate =
                  data.advocates.find(
                    (a) =>
                      a.party_id ===
                      party.party_id
                  );

                const addressText =
  address
    ? formatAddress([
        address.address_line1,
        address.address_line2,
        address.village_town,
        address.district,
        address.state,
        address.pincode,
      ])
    : "No address recorded";

                return (
                  <div
                    key={
                      party.case_party_id
                    }
                    className="rounded-lg border p-4"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-semibold">
                        {party.role ===
                        "APPLICANT"
                          ? "Applicant"
                          : party.role ===
                              "OPPOSITE_PARTY"
                            ? "Opposite Party"
                            : party.role}
                      </h3>

                      {party.is_primary ? (
                        <span className="rounded bg-gray-100 px-2 py-1 text-xs">
                          Primary
                        </span>
                      ) : null}
                    </div>

                    <div className="space-y-3">
                      <Field
                        label="Name"
                        value={
                          party.name
                        }
                      />

                      <Field
                        label="Type"
                        value={
                          party.entity_type ||
                          "-"
                        }
                      />

                      <Field
                        label="Registration No."
                        value={
                          party.registration_no ||
                          "-"
                        }
                      />

                      <Field
                        label="Contact"
                        value={
                          party.contact_phone ||
                          "-"
                        }
                      />

                      <Field
                        label="Email"
                        value={
                          party.email ||
                          "-"
                        }
                      />

                      <Field
                        label="Address"
                        value={
                          addressText ||
                          "No address recorded"
                        }
                      />

                      <Field
                        label="Advocate"
                        value={
                          advocate
                            ? `${advocate.advocate_name}${
                                advocate.enrollment_no
                                  ? ` (${advocate.enrollment_no})`
                                  : ""
                              }`
                            : "No advocate recorded"
                        }
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Section>

        {/* NOTICES AND SERVICE */}

        <Section title="Notices & Service">
          {data.notices.length === 0 ? (
            <p className="text-sm text-gray-500">
              No notices recorded.
            </p>
          ) : (
            <div className="space-y-3">
              {data.notices.map(
                (notice) => (
                  <div
                    key={notice.id}
                    className="rounded-lg border p-4"
                  >
                    <div className="flex flex-col justify-between gap-2 md:flex-row">
                      <div>
                        <div className="font-semibold">
                          {notice.form_no} -{" "}
                          <span
                            className={
                              notice.notice_type === "FORM_2_FINAL"
                                ? "text-red-700"
                                : "text-blue-700"
                            }
                          >
                            {noticeLabel(notice.notice_type)}
                          </span>
                        </div>

                        <div className="text-sm text-gray-600">
                          Recipient:{" "}
                          {
                            notice.recipient_name
                          }
                        </div>

                        <div className="text-sm text-gray-600">
                          Address used:{" "}
                          {formatAddress([
                            notice.address_line1,
                            notice.address_line2,
                            notice.village_town,
                            notice.district,
                            notice.state,
                            notice.pincode,
                          ]) || "Not recorded"}
                        </div>
                      </div>

                      <span className="rounded bg-gray-100 px-2 py-1 text-xs">
                        {notice.status}
                      </span>
                    </div>

                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <Field
                        label="Notice Date"
                        value={date(
                          notice.notice_date
                        )}
                      />

                      <Field
                        label="Appearance Date"
                        value={date(
                          notice.appearance_date
                        )}
                      />

                      <Field
                        label="Appearance Time"
                        value={
                          notice.appearance_time ||
                          "-"
                        }
                      />
                    </div>

                    <div className="mt-3">
                      {notice.current_document_has_file ? (
                        <a
                          href={`/api/pim/documents/download/${c.id}/${notice.current_document_id}`}
                          className="text-sm font-medium text-blue-700 underline"
                        >
                          View current document (v{notice.current_document_version_no})
                        </a>
                      ) : (
                        <span className="text-sm text-gray-500">
                          No current document generated.
                        </span>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {data.serviceAttempts.length >
            0 && (
            <div className="mt-5">
              <h3 className="mb-3 font-semibold">
                Service Attempts
              </h3>

              <div className="overflow-x-auto">
                <table className="min-w-full border text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="border p-2 text-left">
                        Attempt
                      </th>
                      <th className="border p-2 text-left">
                        Mode
                      </th>
                      <th className="border p-2 text-left">
                        Dispatch
                      </th>
                      <th className="border p-2 text-left">
                        Tracking
                      </th>
                      <th className="border p-2 text-left">
                        Delivered
                      </th>
                      <th className="border p-2 text-left">
                        Returned
                      </th>
                      <th className="border p-2 text-left">
                        Return Reason
                      </th>
                      <th className="border p-2 text-left">
                        Postal Endorsement
                      </th>
                      <th className="border p-2 text-left">
                        Address
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {data.serviceAttempts.map(
                      (attempt) => (
                        <tr
                          key={attempt.id}
                        >
                          <td className="border p-2">
                            {attempt.id}
                          </td>

                          <td className="border p-2">
                            {attempt.dispatch_mode}
                          </td>

                          <td className="border p-2">
                            {date(
                              attempt.dispatch_date
                            )}
                          </td>

                          <td className="border p-2">
                            {attempt.tracking_status ||
                              attempt.tracking_no ||
                              "-"}
                          </td>

                          <td className="border p-2">
                            {date(
                              attempt.delivered_date
                            )}
                          </td>

                          <td className="border p-2">
                            {date(
                              attempt.returned_date
                            )}
                          </td>

                          <td className="border p-2">
                            {attempt.return_reason || "-"}
                          </td>

                          <td className="border p-2">
                            {attempt.postal_endorsement || "-"}
                          </td>

                          <td className="border p-2">
                            {formatAddress([
  attempt.address_line1,
  attempt.address_line2,
  attempt.village_town,
  attempt.district,
  attempt.state,
  attempt.pincode,
])}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Section>

        {/* OP RESPONSE */}

        <Section title="Opposite Party Response">
          {data.responses.length === 0 ? (
            <p className="text-sm text-gray-500">
              No OP response recorded.
            </p>
          ) : (
            <div className="space-y-3">
              {data.responses.map(
                (response) => (
                  <div
                    key={response.id}
                    className="rounded-lg border p-4"
                  >
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <Field
                        label="Party"
                        value={
                          response.party_name
                        }
                      />

                      <Field
                        label="Date"
                        value={date(
                          response.response_date
                        )}
                      />

                      <Field
                        label="Response"
                        value={
                          response.response_type
                        }
                      />

                      <Field
                        label="Appearance Mode"
                        value={
                          response.appearance_mode ||
                          "-"
                        }
                      />

                      <Field
                        label="Mediation Consent"
                        value={
                          response.consent === 1
                            ? "Consented"
                            : response.consent ===
                                0
                              ? "Refused"
                              : "-"
                        }
                      />

                      <Field
                        label="Fee Requested"
                        value={
                          response.mediation_fee_requested ===
                          1
                            ? "Yes"
                            : response.mediation_fee_requested ===
                                0
                              ? "No"
                              : "-"
                        }
                      />

                      {response.time_requested_until && (
                        <Field
                          label="Time Requested Until"
                          value={date(
                            response.time_requested_until
                          )}
                        />
                      )}

                      {response.remarks && (
                        <Field
                          label="Remarks"
                          value={
                            response.remarks
                          }
                        />
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </Section>

        {/* FEES */}

        <Section title="Fees">
          <div className="mb-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded border bg-gray-50 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Mediation Fee (Case-Level, Rule 11)
              </div>
              {data.feeSummary.mediationFee ? (
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <Field label="Due" value={money(data.feeSummary.mediationFee.amountDue)} />
                  <Field label="Received" value={money(data.feeSummary.mediationFee.amountReceived)} />
                  <Field label="Balance" value={money(data.feeSummary.mediationFee.balance)} />
                  <Field label="Status" value={data.feeSummary.mediationFee.status} />
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-500">Not yet applicable / not recorded.</p>
              )}
            </div>
            <div className="rounded border bg-gray-50 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Application Fee (separate from mediation fee)
              </div>
              {data.feeSummary.applicationFee ? (
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <Field label="Due" value={money(data.feeSummary.applicationFee.amountDue)} />
                  <Field label="Received" value={money(data.feeSummary.applicationFee.amountReceived)} />
                  <Field label="Status" value={data.feeSummary.applicationFee.status} />
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-500">Not recorded.</p>
              )}
            </div>
          </div>

          {data.fees.length === 0 ? (
            <p className="text-sm text-gray-500">
              No fee records.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="border p-2 text-left">
                      Type
                    </th>
                    <th className="border p-2 text-left">
                      Party
                    </th>
                    <th className="border p-2 text-right">
                      Due
                    </th>
                    <th className="border p-2 text-right">
                      Received
                    </th>
                    <th className="border p-2 text-left">
                      DD No.
                    </th>
                    <th className="border p-2 text-left">
                      Status
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {data.fees.map(
                    (fee) => (
                      <tr
                        key={fee.id}
                      >
                        <td className="border p-2">
                          {fee.fee_type}
                        </td>

                        <td className="border p-2">
                          {fee.party_name ||
                            "-"}
                        </td>

                        <td className="border p-2 text-right">
                          {money(
                            fee.amount_due
                          )}
                        </td>

                        <td className="border p-2 text-right">
                          {money(
                            fee.amount_received
                          )}
                        </td>

                        <td className="border p-2">
                          {fee.dd_number ||
                            "-"}
                        </td>

                        <td className="border p-2">
                          {fee.status}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* MEDIATOR */}

        <Section title="Mediator">
          {data.mediatorAssignments.length ===
          0 ? (
            <p className="text-sm text-gray-500">
              No mediator assignment
              recorded.
            </p>
          ) : (
            <div className="space-y-3">
              {data.mediatorAssignments.map(
                (assignment) => {
                  const replacedAssignment = assignment.replacement_for_assignment_id
                    ? data.mediatorAssignments.find(
                        (a) => a.id === assignment.replacement_for_assignment_id
                      )
                    : null;

                  return (
                  <div
                    key={assignment.id}
                    className={`rounded-lg border p-4 ${
                      assignment.status === "ACTIVE"
                        ? "border-green-300 bg-green-50"
                        : ""
                    }`}
                  >
                    {assignment.status === "ACTIVE" && (
                      <span className="mb-2 inline-block rounded bg-green-600 px-2 py-0.5 text-xs font-semibold text-white">
                        CURRENT ACTIVE MEDIATOR
                      </span>
                    )}
                    {replacedAssignment && (
                      <div className="mb-2 text-xs text-gray-600">
                        Reassigned from {replacedAssignment.mediator_name} (was sitting(s) before this point).
                      </div>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <Field
                        label="Mediator"
                        value={
                          assignment.mediator_name
                        }
                      />

                      <Field
                        label="Enrollment No."
                        value={
                          assignment.enrollment_no ||
                          "-"
                        }
                      />

                      <Field
                        label="Assignment Date"
                        value={date(
                          assignment.assignment_date
                        )}
                      />

                      <Field
                        label="First Mediation"
                        value={date(
                          assignment.first_mediation_date
                        )}
                      />

                      <Field
                        label="Assignment Order"
                        value={
                          assignment.assignment_order_no ||
                          "-"
                        }
                      />

                      <Field
                        label="Rotation Suggestion"
                        value={
                          assignment.rotation_suggestion_no ??
                          "-"
                        }
                      />

                      <Field
                        label="Rotation Deviation"
                        value={
                          assignment.deviation_from_rotation
                            ? "Yes"
                            : "No"
                        }
                      />

                      <Field
                        label="Status"
                        value={
                          assignment.status
                        }
                      />
                    </div>
                  </div>
                  );
                }
              )}
            </div>
          )}
        </Section>

        {/* MEDIATION SESSIONS */}

        <Section title="Mediation Sessions">
          <div className="mb-4 inline-block rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-indigo-700">
              Cumulative Effective Duration
            </div>
            <div className="text-lg font-semibold text-indigo-900">
              {formatDuration(data.cumulativeDurationMinutes)}
            </div>
            <div className="text-xs text-indigo-600">
              Ineffective/adjourned sittings are not counted.
            </div>
          </div>

          {data.sessions.length === 0 ? (
            <p className="text-sm text-gray-500">
              No mediation sessions recorded.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="border p-2 text-left">
                      Sitting
                    </th>
                    <th className="border p-2 text-left">
                      Date
                    </th>
                    <th className="border p-2 text-left">
                      Mediator
                    </th>
                    <th className="border p-2 text-left">
                      Presence
                    </th>
                    <th className="border p-2 text-left">
                      Effective
                    </th>
                    <th className="border p-2 text-left">
                      Start
                    </th>
                    <th className="border p-2 text-left">
                      End
                    </th>
                    <th className="border p-2 text-left">
                      Duration
                    </th>
                    <th className="border p-2 text-left">
                      Status
                    </th>
                    <th className="border p-2 text-left">
                      Next Action
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {data.sessions.map(
                    (session) => (
                      <tr
                        key={session.id}
                      >
                        <td className="border p-2">
                          {session.sitting_number}
                        </td>

                        <td className="border p-2">
                          {date(
                            session.actual_date ||
                              session.scheduled_date
                          )}
                        </td>

                        <td className="border p-2">
                          {session.mediator_name || "-"}
                        </td>

                        <td className="border p-2">
                          {session.applicant_present &&
                          session.opposite_party_present
                            ? "Both Present"
                            : session.applicant_present
                              ? "Applicant Only"
                              : session.opposite_party_present
                                ? "Opposite Party Only"
                                : "Both Absent"}
                        </td>

                        <td className="border p-2">
                          {session.effective_session
                            ? "YES"
                            : "NO"}
                        </td>

                        <td className="border p-2">
                          {session.actual_start_time ||
                            "-"}
                        </td>

                        <td className="border p-2">
                          {session.actual_end_time ||
                            "-"}
                        </td>

                        <td className="border p-2">
                          {session.duration_minutes !=
                          null
                            ? `${session.duration_minutes} min`
                            : "-"}
                        </td>

                        <td className="border p-2">
                          {session.session_status}
                        </td>

                        <td className="border p-2">
                          {session.next_action ===
                          "FURTHER_MEDIATION"
                            ? "Further Mediation"
                            : session.next_action ===
                                "READY_FOR_SETTLEMENT"
                              ? "Ready for Settlement"
                              : session.next_action ===
                                  "READY_FOR_FAILURE"
                                ? "Ready for Failure"
                                : "-"}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* OUTCOME */}

        <Section title="Outcome">
          {!data.outcome ? (
            <p className="text-sm text-gray-500">
              No outcome recorded.
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field
                  label="Outcome"
                  value={
                    data.outcome
                      .outcome_type
                  }
                />

                <Field
                  label="Form"
                  value={
                    data.outcome.form_no ||
                    "-"
                  }
                />

                <Field
                  label="Outcome Date"
                  value={date(
                    data.outcome
                      .outcome_date
                  )}
                />

                <Field
                  label="Reason"
                  value={
                    data.outcome
                      .nonstarter_reason_name ||
                    data.outcome
                      .reason_text ||
                      "-"
                  }
                />

                {data.outcome.outcome_type ===
                  "NON_STARTER" && (
                  <>
                    <Field
                      label="Rule Reference"
                      value={
                        data.outcome.rule_reference ||
                        "-"
                      }
                    />

                    <Field
                      label="Authority Required"
                      value={
                        data.outcome
                          .requires_authority_decision
                          ? "Yes"
                          : "No"
                      }
                    />

                    <Field
                      label="Form-3 Status"
                      value={
                        data.outcome.document_id
                          ? "Document linked"
                          : "Document pending"
                      }
                    />
                  </>
                )}

                <Field
                  label="Settlement Terms"
                  value={
                    data.outcome
                      .settlement_terms ||
                    "-"
                  }
                />

                <Field
                  label="Verified"
                  value={
                    data.outcome
                      .outcome_type ===
                    "NON_STARTER"
                      ? "Not required for this reason"
                      : data.outcome
                          .verified_by_name
                        ? `${data.outcome.verified_by_name}, ${data.outcome.verified_by_designation || ""}`.trim()
                        : "No"
                  }
                />

                <Field
                  label="Approved"
                  value={
                    data.outcome
                      .outcome_type ===
                    "NON_STARTER"
                      ? "Not required for this reason"
                      : data.outcome
                          .approved_by_name
                        ? `${data.outcome.approved_by_name}, ${data.outcome.approved_by_designation || ""}`.trim()
                        : "No"
                  }
                />

                <Field
                  label="Sent to Applicant"
                  value={
                    data.outcome
                      .sent_to_applicant
                      ? "Yes"
                      : "No"
                  }
                />

                <Field
                  label="Sent to Opposite Party"
                  value={
                    data.outcome
                      .sent_to_opposite_party
                      ? "Yes"
                      : "No"
                  }
                />

                {data.outcome.document_id && (
                  <Field
                    label="Document ID"
                    value={
                      data.outcome
                        .document_id
                    }
                  />
                )}
              </div>

              {data.outcome
                .remarks && (
                <div className="mt-5">
                  <Field
                    label="Outcome Remarks"
                    value={
                      data.outcome
                        .remarks
                    }
                  />
                </div>
              )}
            </>
          )}
        </Section>

        {/* DOCUMENTS */}

        <Section title="Documents">
          {documentsWithFiles.length === 0 ? (
            <p className="text-sm text-gray-500">
              No generated document files recorded.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="border p-2 text-left">
                      Type
                    </th>
                    <th className="border p-2 text-left">
                      Notice
                    </th>
                    <th className="border p-2 text-left">
                      Title
                    </th>
                    <th className="border p-2 text-left">
                      Date
                    </th>
                    <th className="border p-2 text-left">
                      Version
                    </th>
                    <th className="border p-2 text-left">
                      Current
                    </th>
                    <th className="border p-2 text-left">
                      Action
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {documentsWithFiles.map(
                    (document) => (
                      <tr
                        key={document.id}
                        className={
                          document.is_current
                            ? "bg-green-50"
                            : "text-gray-500"
                        }
                      >
                        <td className="border p-2">
                          {documentLabel(
                            document.normalized_document_type ||
                              document.document_type
                          )}
                        </td>

                        <td className="border p-2">
                          {document.notice_id
                            ? `${noticeLabel(document.notice_type)}${document.notice_recipient_name ? ` - ${document.notice_recipient_name}` : ""}`
                            : "-"}
                        </td>

                        <td className="border p-2">
                          {document.document_title}
                        </td>

                        <td className="border p-2">
                          {date(
                            document.document_date
                          )}
                        </td>

                        <td className="border p-2">
                          {document.version_no}
                        </td>

                        <td className="border p-2">
                          {document.is_current ? (
                            <span className="rounded bg-green-600 px-2 py-0.5 text-xs font-semibold text-white">
                              CURRENT
                            </span>
                          ) : (
                            "Superseded"
                          )}
                        </td>

                        <td className="border p-2">
                          <a
                            href={`/api/pim/documents/download/${c.id}/${document.id}`}
                            className="font-medium text-blue-700 underline"
                          >
                            View / Download
                          </a>
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* TASKS */}

        <Section title="Tasks">
          {data.tasks.length === 0 ? (
            <p className="text-sm text-gray-500">
              No tasks recorded.
            </p>
          ) : (
            <div className="space-y-2">
              {data.tasks.map(
                (task) => (
                  <div
                    key={task.id}
                    className="flex flex-col justify-between gap-2 rounded border p-3 md:flex-row"
                  >
                    <div>
                      <div className="font-medium">
                        {task.description}
                      </div>

                      <div className="text-xs text-gray-500">
                        Due:{" "}
                        {date(
                          task.due_date
                        )}
                      </div>

                      {task.completed_date && (
                        <div className="text-xs text-gray-500">
                          Completed:{" "}
                          {date(
                            task.completed_date
                          )}
                          {task.completed_time
                            ? ` ${task.completed_time}`
                            : ""}
                        </div>
                      )}
                    </div>

                    <span
                      className={`h-fit rounded px-2 py-1 text-xs ${
                        task.status ===
                        "COMPLETED"
                          ? "bg-green-100 text-green-800"
                          : task.status ===
                              "IN_PROGRESS"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {task.status}
                    </span>
                  </div>
                )
              )}
            </div>
          )}
        </Section>

        {/* STATUS HISTORY */}

        <Section title="Status History">
          {data.statusHistory.length ===
          0 ? (
            <p className="text-sm text-gray-500">
              No status history recorded.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="border p-2 text-left">
                      Date
                    </th>
                    <th className="border p-2 text-left">
                      From
                    </th>
                    <th className="border p-2 text-left">
                      To
                    </th>
                    <th className="border p-2 text-left">
                      Reason
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {data.statusHistory.map(
                    (history) => (
                      <tr
                        key={history.id}
                      >
                        <td className="border p-2">
                          {date(
                            history.changed_at
                          )}
                        </td>

                        <td className="border p-2">
                          {history.from_status_name ||
                            "-"}
                        </td>

                        <td className="border p-2">
                          {
                            history.to_status_name
                          }
                        </td>

                        <td className="border p-2">
                          {history.reason ||
                            "-"}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Section>

      </div>
    </main>
  );
}
