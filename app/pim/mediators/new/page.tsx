"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePimAuth } from "../../../../lib/use-pim-auth";

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

const initialForm: FormState = {
  name: "",
  enrollmentNo: "",
  category: "ADVOCATE MEDIATOR",
  contactPhone: "",
  email: "",
  empanelmentOrderNo: "",
  empanelmentDate: "",
  panelValidUntil: "",
  rotationOrder: "",
  conflictDeclarationDate: "",
  remarks: "",
  active: true,
};

export default function NewMediatorPage() {
  const router = useRouter();
  const { hasPermission, loading } = usePimAuth();
  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canManage = hasPermission("MANAGE_MEDIATOR");

  function update<K extends keyof FormState>(
    key: K,
    value: FormState[K]
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function submit() {
    if (saving || !canManage) return;

    setSaving(true);
    setError("");

    try {
      const response = await fetch("/api/pim/mediators", {
        method: "POST",
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
        throw new Error(json.message || "Unable to add mediator.");
      }

      router.push(`/pim/mediators/${json.data.mediator.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to add mediator."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          Loading mediator access...
        </div>
      </main>
    );
  }

  if (!canManage) {
    return (
      <main className="p-6">
        <div className="mx-auto max-w-3xl rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
          You do not have permission to add mediators.
        </div>
      </main>
    );
  }

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Add Mediator</h1>
            <p className="mt-1 text-sm text-gray-500">
              Add a mediator to the office panel register.
            </p>
          </div>
          <Link
            href="/pim/mediators"
            className="rounded border px-4 py-2 text-sm font-medium"
          >
            Register
          </Link>
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

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
              onClick={submit}
              disabled={saving}
              className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "Saving..." : "Add Mediator"}
            </button>
          </div>
        </section>
      </div>
    </main>
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
