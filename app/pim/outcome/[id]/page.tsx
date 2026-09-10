"use client";

import { useEffect, useMemo, useState } from "react";
import { usePimAuth } from "../../../../lib/use-pim-auth";

type OutcomeType = "SETTLED" | "FAILED" | "WITHDRAWN";

type Party = {
  role: string;
  is_primary: number;
  party_id: number;
  name: string;
};

type User = {
  id: number;
  display_name: string;
  designation: string;
};

type Session = {
  id: number;
  sitting_number: number;
  scheduled_date: string | null;
  actual_date: string | null;
  effective_session: number;
  duration_minutes: number | null;
  session_status: string;
};

type PageData = {
  case: {
    id: number;
    pim_number: string | null;
    received_number: string | null;
    status_code: string;
    status_name: string;
  };
  outcome: any;
  parties: Party[];
  assignment: {
    mediator_name: string;
    mediator_category: string | null;
    enrollment_no: string | null;
  } | null;
  sessions: Session[];
  sessionSummary: {
    total_sittings: number;
    effective_sittings: number;
    effective_duration_minutes: number;
    last_actual_date: string | null;
  };
  phase7Signal: "SETTLEMENT" | "FAILURE" | null;
  activeUsers: User[];
  tasks: any[];
  documents: any[];
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value: string | null) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString("en-IN");
}

function namesByRole(
  parties: Party[],
  role: string
) {
  const names = parties
    .filter((party) => party.role === role)
    .map((party) => party.name);

  return names.length > 0 ? names.join(", ") : "-";
}

function statusClass(status: string) {
  if (status.startsWith("CLOSED")) {
    return "bg-green-100 text-green-800";
  }

  if (status === "OUTCOME_FORM_PENDING") {
    return "bg-purple-100 text-purple-800";
  }

  return "bg-amber-100 text-amber-800";
}

export default function OutcomePage() {
  const [caseId, setCaseId] = useState("");
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [outcomeType, setOutcomeType] =
    useState<OutcomeType>("FAILED");
  const [outcomeDate, setOutcomeDate] =
    useState(today());
  const [settlementTerms, setSettlementTerms] =
    useState("");
  const [reasonDetails, setReasonDetails] =
    useState("");
  const [withdrawnBy, setWithdrawnBy] =
    useState("");
  const [remarks, setRemarks] = useState("");
  const [approvalRemarks, setApprovalRemarks] =
    useState("");
  const { hasPermission } = usePimAuth();

  useEffect(() => {
    const match =
      window.location.pathname.match(/(\d+)$/);

    if (!match) {
      setError("Invalid case ID.");
      setLoading(false);
      return;
    }

    setCaseId(match[1]);
    loadOutcome(match[1]);
  }, []);

  async function loadOutcome(id: string) {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(
        `/api/pim/outcome/${id}`,
        { cache: "no-store" }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          json.message ||
            "Unable to load outcome data."
        );
      }

      setData(json.data);

      if (json.data.sessionSummary?.last_actual_date) {
        setOutcomeDate(
          json.data.sessionSummary.last_actual_date
        );
      }

      // Preselect (not lock) based on Phase 7's final-sitting
      // signal - staff can still pick a different outcome type.
      if (
        !json.data.outcome &&
        json.data.phase7Signal === "SETTLEMENT"
      ) {
        setOutcomeType("SETTLED");
      } else if (
        !json.data.outcome &&
        json.data.phase7Signal === "FAILURE"
      ) {
        setOutcomeType("FAILED");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load outcome."
      );
    } finally {
      setLoading(false);
    }
  }

  const lastActualDate = useMemo(() => {
    if (!data) return null;
    return data.sessionSummary.last_actual_date;
  }, [data]);

  function validate() {
    if (!data) {
      return "Outcome data is not loaded.";
    }

    if (
      data.case.status_code !==
        "OUTCOME_FORM_PENDING" ||
      data.outcome
    ) {
      return "This case is not available for outcome recording.";
    }

    if (
      Number(data.sessionSummary.total_sittings) < 1
    ) {
      return "At least one completed mediation session is required.";
    }

    if (!outcomeDate) {
      return "Outcome date is required.";
    }

    if (outcomeDate > today()) {
      return "Outcome date cannot be in the future.";
    }

    if (
      lastActualDate &&
      outcomeDate < lastActualDate
    ) {
      return "Outcome date cannot be before the last actual mediation date.";
    }

    if (
      outcomeType === "SETTLED" &&
      !settlementTerms.trim()
    ) {
      return "Settlement terms/details are required.";
    }

    if (
      outcomeType === "FAILED" &&
      !reasonDetails.trim()
    ) {
      return "Failure reason/details are required.";
    }

    if (
      outcomeType === "WITHDRAWN" &&
      (!withdrawnBy.trim() ||
        !reasonDetails.trim())
    ) {
      return "Withdrawn by and withdrawal reason/details are required.";
    }

    return "";
  }

  async function saveOutcome() {
    if (saving || !caseId) return;

    setError("");
    setSuccess("");

    const validationError = validate();

    if (validationError) {
      setError(validationError);
      return;
    }

    const reasonText =
      outcomeType === "WITHDRAWN"
        ? `Withdrawn by: ${withdrawnBy.trim()}\n\n${reasonDetails.trim()}`
        : reasonDetails.trim() || null;

    try {
      setSaving(true);

      const response = await fetch(
        `/api/pim/outcome/${caseId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            outcomeType,
            outcomeDate,
            settlementTerms:
              outcomeType === "SETTLED"
                ? settlementTerms.trim()
                : null,
            reasonText,
            remarks: remarks.trim() || null,
          }),
        }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          json.message ||
            "Unable to record outcome."
        );
      }

      setSuccess(json.message);
      await loadOutcome(caseId);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to record outcome."
      );
    } finally {
      setSaving(false);
    }
  }

  async function approveOutcome() {
    if (approving || !caseId) return;

    setError("");
    setSuccess("");

    try {
      setApproving(true);

      const response = await fetch(
        `/api/pim/outcome/approve/${caseId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            remarks:
              approvalRemarks.trim() || null,
          }),
        }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          json.message ||
            "Unable to approve outcome."
        );
      }

      setSuccess(json.message);
      await loadOutcome(caseId);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to approve outcome."
      );
    } finally {
      setApproving(false);
    }
  }

  async function generateOutcomeDocument() {
    await requestOutcomeDocument(false);
  }

  async function regenerateOutcomeDocument() {
    if (
      !confirm(
        "Regenerate the outcome document and create the next version?"
      )
    ) {
      return;
    }

    await requestOutcomeDocument(true);
  }

  async function requestOutcomeDocument(
    regenerate: boolean
  ) {
    if (generating || !caseId) return;

    setError("");
    setSuccess("");

    try {
      setGenerating(true);

      const response = await fetch(
        `/api/pim/documents/outcome/${caseId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            regenerate,
          }),
        }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          json.message ||
            "Unable to generate outcome document."
        );
      }

      setSuccess(json.message);
      await loadOutcome(caseId);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to generate outcome document."
      );
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          Loading outcome...
        </div>
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg border border-red-300 bg-red-50 p-6 text-red-800">
          {error}
        </div>
      </main>
    );
  }

  if (!data) return null;

  const canRecord =
    data.case.status_code ===
      "OUTCOME_FORM_PENDING" &&
    !data.outcome &&
    hasPermission("RECORD_OUTCOME");

  const requiredDocumentType = data.outcome
    ? outcomeDocumentType(data.outcome.outcome_type)
    : "";

  const currentOutcomeDocument = data.documents.find(
    (document) =>
      document.document_type === requiredDocumentType &&
      document.is_current === 1 &&
      document.has_file === 1
  );

  const canApprove =
    data.case.status_code ===
      "OUTCOME_FORM_PENDING" &&
    data.outcome &&
    // SETTLED/FAILED must have their statutory document generated
    // first - closure can never precede the document (Phase 8).
    (data.outcome.outcome_type === "WITHDRAWN" ||
      Boolean(currentOutcomeDocument)) &&
    hasPermission("APPROVE_OUTCOME");

  return (
    <main className="min-h-screen bg-gray-100 p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <div className="text-sm text-gray-500">
                PIM Outcome Recording
              </div>

              <h1 className="mt-1 text-2xl font-bold">
                {data.case.pim_number ||
                  "PIM Number Not Assigned"}
              </h1>

              <p className="mt-1 text-sm text-gray-600">
                Received Number:{" "}
                {data.case.received_number || "-"}
              </p>
            </div>

            <span
              className={`rounded-full px-4 py-2 text-sm font-semibold ${statusClass(
                data.case.status_code
              )}`}
            >
              {data.case.status_name}
            </span>
          </div>

          {error && (
            <div className="mt-5 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              {error}
            </div>
          )}

          {success && (
            <div className="mt-5 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-800">
              {success}
            </div>
          )}
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Mediation Summary
          </h2>

          <div className="grid gap-5 md:grid-cols-4">
            <Info label="PIM Number" value={data.case.pim_number || "-"} />
            <Info label="Received Number" value={data.case.received_number || "-"} />
            <Info label="Applicant" value={namesByRole(data.parties, "APPLICANT")} />
            <Info label="Opposite Party" value={namesByRole(data.parties, "OPPOSITE_PARTY")} />
            <Info label="Mediator" value={data.assignment?.mediator_name || "-"} />
            <Info label="Total Sittings" value={String(data.sessionSummary.total_sittings || 0)} />
            <Info label="Effective Sittings" value={String(data.sessionSummary.effective_sittings || 0)} />
            <Info label="Effective Duration" value={`${data.sessionSummary.effective_duration_minutes || 0} minutes`} />
            <Info label="Last Actual Mediation" value={formatDate(data.sessionSummary.last_actual_date)} />
            <Info label="Current Status" value={data.case.status_name} />
          </div>
        </section>

        {data.outcome ? (
          <OutcomeDetails outcome={data.outcome} />
        ) : (
          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-5 text-lg font-semibold">
              Record Outcome
            </h2>

            {!canRecord ? (
              <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">
                This case is not currently available for outcome recording.
              </div>
            ) : (
              <div className="space-y-5">
                {data.phase7Signal && (
                  <div className="rounded border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900">
                    The final mediation sitting recorded a staff
                    assessment of{" "}
                    <strong>
                      {data.phase7Signal === "SETTLEMENT"
                        ? "Ready for Settlement"
                        : "Ready for Failure"}
                    </strong>
                    . Pre-selected below - change it if incorrect.
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-3">
                  {(["FAILED", "SETTLED", "WITHDRAWN"] as OutcomeType[]).map(
                    (type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() =>
                          setOutcomeType(type)
                        }
                        className={`rounded border p-4 text-left text-sm font-semibold ${
                          outcomeType === type
                            ? "border-black bg-gray-900 text-white"
                            : "bg-white text-gray-900"
                        }`}
                      >
                        {type}
                      </button>
                    )
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {outcomeType === "SETTLED"
                      ? "Settlement Date"
                      : outcomeType === "FAILED"
                        ? "Failure Date"
                        : "Withdrawal Date"}
                  </label>

                  <input
                    type="date"
                    min={lastActualDate || undefined}
                    max={today()}
                    value={outcomeDate}
                    onChange={(event) =>
                      setOutcomeDate(event.target.value)
                    }
                    className="mt-2 w-full rounded border p-3 text-sm md:w-80"
                  />
                </div>

                {outcomeType === "SETTLED" ? (
                  <TextArea
                    label="Settlement Terms / Details"
                    value={settlementTerms}
                    onChange={setSettlementTerms}
                    required
                  />
                ) : (
                  <>
                    {outcomeType === "WITHDRAWN" && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Withdrawn By
                        </label>

                        <input
                          type="text"
                          value={withdrawnBy}
                          onChange={(event) =>
                            setWithdrawnBy(
                              event.target.value
                            )
                          }
                          className="mt-2 w-full rounded border p-3 text-sm"
                        />
                      </div>
                    )}

                    <TextArea
                      label={
                        outcomeType === "FAILED"
                          ? "Failure Reason / Details"
                          : "Withdrawal Reason / Details"
                      }
                      value={reasonDetails}
                      onChange={setReasonDetails}
                      required
                    />
                  </>
                )}

                <TextArea
                  label="Remarks"
                  value={remarks}
                  onChange={setRemarks}
                />

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={saveOutcome}
                    disabled={saving}
                    className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {saving
                      ? "Saving..."
                      : "Save Outcome"}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {data.outcome && (
          <DocumentsPanel
            caseId={data.case.id}
            outcome={data.outcome}
            documents={data.documents}
            generating={generating}
            canGenerateDocument={hasPermission(
              "GENERATE_DOCUMENT"
            )}
            onGenerate={generateOutcomeDocument}
            onRegenerate={
              regenerateOutcomeDocument
            }
          />
        )}

        {data.outcome &&
          data.case.status_code === "OUTCOME_FORM_PENDING" &&
          data.outcome.outcome_type !== "WITHDRAWN" &&
          !currentOutcomeDocument && (
            <section className="rounded-lg border border-amber-300 bg-amber-50 p-6">
              <p className="text-sm text-amber-800">
                Generate the {data.outcome.outcome_type === "SETTLED" ? "Form-4 (Settlement)" : "Form-5 (Failure Report)"}{" "}
                document above before this case can be closed.
              </p>
            </section>
          )}

        {canApprove && (
          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-5 text-lg font-semibold">
              Approval / Closure
            </h2>

            <div>
              <TextArea
                label="Approval Remarks"
                value={approvalRemarks}
                onChange={setApprovalRemarks}
              />
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={approveOutcome}
                disabled={approving}
                className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {approving
                  ? "Closing..."
                  : "Approve and Close"}
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function outcomeDocumentType(
  outcomeType: string
) {
  if (outcomeType === "SETTLED") return "FORM_4";
  if (outcomeType === "FAILED") return "FORM_5";
  if (outcomeType === "WITHDRAWN") {
    return "WITHDRAWAL_RECORD";
  }

  return "";
}

function outcomeGenerateLabel(outcomeType: string) {
  if (outcomeType === "SETTLED") {
    return "Generate Form-4";
  }

  if (outcomeType === "FAILED") {
    return "Generate Form-5";
  }

  if (outcomeType === "WITHDRAWN") {
    return "Generate Withdrawal Record";
  }

  return "Generate Outcome Document";
}

function DocumentsPanel({
  caseId,
  outcome,
  documents,
  generating,
  canGenerateDocument,
  onGenerate,
  onRegenerate,
}: {
  caseId: number;
  outcome: any;
  documents: any[];
  generating: boolean;
  canGenerateDocument: boolean;
  onGenerate: () => void;
  onRegenerate: () => void;
}) {
  const documentType =
    outcomeDocumentType(outcome.outcome_type);

  const currentDocument = documents.find(
    (document) =>
      document.document_type === documentType &&
      document.is_current === 1
  );

  const canGenerate =
    canGenerateDocument &&
    outcome.outcome_type !== "NON_STARTER" &&
    outcome.outcome_type !== "WITHDRAWN" &&
    !currentDocument;

  const withdrawalUnavailable =
    outcome.outcome_type === "WITHDRAWN";

  return (
    <section className="rounded-lg bg-white p-6 shadow">
      <div className="mb-5 flex flex-col justify-between gap-3 md:flex-row md:items-center">
        <h2 className="text-lg font-semibold">
          Outcome Document
        </h2>

        {canGenerate && (
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating}
            className="rounded bg-black px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {generating
              ? "Generating..."
              : outcomeGenerateLabel(
                  outcome.outcome_type
            )}
          </button>
        )}

        {currentDocument &&
          !withdrawalUnavailable &&
          canGenerateDocument && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={generating}
            className="rounded border px-5 py-3 text-sm font-medium text-gray-900 disabled:opacity-50"
          >
            {generating
              ? "Generating..."
              : "Regenerate"}
          </button>
        )}
      </div>

      {withdrawalUnavailable && (
        <div className="mb-5 rounded border bg-gray-50 p-4 text-sm text-gray-700">
          Withdrawal document generation is unavailable until an approved template is configured.
        </div>
      )}

      {!currentDocument ? (
        <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">
          No outcome document generated.
        </div>
      ) : (
        <div className="rounded border p-4">
          <div className="grid gap-4 md:grid-cols-4">
            <Info
              label="Document"
              value={currentDocument.document_title}
            />
            <Info
              label="Type"
              value={currentDocument.document_type}
            />
            <Info
              label="Version"
              value={String(
                currentDocument.version_no
              )}
            />
            <Info
              label="Date"
              value={formatDate(
                currentDocument.document_date
              )}
            />
          </div>

          {currentDocument.has_file === 1 && (
            <div className="mt-5 flex justify-end">
              <a
                href={`/api/pim/documents/download/${caseId}/${currentDocument.id}`}
                className="rounded bg-black px-5 py-3 text-sm font-medium text-white"
              >
                View / Download
              </a>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function OutcomeDetails({ outcome }: { outcome: any }) {
  return (
    <section className="rounded-lg bg-white p-6 shadow">
      <h2 className="mb-5 text-lg font-semibold">
        Recorded Outcome
      </h2>

      <div className="grid gap-5 md:grid-cols-4">
        <Info label="Outcome" value={outcome.outcome_type} />
        <Info label="Outcome Date" value={formatDate(outcome.outcome_date)} />
        <Info label="Form" value={outcome.form_no || "-"} />
        <Info
          label="Verified By"
          value={
            outcome.verified_by_name
              ? `${outcome.verified_by_name}, ${outcome.verified_by_designation || ""}`.trim()
              : "-"
          }
        />
        <Info
          label="Approved By"
          value={
            outcome.approved_by_name
              ? `${outcome.approved_by_name}, ${outcome.approved_by_designation || ""}`.trim()
              : "-"
          }
        />
      </div>

      {outcome.settlement_terms && (
        <div className="mt-5">
          <Info label="Settlement Terms / Details" value={outcome.settlement_terms} />
        </div>
      )}

      {outcome.reason_text && (
        <div className="mt-5">
          <Info label="Reason / Details" value={outcome.reason_text} />
        </div>
      )}

      {outcome.remarks && (
        <div className="mt-5">
          <Info label="Remarks" value={outcome.remarks} />
        </div>
      )}
    </section>
  );
}

function Info({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </div>

      <div className="mt-1 whitespace-pre-wrap text-sm font-medium text-gray-900">
        {value || "-"}
      </div>
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">
        {label}
        {required ? " *" : ""}
      </label>

      <textarea
        rows={4}
        value={value}
        onChange={(event) =>
          onChange(event.target.value)
        }
        className="mt-2 w-full rounded border p-3 text-sm"
      />
    </div>
  );
}

function UserSelect({
  label,
  value,
  onChange,
  users,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  users: User[];
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">
        {label}
        {required ? " *" : ""}
      </label>

      <select
        value={value}
        onChange={(event) =>
          onChange(event.target.value)
        }
        className="mt-2 w-full rounded border p-3 text-sm"
      >
        <option value="">Select user</option>
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.display_name} - {user.designation}
          </option>
        ))}
      </select>
    </div>
  );
}
