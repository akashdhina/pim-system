"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { usePimAuth } from "../../../../lib/use-pim-auth";

type Mediator = {
  id: number;
  name: string;
  enrollment_no: string | null;
  category: string | null;
  contact_phone: string | null;
  email: string | null;
  empanelment_order_no: string | null;
  empanelment_date: string | null;
  panel_valid_until: string | null;
  active: number;
  rotation_order: number | null;
  conflict_declaration_date: string | null;
  remarks: string | null;
  total_assignments: number;
  active_assignments: number;
  total_sessions: number;
  effective_sessions: number;
  settled_cases: number;
  failed_cases: number;
};

type Assignment = {
  id: number;
  case_id: number;
  pim_number: string | null;
  received_number: string | null;
  assignment_date: string | null;
  first_mediation_date: string | null;
  status: string;
  status_name: string | null;
  outcome_type: string | null;
};

type Session = {
  id: number;
  case_id: number;
  pim_number: string | null;
  received_number: string | null;
  sitting_number: number;
  scheduled_date: string | null;
  actual_date: string | null;
  session_status: string;
  effective_session: number;
  duration_minutes: number | null;
};

type PageData = {
  mediator: Mediator;
  activeAssignments: Assignment[];
  assignments: Assignment[];
  sessions: Session[];
};

type FormState = {
  name: string;
  enrollmentNo: string;
  category: string;
  contactPhone: string;
  email: string;
  empanelmentOrderNo: string;
  empanelmentDate: string;
  panelValidUntil: string;
  rotationOrder: string;
  conflictDeclarationDate: string;
  remarks: string;
  active: boolean;
};

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN");
}

function toForm(mediator: Mediator): FormState {
  return {
    name: mediator.name || "",
    enrollmentNo: mediator.enrollment_no || "",
    category: mediator.category || "ADVOCATE MEDIATOR",
    contactPhone: mediator.contact_phone || "",
    email: mediator.email || "",
    empanelmentOrderNo: mediator.empanelment_order_no || "",
    empanelmentDate: mediator.empanelment_date || "",
    panelValidUntil: mediator.panel_valid_until || "",
    rotationOrder:
      mediator.rotation_order === null ||
      mediator.rotation_order === undefined
        ? ""
        : String(mediator.rotation_order),
    conflictDeclarationDate:
      mediator.conflict_declaration_date || "",
    remarks: mediator.remarks || "",
    active: mediator.active === 1,
  };
}

export default function MediatorDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const { hasPermission } = usePimAuth();
  const [data, setData] = useState<PageData | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(
    searchParams.get("mode") === "edit"
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const canManage = hasPermission("MANAGE_MEDIATOR");

  useEffect(() => {
    fetch(`/api/pim/mediators/${id}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(json.message || "Unable to load mediator.");
        }

        return json.data;
      })
      .then((nextData) => {
        setData(nextData);
        setForm(toForm(nextData.mediator));
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Unable to load mediator."
        );
      })
      .finally(() => setLoading(false));
  }, [id]);

  function update<K extends keyof FormState>(
    key: K,
    value: FormState[K]
  ) {
    setForm((current) =>
      current
        ? {
            ...current,
            [key]: value,
          }
        : current
    );
  }

  async function save() {
    if (!form || !canManage || saving) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/mediators/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          rotationOrder: form.rotationOrder
            ? Number(form.rotationOrder)
            : null,
        }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to update mediator.");
      }

      const reload = await fetch(`/api/pim/mediators/${id}`, {
        cache: "no-store",
      });
      const reloadJson = await reload.json();

      setData(reloadJson.data);
      setForm(toForm(reloadJson.data.mediator));
      setEditing(false);
      setNotice(json.message || "Mediator updated.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update mediator."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          Loading mediator...
        </div>
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
          {error}
        </div>
      </main>
    );
  }

  if (!data || !form) return null;

  const mediator = data.mediator;

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold">{mediator.name}</h1>
            <p className="mt-1 text-sm text-gray-500">
              {mediator.category || "-"} / {mediator.enrollment_no || "-"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <button
                type="button"
                onClick={() => setEditing((current) => !current)}
                className="rounded border px-4 py-2 text-sm font-medium"
              >
                {editing ? "Cancel Edit" : "Edit"}
              </button>
            )}
            <Link
              href="/pim/mediators"
              className="rounded border px-4 py-2 text-sm font-medium"
            >
              Register
            </Link>
          </div>
        </div>

        {notice && (
          <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            {notice}
          </div>
        )}
        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        {editing && canManage ? (
          <section className="rounded-lg border bg-white p-5 shadow-sm">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Mediator name" value={form.name} onChange={(value) => update("name", value)} />
              <Field label="Enrollment number" value={form.enrollmentNo} onChange={(value) => update("enrollmentNo", value)} />
              <Field label="Category" value={form.category} onChange={(value) => update("category", value)} />
              <Field label="Phone" value={form.contactPhone} onChange={(value) => update("contactPhone", value)} />
              <Field label="Email" value={form.email} onChange={(value) => update("email", value)} />
              <Field label="Empanelment order no." value={form.empanelmentOrderNo} onChange={(value) => update("empanelmentOrderNo", value)} />
              <Field label="Empanelment date" type="date" value={form.empanelmentDate} onChange={(value) => update("empanelmentDate", value)} />
              <Field label="Panel valid until" type="date" value={form.panelValidUntil} onChange={(value) => update("panelValidUntil", value)} />
              <Field label="Rotation order" type="number" value={form.rotationOrder} onChange={(value) => update("rotationOrder", value)} />
              <Field label="Conflict declaration date" type="date" value={form.conflictDeclarationDate} onChange={(value) => update("conflictDeclarationDate", value)} />
            </div>
            <label className="mt-4 flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => update("active", event.target.checked)}
              />
              Active on panel
            </label>
            <label className="mt-4 block">
              <span className="text-sm font-medium text-gray-700">Remarks</span>
              <textarea
                rows={4}
                value={form.remarks}
                onChange={(event) => update("remarks", event.target.value)}
                className="mt-2 w-full rounded border p-3 text-sm"
              />
            </label>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </section>
        ) : (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Info label="Status" value={mediator.active ? "Active" : "Inactive"} />
            <Info label="Phone" value={mediator.contact_phone || "-"} />
            <Info label="Email" value={mediator.email || "-"} />
            <Info label="Order no." value={mediator.empanelment_order_no || "-"} />
            <Info label="Empanelment date" value={formatDate(mediator.empanelment_date)} />
            <Info label="Panel valid until" value={formatDate(mediator.panel_valid_until)} />
            <Info label="Rotation order" value={mediator.rotation_order === null ? "-" : String(mediator.rotation_order)} />
            <Info label="Conflict declaration" value={formatDate(mediator.conflict_declaration_date)} />
            <Info label="Total assignments" value={String(mediator.total_assignments || 0)} />
            <Info label="Active assignments" value={String(mediator.active_assignments || 0)} />
            <Info label="Sessions" value={`${mediator.total_sessions || 0} total / ${mediator.effective_sessions || 0} effective`} />
            <Info label="Outcomes" value={`${mediator.settled_cases || 0} settled / ${mediator.failed_cases || 0} failed`} />
          </section>
        )}

        <section
          id="assignments"
          className="rounded-lg border bg-white p-5 shadow-sm"
        >
          <h2 className="mb-4 text-lg font-semibold">
            Active Assignments
          </h2>
          <Table
            empty="No active assignments."
            columns={["PIM number", "Assignment", "First mediation", "Status"]}
            rows={data.activeAssignments.map((assignment) => [
              <Link key="case" href={`/pim/case/${assignment.case_id}`} className="font-medium hover:underline">
                {assignment.pim_number || assignment.received_number || "-"}
              </Link>,
              formatDate(assignment.assignment_date),
              formatDate(assignment.first_mediation_date),
              assignment.status_name || assignment.status,
            ])}
          />
        </section>

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">
            Historical Assignments
          </h2>
          <Table
            empty="No assignment history."
            columns={["PIM number", "Assignment", "Status", "Outcome"]}
            rows={data.assignments.map((assignment) => [
              <Link key="case" href={`/pim/case/${assignment.case_id}`} className="font-medium hover:underline">
                {assignment.pim_number || assignment.received_number || "-"}
              </Link>,
              formatDate(assignment.assignment_date),
              assignment.status,
              assignment.outcome_type || "-",
            ])}
          />
        </section>

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">
            Mediation Sessions
          </h2>
          <Table
            empty="No mediation sessions."
            columns={["PIM number", "Sitting", "Date", "Status", "Effective", "Duration"]}
            rows={data.sessions.map((session) => [
              session.pim_number || session.received_number || "-",
              String(session.sitting_number),
              formatDate(session.actual_date || session.scheduled_date),
              session.session_status,
              session.effective_session ? "Yes" : "No",
              session.duration_minutes === null
                ? "-"
                : `${session.duration_minutes} minutes`,
            ])}
          />
        </section>
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase text-gray-500">
        {label}
      </div>
      <div className="mt-2 text-sm font-semibold text-gray-950">
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
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded border p-3 text-sm"
      />
    </label>
  );
}

function Table({
  columns,
  rows,
  empty,
}: {
  columns: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr>
            {columns.map((column) => (
              <th key={column} className="whitespace-nowrap px-4 py-3 font-semibold">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.length === 0 ? (
            <tr>
              <td className="p-4" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="whitespace-nowrap px-4 py-3">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
