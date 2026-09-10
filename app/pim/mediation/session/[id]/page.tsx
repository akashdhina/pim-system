"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type SessionData = {
  id: number;
  case_id: number;
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
  pim_number: string | null;
  received_number: string | null;
  case_status_code: string;
  case_status_name: string;
  mediator_name: string;
  mediator_category: string | null;
  enrollment_no: string | null;
};

type PageData = {
  session: SessionData;
};

type PresentValue = "" | "yes" | "no";

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

function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes)
  ) {
    return null;
  }

  return hours * 60 + minutes;
}

function calculateDuration(start: string, end: string) {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);

  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  if (endMinutes <= startMinutes) {
    return null;
  }

  return endMinutes - startMinutes;
}

function formatDuration(minutes: number | null) {
  if (minutes === null || minutes === undefined) {
    return "-";
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

type NextAction = "" | "READY_FOR_SETTLEMENT" | "READY_FOR_FAILURE";

function statusClass(status: string) {
  if (status === "SCHEDULED") {
    return "bg-yellow-100 text-yellow-800";
  }

  if (status === "COMPLETED") {
    return "bg-green-100 text-green-800";
  }

  if (status === "ADJOURNED") {
    return "bg-blue-100 text-blue-800";
  }

  return "bg-gray-100 text-gray-800";
}

export default function SessionRecordingPage() {
  const params = useParams();
  const id = params.id as string;

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

  const [applicantPresent, setApplicantPresent] =
    useState<PresentValue>("");
  const [oppositePartyPresent, setOppositePartyPresent] =
    useState<PresentValue>("");
  const [actualDate, setActualDate] =
    useState(today());
  const [actualStartTime, setActualStartTime] =
    useState("");
  const [actualEndTime, setActualEndTime] =
    useState("");
  const [nextSittingRequired, setNextSittingRequired] =
    useState(false);
  const [nextDate, setNextDate] =
    useState("");
  const [nextAction, setNextAction] =
    useState<NextAction>("");
  const [administrativeRemarks, setAdministrativeRemarks] =
    useState("");

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(
        `/api/pim/mediation/session/${id}`,
        { cache: "no-store" }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          json.message || "Unable to load mediation sitting."
        );
      }

      const pageData = json.data as PageData;
      setData(pageData);

      const session = pageData.session;
      setActualDate(session.actual_date || today());
      setApplicantPresent(
        session.actual_date
          ? session.applicant_present
            ? "yes"
            : "no"
          : ""
      );
      setOppositePartyPresent(
        session.actual_date
          ? session.opposite_party_present
            ? "yes"
            : "no"
          : ""
      );
      setActualStartTime(session.actual_start_time || "");
      setActualEndTime(session.actual_end_time || "");
      setNextSittingRequired(Boolean(session.next_date));
      setNextDate(session.next_date || "");
      setAdministrativeRemarks(
        session.administrative_remarks || ""
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load mediation sitting."
      );
    } finally {
      setLoading(false);
    }
  }

  const bothPresent =
    applicantPresent === "yes" &&
    oppositePartyPresent === "yes";

  const eitherAbsent =
    applicantPresent === "no" ||
    oppositePartyPresent === "no";

  const durationMinutes = useMemo(() => {
    if (!bothPresent || !actualStartTime || !actualEndTime) {
      return null;
    }

    return calculateDuration(
      actualStartTime,
      actualEndTime
    );
  }, [bothPresent, actualStartTime, actualEndTime]);

  async function saveSession() {
    if (saving || !data) return;

    setError("");
    setSuccess("");

    if (data.session.session_status !== "SCHEDULED") {
      setError(
        `This sitting has already been recorded. Current status: ${data.session.session_status}.`
      );
      return;
    }

    if (!applicantPresent || !oppositePartyPresent) {
      setError("Record attendance for both parties.");
      return;
    }

    if (!actualDate) {
      setError("Actual date is required.");
      return;
    }

    if (actualDate > today()) {
      setError("Actual date cannot be a future date.");
      return;
    }


    if (
      data.session.scheduled_date &&
      actualDate < data.session.scheduled_date
    ) {
      setError(
        "Actual date cannot be earlier than the scheduled date."
      );
      return;
    }
    if (bothPresent) {
      if (!actualStartTime || !actualEndTime) {
        setError(
          "Actual start time and actual end time are required when both parties are present."
        );
        return;
      }

      if (durationMinutes === null) {
        setError(
          "Actual end time must be later than actual start time."
        );
        return;
      }
    }

    if (eitherAbsent) {
      if (actualStartTime || actualEndTime) {
        setError(
          "Start/end time must not be recorded for an ineffective sitting."
        );
        return;
      }

      if (!nextSittingRequired || !nextDate) {
        setError(
          "Next sitting date is required when either party is absent."
        );
        return;
      }
    }

    if (nextSittingRequired && !nextDate) {
      setError("Next sitting date is required.");
      return;
    }

    if (bothPresent && !nextSittingRequired && !nextAction) {
      setError(
        "Select the next action: ready for settlement or ready for failure outcome."
      );
      return;
    }

    if (!confirm("Record this mediation sitting?")) return;

    try {
      setSaving(true);

      const response = await fetch(
        `/api/pim/mediation/session/${id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            actualDate,
            applicantPresent: applicantPresent === "yes",
            oppositePartyPresent:
              oppositePartyPresent === "yes",
            actualStartTime: bothPresent
              ? actualStartTime
              : null,
            actualEndTime: bothPresent
              ? actualEndTime
              : null,
            nextDate: nextSittingRequired
              ? nextDate
              : null,
            nextAction:
              bothPresent && !nextSittingRequired
                ? nextAction
                : null,
            administrativeRemarks:
              administrativeRemarks.trim() || null,
          }),
        }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          json.message || "Unable to record mediation sitting."
        );
      }

      setSuccess(
        json.message || "Mediation sitting recorded."
      );
      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to record mediation sitting."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          Loading sitting...
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

  const session = data.session;
  const canRecord = session.session_status === "SCHEDULED";

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap gap-2 text-sm">
          <Link
            href={`/pim/case/${session.case_id}`}
            className="rounded border bg-white px-3 py-2 font-medium"
          >
            Back to Case
          </Link>
          <Link
            href="/pim/tasks"
            className="rounded border bg-white px-3 py-2 font-medium"
          >
            Back to Tasks
          </Link>
          <Link
            href="/pim"
            className="rounded border bg-white px-3 py-2 font-medium"
          >
            Dashboard
          </Link>
        </div>

        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <div className="text-sm text-gray-500">
                Mediation Sitting Record
              </div>
              <h1 className="mt-1 text-2xl font-bold">
                {session.pim_number || "PIM Number Not Assigned"}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                Received Number: {session.received_number || "-"}
              </p>
            </div>

            <span
              className={`rounded-full px-4 py-2 text-sm font-semibold ${statusClass(
                session.session_status
              )}`}
            >
              {session.session_status}
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
            Sitting Details
          </h2>

          <div className="grid gap-5 md:grid-cols-4">
            <Info label="Mediator" value={session.mediator_name} />
            <Info label="Enrollment No." value={session.enrollment_no || "-"} />
            <Info label="Sitting Number" value={String(session.sitting_number)} />
            <Info label="Scheduled Date" value={formatDate(session.scheduled_date)} />
            <Info label="Case Stage" value={session.case_status_name} />
            <Info label="Session Status" value={session.session_status} />
          </div>
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Attendance
          </h2>

          {!canRecord ? (
            <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">
              This sitting has already been recorded.
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-5 md:grid-cols-2">
                <Choice
                  label="Applicant Present"
                  value={applicantPresent}
                  onChange={setApplicantPresent}
                />
                <Choice
                  label="Opposite Party Present"
                  value={oppositePartyPresent}
                  onChange={setOppositePartyPresent}
                />
              </div>

              <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">
                Effective session: {bothPresent ? "Yes" : "No"}
              </div>

              <div className="grid gap-5 md:grid-cols-3">
                <Field
                  label="Actual Date"
                  value={actualDate}
                  onChange={setActualDate}
                  type="date"
                />

                {bothPresent && (
                  <>
                    <Field
                      label="Actual Start Time"
                      value={actualStartTime}
                      onChange={setActualStartTime}
                      type="time"
                    />
                    <Field
                      label="Actual End Time"
                      value={actualEndTime}
                      onChange={setActualEndTime}
                      type="time"
                    />
                  </>
                )}
              </div>

              <div className="grid gap-5 md:grid-cols-3">
                <Info
                  label="Duration"
                  value={
                    bothPresent
                      ? formatDuration(durationMinutes)
                      : "-"
                  }
                />
              </div>

              <label className="flex items-center gap-3 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={nextSittingRequired}
                  onChange={(event) => {
                    setNextSittingRequired(
                      event.target.checked
                    );
                    if (event.target.checked) {
                      setNextAction("");
                    }
                  }}
                  className="h-4 w-4"
                />
                Next sitting required
              </label>

              {nextSittingRequired && (
                <Field
                  label="Next Sitting Date"
                  value={nextDate}
                  onChange={setNextDate}
                  type="date"
                />
              )}

              {bothPresent && !nextSittingRequired && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Next Action
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    No further sitting is required. Record the
                    staff assessment - this does not generate
                    Form IV/V or close the case; it only routes
                    the case to the outcome-form stage.
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        setNextAction("READY_FOR_SETTLEMENT")
                      }
                      className={`rounded border p-3 text-sm font-medium ${
                        nextAction === "READY_FOR_SETTLEMENT"
                          ? "border-green-400 bg-green-50 text-green-800"
                          : "bg-white"
                      }`}
                    >
                      Ready for Settlement
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setNextAction("READY_FOR_FAILURE")
                      }
                      className={`rounded border p-3 text-sm font-medium ${
                        nextAction === "READY_FOR_FAILURE"
                          ? "border-red-400 bg-red-50 text-red-800"
                          : "bg-white"
                      }`}
                    >
                      Ready for Failure
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Remarks
                </label>
                <textarea
                  rows={4}
                  value={administrativeRemarks}
                  onChange={(event) =>
                    setAdministrativeRemarks(
                      event.target.value
                    )
                  }
                  className="mt-2 w-full rounded border p-3 text-sm"
                />
              </div>

              <div className="flex justify-between gap-3">
                <a
                  href={`/pim/mediation/${session.case_id}`}
                  className="rounded border px-5 py-3 text-sm font-medium"
                >
                  Back to Mediation
                </a>
                <button
                  type="button"
                  onClick={saveSession}
                  disabled={saving}
                  className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Record Sitting"}
                </button>
              </div>
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

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded border p-3 text-sm"
      />
    </div>
  );
}

function Choice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PresentValue;
  onChange: (value: PresentValue) => void;
}) {
  return (
    <div>
      <div className="block text-sm font-medium text-gray-700">
        {label}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onChange("yes")}
          className={`rounded border p-3 text-sm font-medium ${
            value === "yes"
              ? "border-green-400 bg-green-50 text-green-800"
              : "bg-white"
          }`}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => onChange("no")}
          className={`rounded border p-3 text-sm font-medium ${
            value === "no"
              ? "border-red-400 bg-red-50 text-red-800"
              : "bg-white"
          }`}
        >
          No
        </button>
      </div>
    </div>
  );
}
