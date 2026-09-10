"use client";

import { useEffect, useState } from "react";

type MediationSession = {
  id: number;
  case_id: number;
  assignment_id: number;
  sitting_number: number;
  scheduled_date: string | null;
  actual_date: string | null;
  applicant_present: number;
  opposite_party_present: number;
  effective_session: number;
  actual_start_time: string | null;
  actual_end_time: string | null;
  duration_minutes: number | null;
  next_date: string | null;
  session_status: string;
  administrative_remarks: string | null;
};

type Assignment = {
  id: number;
  mediator_id: number;
  assignment_date: string;
  assignment_order_no: string | null;
  first_mediation_date: string | null;
  status: string;
  mediator_name: string;
  mediator_category: string | null;
  enrollment_no: string | null;
};

type CaseData = {
  id: number;
  pim_number: string | null;
  received_number: string | null;
  registration_date: string | null;
  claim_amount: number | null;
  status_code: string;
  status_name: string;
};

type PageData = {
  case: CaseData;
  assignment: Assignment | null;
  sessions: MediationSession[];
  cumulativeDurationMinutes: number;
  pendingTask: any;
  outcome: any;
};

function formatDuration(minutes: number | null) {
  if (minutes === null || minutes === undefined) {
    return "-";
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

function formatDate(value: string | null) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString("en-IN");
}

function money(value: number | null) {
  if (value === null || value === undefined) {
    return "-";
  }

  return `₹${Number(value).toLocaleString("en-IN")}`;
}

function statusClass(status: string) {
  if (status === "MEDIATION_PENDING") {
    return "bg-yellow-100 text-yellow-800";
  }

  if (status === "MEDIATION_ONGOING") {
    return "bg-blue-100 text-blue-800";
  }

  if (status === "OUTCOME_FORM_PENDING") {
    return "bg-purple-100 text-purple-800";
  }

  return "bg-gray-100 text-gray-800";
}

function isSessionRecorded(
  session: MediationSession
) {
  return Boolean(
    session.actual_date ||
      session.actual_start_time ||
      session.actual_end_time ||
      session.duration_minutes !== null ||
      session.session_status !== "SCHEDULED"
  );
}

function attendanceText(
  session: MediationSession,
  present: number
) {
  if (!isSessionRecorded(session)) {
    return "Not recorded";
  }

  return present ? "Yes" : "No";
}

function effectiveSessionText(
  session: MediationSession
) {
  if (!isSessionRecorded(session)) {
    return "Not determined";
  }

  return session.effective_session ? "Yes" : "No";
}
export default function MediationPage() {
  const [data, setData] =
    useState<PageData | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [error, setError] =
    useState("");

  const [success, setSuccess] =
    useState("");

  const [scheduledDate, setScheduledDate] =
    useState("");

  const [remarks, setRemarks] =
    useState("");

  useEffect(() => {
    const pathname =
      window.location.pathname;

    const match =
      pathname.match(/(\d+)$/);

    if (!match) {
      setError("Invalid case ID.");
      setLoading(false);
      return;
    }

    loadCase(match[1]);
  }, []);

  async function loadCase(caseId: string) {
    try {
      setLoading(true);
      setError("");

      const response =
        await fetch(
          `/api/pim/mediation/${caseId}`,
          {
            cache: "no-store",
          }
        );

      const json =
        await response.json();

      if (
        !response.ok ||
        !json.success
      ) {
        throw new Error(
          json.message ||
            "Unable to load mediation data."
        );
      }

      setData(json.data);

      if (
        json.data.assignment
          ?.first_mediation_date
      ) {
        setScheduledDate(
          json.data.assignment
            .first_mediation_date
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load mediation."
      );
    } finally {
      setLoading(false);
    }
  }

  async function scheduleFirstMediation() {
    if (saving) return;

    setError("");
    setSuccess("");

    if (!scheduledDate) {
      setError(
        "First mediation date is required."
      );
      return;
    }

    if (
      !confirm(
        `Fix first mediation for ${scheduledDate}?`
      )
    ) {
      return;
    }

    try {
      setSaving(true);

      const pathname =
        window.location.pathname;

      const match =
        pathname.match(/(\d+)$/);

      if (!match) {
        throw new Error(
          "Invalid case ID."
        );
      }

      const response =
        await fetch(
          `/api/pim/mediation/${match[1]}`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              scheduledDate,
              remarks:
                remarks.trim() ||
                null,
            }),
          }
        );

      const json =
        await response.json();

      if (
        !response.ok ||
        !json.success
      ) {
        throw new Error(
          json.message ||
            "Unable to fix first mediation."
        );
      }

      setSuccess(
        json.message
      );

      await loadCase(match[1]);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to fix first mediation."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          Loading mediation...
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

  if (!data) {
    return null;
  }

  const canSchedule =
    data.case.status_code ===
    "MEDIATOR_ASSIGNED";

  const firstScheduledSession =
    data.sessions.find(
      (session) => session.scheduled_date
    ) || null;

  const firstScheduledDateText =
    firstScheduledSession
      ? formatDate(
          firstScheduledSession.scheduled_date
        )
      : data.assignment
          ?.first_mediation_date
        ? formatDate(
            data.assignment
              .first_mediation_date
          )
        : "-";

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">

        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <div className="text-sm text-gray-500">
                PIM Mediation
              </div>

              <h1 className="mt-1 text-2xl font-bold">
                {data.case.pim_number ||
                  "PIM Number Not Assigned"}
              </h1>

              <p className="mt-1 text-sm text-gray-600">
                Received Number:{" "}
                {data.case.received_number ||
                  "-"}
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
            Application Details
          </h2>

          <div className="grid gap-5 md:grid-cols-4">
            <Info
              label="PIM Number"
              value={
                data.case.pim_number ||
                "-"
              }
            />

            <Info
              label="Registration Date"
              value={formatDate(
                data.case.registration_date
              )}
            />

            <Info
              label="Received Number"
              value={
                data.case.received_number ||
                "-"
              }
            />

            <Info
              label="Claim Amount"
              value={money(
                data.case.claim_amount
              )}
            />
          </div>
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Mediator Assignment
          </h2>

          {data.assignment ? (
            <div className="grid gap-5 md:grid-cols-4">
              <Info
                label="Mediator"
                value={
                  data.assignment
                    .mediator_name
                }
              />

              <Info
                label="Enrollment No."
                value={
                  data.assignment
                    .enrollment_no || "-"
                }
              />

              <Info
                label="Assignment Date"
                value={formatDate(
                  data.assignment
                    .assignment_date
                )}
              />

              <Info
                label="Assignment Order"
                value={
                  data.assignment
                    .assignment_order_no ||
                  "-"
                }
              />

              <Info
                label="First Mediation Date"
                value={formatDate(
                  data.assignment
                    .first_mediation_date
                )}
              />

              <Info
                label="Assignment Status"
                value={
                  data.assignment.status
                }
              />
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              No active mediator assignment.
            </p>
          )}
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            First Mediation
          </h2>

          {!canSchedule ? (
            <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">
              {firstScheduledSession ||
              data.assignment
                ?.first_mediation_date
                ? `First mediation has already been fixed for ${firstScheduledDateText}.`
                : "This case is not currently available for fixing the first mediation date."}
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  First Mediation Date
                </label>

                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(event) =>
                    setScheduledDate(
                      event.target.value
                    )
                  }
                  className="mt-2 w-full rounded border p-3 text-sm md:w-80"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Remarks
                </label>

                <textarea
                  rows={3}
                  value={remarks}
                  onChange={(event) =>
                    setRemarks(
                      event.target.value
                    )
                  }
                  placeholder="Optional remarks."
                  className="mt-2 w-full rounded border p-3 text-sm"
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={
                    scheduleFirstMediation
                  }
                  disabled={saving}
                  className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving
                    ? "Saving..."
                    : "Fix First Mediation Date"}
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Mediation Sessions
          </h2>

          <div className="mb-5 rounded border bg-gray-50 p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Cumulative Effective Duration
            </div>
            <div className="mt-1 text-lg font-semibold text-gray-900">
              {formatDuration(
                data.cumulativeDurationMinutes
              )}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              Sum of all effective sittings (both parties
              present). Adjourned sittings do not count.
            </div>
          </div>

          {data.sessions.length === 0 ? (
            <p className="text-sm text-gray-500">
              No mediation sessions recorded.
            </p>
          ) : (
            <div className="space-y-4">
              {data.sessions.map(
                (session) => (
                  <div
                    key={session.id}
                    className="rounded border p-5"
                  >
                    <div className="grid gap-5 md:grid-cols-4">
                      <Info
                        label="Sitting"
                        value={String(
                          session.sitting_number
                        )}
                      />

                      <Info
                        label="Scheduled Date"
                        value={formatDate(
                          session.scheduled_date
                        )}
                      />

                      <Info
                        label="Actual Date"
                        value={formatDate(
                          session.actual_date
                        )}
                      />

                      <Info
                        label="Session Status"
                        value={
                          session.session_status
                        }
                      />

                      <Info
                        label="Applicant Present"
                        value={attendanceText(
                          session,
                          session.applicant_present
                        )}
                      />

                      <Info
                        label="Opposite Party Present"
                        value={attendanceText(
                          session,
                          session.opposite_party_present
                        )}
                      />

                      <Info
                        label="Effective Session"
                        value={effectiveSessionText(
                          session
                        )}
                      />

                      <Info
                        label="Duration"
                        value={formatDuration(
                          session.duration_minutes
                        )}
                      />
                    </div>

                    {session.session_status ===
                      "SCHEDULED" && (
                      <div className="mt-5 flex justify-end">
                        <a
                          href={`/pim/mediation/session/${session.id}`}
                          className="rounded bg-black px-5 py-3 text-sm font-medium text-white"
                        >
                          Record Sitting {session.sitting_number}
                        </a>
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">
            Workflow
          </h2>

          <div className="grid gap-3 md:grid-cols-6">
            <Step
              number="1"
              label="Fee Received"
              done={
                data.case.status_code !==
                "FEE_PENDING"
              }
              current={
                data.case.status_code ===
                "FEE_PENDING"
              }
            />

            <Step
              number="2"
              label="Mediator Assigned"
              done={
                Boolean(data.assignment)
              }
              current={
                data.case.status_code ===
                "MEDIATOR_ASSIGNMENT_PENDING"
              }
            />

            <Step
              number="3"
              label="First Mediation Fixed"
              done={
                data.sessions.length > 0
              }
              current={
                data.case.status_code ===
                "MEDIATOR_ASSIGNED"
              }
            />

            <Step
              number="4"
              label="Mediation Pending"
              done={
                data.case.status_code ===
                  "MEDIATION_ONGOING" ||
                data.sessions.some(
                  (s) =>
                    s.session_status !==
                    "SCHEDULED"
                )
              }
              current={
                data.case.status_code ===
                "MEDIATION_PENDING"
              }
            />

            <Step
              number="5"
              label="Mediation Ongoing"
              done={
                data.case.status_code ===
                  "OUTCOME_FORM_PENDING" ||
                data.case.status_code.startsWith(
                  "CLOSED"
                )
              }
              current={
                data.case.status_code ===
                "MEDIATION_ONGOING"
              }
            />

            <Step
              number="6"
              label="Outcome"
              done={
                data.case.status_code.startsWith(
                  "CLOSED"
                )
              }
              current={
                data.case.status_code ===
                "OUTCOME_FORM_PENDING"
              }
            />
          </div>

          {data.case.status_code ===
            "OUTCOME_FORM_PENDING" && (
            <div className="mt-5 flex justify-end">
              <a
                href={`/pim/outcome/${data.case.id}`}
                className="rounded bg-black px-5 py-3 text-sm font-medium text-white"
              >
                {data.outcome
                  ? "Review Outcome / Close"
                  : "Record Outcome"}
              </a>
            </div>
          )}
        </section>

      </div>
    </main>
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

      <div className="mt-1 text-sm font-medium text-gray-900">
        {value}
      </div>
    </div>
  );
}

function Step({
  number,
  label,
  done,
  current,
}: {
  number: string;
  label: string;
  done?: boolean;
  current?: boolean;
}) {
  return (
    <div
      className={`rounded border p-4 ${
        current
          ? "border-yellow-300 bg-yellow-50"
          : done
            ? "border-green-300 bg-green-50"
            : "bg-gray-50"
      }`}
    >
      <div className="text-xs text-gray-500">
        Step {number}
      </div>

      <div className="mt-1 font-semibold">
        {label}
      </div>

      <div className="mt-1 text-xs text-gray-600">
        {current
          ? "Current"
          : done
            ? "Completed"
            : "Pending"}
      </div>
    </div>
  );
}



