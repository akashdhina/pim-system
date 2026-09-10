"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type CaseData = {
  id: number;
  pim_number: string | null;
  received_number: string | null;
  registration_date: string | null;
  claim_amount: number | null;
  status_code: string;
  status_name: string;
};

type Mediator = {
  id: number;
  name: string;
  category: string | null;
  enrollment_no: string | null;
  contact_phone: string | null;
  email: string | null;
  rotation_order: number | null;
};

type Assignment = {
  id: number;
  mediator_id: number;
  mediator_name: string;
  mediator_category: string | null;
  enrollment_no: string | null;
  assignment_date: string;
  assignment_order_no: string | null;
  first_mediation_date: string | null;
  status: string;
};

type PendingTask = {
  id: number;
  task_type_code: string | null;
  due_date: string | null;
  status: string;
};

type PageData = {
  case: CaseData;
  mediators: Mediator[];
  assignments: Assignment[];
  pendingTask: PendingTask | null;
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN");
}

function money(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `₹${Number(value).toLocaleString("en-IN")}`;
}

function statusClass(status: string) {
  if (status === "MEDIATOR_ASSIGNMENT_PENDING") return "bg-yellow-100 text-yellow-800";
  if (status === "MEDIATOR_ASSIGNED") return "bg-blue-100 text-blue-800";
  return "bg-gray-100 text-gray-800";
}

export default function MediatorPage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [mediatorId, setMediatorId] = useState("");
  const [assignmentOrderNo, setAssignmentOrderNo] = useState("");
  const [firstMediationDate, setFirstMediationDate] = useState("");
  const [deviationFromRotation, setDeviationFromRotation] = useState(false);
  const [deviationReason, setDeviationReason] = useState("");
  const [remarks, setRemarks] = useState("");

  const [showReassign, setShowReassign] = useState(false);
  const [reassignMediatorId, setReassignMediatorId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [reassigning, setReassigning] = useState(false);

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`/api/pim/mediator/${id}`, {
        cache: "no-store",
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to load mediator data.");
      }

      setData(json.data);
      if (json.data.mediators.length && !mediatorId) {
        setMediatorId(String(json.data.mediators[0].id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load mediator data.");
    } finally {
      setLoading(false);
    }
  }

  async function assignMediator() {
    if (saving) return;

    setError("");
    setSuccess("");

    if (!mediatorId) {
      setError("Select a mediator.");
      return;
    }

    if (deviationFromRotation && !deviationReason.trim()) {
      setError("Deviation reason is required when rotation is overridden.");
      return;
    }

    if (!confirm("Assign this mediator to the PIM case?")) return;

    try {
      setSaving(true);

      const response = await fetch(`/api/pim/mediator/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediatorId: Number(mediatorId),
          assignmentOrderNo: assignmentOrderNo.trim() || null,
          firstMediationDate: firstMediationDate || null,
          deviationFromRotation,
          deviationReason: deviationReason.trim() || null,
          remarks: remarks.trim() || null,
        }),
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to assign mediator.");
      }

      setSuccess(json.message || "Mediator assigned.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to assign mediator.");
    } finally {
      setSaving(false);
    }
  }

  async function reassignMediator() {
    if (reassigning) return;

    setError("");
    setSuccess("");

    if (!reassignMediatorId) {
      setError("Select the new mediator.");
      return;
    }

    if (!reassignReason.trim()) {
      setError("A reason for reassignment is required.");
      return;
    }

    if (!confirm("Reassign this case to the selected mediator?")) return;

    try {
      setReassigning(true);

      const response = await fetch(`/api/pim/mediator/reassign/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediatorId: Number(reassignMediatorId),
          reason: reassignReason.trim(),
        }),
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to reassign mediator.");
      }

      setSuccess(json.message || "Mediator reassigned.");
      setShowReassign(false);
      setReassignMediatorId("");
      setReassignReason("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reassign mediator.");
    } finally {
      setReassigning(false);
    }
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-100 p-6"><div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">Loading mediator assignment...</div></main>;
  }

  if (error && !data) {
    return <main className="min-h-screen bg-gray-100 p-6"><div className="mx-auto max-w-6xl rounded-lg border border-red-300 bg-red-50 p-6 text-red-800">{error}</div></main>;
  }

  if (!data) return null;

  const canAssign = data.case.status_code === "MEDIATOR_ASSIGNMENT_PENDING";
  const activeAssignment = data.assignments.find((assignment) => assignment.status === "ACTIVE") || null;
  const canReassign = ["MEDIATOR_ASSIGNED", "MEDIATION_PENDING", "MEDIATION_ONGOING"].includes(
    data.case.status_code
  );
  const reassignCandidates = data.mediators.filter(
    (mediator) => mediator.id !== activeAssignment?.mediator_id
  );

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <div className="text-sm text-gray-500">PIM Mediator Assignment</div>
              <h1 className="mt-1 text-2xl font-bold">{data.case.pim_number || "PIM Number Not Assigned"}</h1>
              <p className="mt-1 text-sm text-gray-600">Received Number: {data.case.received_number || "-"}</p>
            </div>
            <span className={`rounded-full px-4 py-2 text-sm font-semibold ${statusClass(data.case.status_code)}`}>{data.case.status_name}</span>
          </div>

          {error && <div className="mt-5 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
          {success && <div className="mt-5 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-800">{success}</div>}
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Case Details</h2>
          <div className="grid gap-5 md:grid-cols-4">
            <Info label="Registration Date" value={formatDate(data.case.registration_date)} />
            <Info label="Claim Amount" value={money(data.case.claim_amount)} />
            <Info label="Available Mediators" value={String(data.mediators.length)} />
            <Info label="Pending Task" value={data.pendingTask ? "Yes" : "No"} />
            <Info label="Task Type" value={data.pendingTask?.task_type_code || "-"} />
            <Info label="Due Date" value={formatDate(data.pendingTask?.due_date || null)} />
          </div>
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Mediator Assignment</h2>

          {activeAssignment ? (
            <div className="space-y-5">
              <div className="rounded border border-blue-300 bg-blue-50 p-4 text-sm text-blue-800">A mediator is already assigned for this case.</div>
              <div className="grid gap-5 md:grid-cols-4">
                <Info label="Mediator" value={activeAssignment.mediator_name} />
                <Info label="Enrollment No." value={activeAssignment.enrollment_no || "-"} />
                <Info label="Assignment Date" value={formatDate(activeAssignment.assignment_date)} />
                <Info label="First Mediation Date" value={formatDate(activeAssignment.first_mediation_date)} />
              </div>
              <div className="flex flex-wrap gap-3">
                <a href={`/pim/mediation/${id}`} className="inline-flex rounded bg-black px-5 py-3 text-sm font-medium text-white">Go to Mediation</a>
                {canReassign && !showReassign && (
                  <button
                    type="button"
                    onClick={() => setShowReassign(true)}
                    className="inline-flex rounded border px-5 py-3 text-sm font-medium text-gray-900"
                  >
                    Reassign Mediator
                  </button>
                )}
              </div>

              {canReassign && showReassign && (
                <div className="rounded border border-amber-300 bg-amber-50 p-5">
                  <h3 className="font-semibold text-amber-900">Reassign Mediator</h3>
                  <p className="mt-1 text-sm text-amber-800">
                    The current assignment is preserved as historical
                    record. Past sittings remain attributed to{" "}
                    {activeAssignment.mediator_name}; only sittings
                    recorded after this point will use the new mediator.
                  </p>

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">New Mediator</label>
                      <select
                        value={reassignMediatorId}
                        onChange={(event) => setReassignMediatorId(event.target.value)}
                        className="mt-2 w-full rounded border p-3 text-sm"
                      >
                        <option value="">Select mediator</option>
                        {reassignCandidates.map((mediator) => (
                          <option key={mediator.id} value={mediator.id}>
                            {mediator.name}
                            {mediator.enrollment_no ? ` - ${mediator.enrollment_no}` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Field label="Reason for Reassignment" value={reassignReason} onChange={setReassignReason} />
                  </div>

                  <div className="mt-4 flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setShowReassign(false)}
                      className="rounded border px-5 py-3 text-sm font-medium text-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={reassignMediator}
                      disabled={reassigning}
                      className="rounded bg-black px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {reassigning ? "Reassigning..." : "Confirm Reassignment"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : !canAssign ? (
            <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">This case is not currently available for mediator assignment.</div>
          ) : data.mediators.length === 0 ? (
            <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">No active mediators are configured.</div>
          ) : (
            <div className="space-y-5">
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Mediator</label>
                  <select value={mediatorId} onChange={(event) => setMediatorId(event.target.value)} className="mt-2 w-full rounded border p-3 text-sm">
                    {data.mediators.map((mediator) => (
                      <option key={mediator.id} value={mediator.id}>{mediator.rotation_order ? `${mediator.rotation_order}. ` : ""}{mediator.name}{mediator.enrollment_no ? ` - ${mediator.enrollment_no}` : ""}</option>
                    ))}
                  </select>
                </div>

                <Field label="Assignment Order No." value={assignmentOrderNo} onChange={setAssignmentOrderNo} />
                <Field label="Proposed First Mediation Date" value={firstMediationDate} onChange={setFirstMediationDate} type="date" />
              </div>

              <label className="flex items-center gap-3 text-sm text-gray-700">
                <input type="checkbox" checked={deviationFromRotation} onChange={(event) => setDeviationFromRotation(event.target.checked)} className="h-4 w-4" />
                Deviation from mediator rotation
              </label>

              {deviationFromRotation && <Field label="Deviation Reason" value={deviationReason} onChange={setDeviationReason} />}

              <div>
                <label className="block text-sm font-medium text-gray-700">Remarks</label>
                <textarea rows={3} value={remarks} onChange={(event) => setRemarks(event.target.value)} className="mt-2 w-full rounded border p-3 text-sm" />
              </div>

              <div className="flex justify-end">
                <button type="button" onClick={assignMediator} disabled={saving} className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50">{saving ? "Saving..." : "Assign Mediator"}</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div><div className="mt-1 text-sm font-medium text-gray-900">{value}</div></div>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <div><label className="block text-sm font-medium text-gray-700">{label}</label><input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded border p-3 text-sm" /></div>;
}

