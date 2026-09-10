"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { usePimAuth } from "../../../../../lib/use-pim-auth";

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN");
}

function currentForm3(documents: any[]) {
  return documents.find(
    (document) =>
      document.normalized_document_type === "FORM_3" &&
      document.is_current === 1 &&
      document.has_file === 1
  );
}

export default function NonStarterAuthorityPage() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;
  const { hasPermission } = usePimAuth();
  const [caseData, setCaseData] = useState<any | null>(null);
  const [nonstarter, setNonstarter] = useState<any | null>(null);
  const [remarks, setRemarks] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canApprove = hasPermission("APPROVE_NONSTARTER_AUTHORITY");

  async function load() {
    const [caseResponse, nonstarterResponse] = await Promise.all([
      fetch(`/api/pim/case/${caseId}`, { cache: "no-store" }),
      fetch(`/api/pim/nonstarter/${caseId}`, { cache: "no-store" }),
    ]);
    const caseJson = await caseResponse.json();
    const nonstarterJson = await nonstarterResponse.json();

    if (!caseResponse.ok || !caseJson.success) {
      throw new Error(caseJson.message || "Unable to load case.");
    }
    if (!nonstarterResponse.ok || !nonstarterJson.success) {
      throw new Error(
        nonstarterJson.message || "Unable to load non-starter details."
      );
    }

    setCaseData(caseJson.data);
    setNonstarter(nonstarterJson.data);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
      .catch((err) =>
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load authority decision page."
        )
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  async function recordDecision() {
    if (!canApprove || saving) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/nonstarter/authority/${caseId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ remarks }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          json.message || "Unable to record authority decision."
        );
      }

      setNotice(json.message || "Authority decision recorded.");
      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to record authority decision."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          Loading authority decision...
        </div>
      </main>
    );
  }

  if (error && !caseData) {
    return (
      <main className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
          {error}
        </div>
      </main>
    );
  }

  const c = caseData.case;
  const outcome = nonstarter.outcome;
  const document = currentForm3(caseData.documents);
  const authorityTask = nonstarter.tasks.find(
    (task: any) => task.task_type_code === "NONSTARTER_AUTHORITY"
  );
  const branchDocket = caseData.docket.filter((entry: any) =>
    ["NONSTARTER_RECORDED", "FORM3", "AUTHORITY_DECISION", "CLOSURE"].includes(
      entry.event_code
    )
  );
  const branchHistory = caseData.statusHistory.filter((entry: any) =>
    [
      "OUTCOME_FORM_PENDING",
      "AUTHORITY_DECISION_PENDING",
      "CLOSED_NON_STARTER",
    ].includes(entry.to_status_code)
  );

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">
              Authority Decision
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Non-starter authority review for {c.pim_number || c.received_number || "-"}.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href={`/pim/case/${caseId}`} className="rounded border px-4 py-2 text-sm font-medium">
              Case
            </Link>
            <Link href="/pim/tasks" className="rounded border px-4 py-2 text-sm font-medium">
              Tasks
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

        <section className="grid gap-3 md:grid-cols-3">
          <Info label="PIM number" value={c.pim_number || "-"} />
          <Info label="Received number" value={c.received_number || "-"} />
          <Info label="Current status" value={c.status_name || "-"} />
          <Info label="Applicant" value={caseData.parties.find((p: any) => p.role === "APPLICANT")?.name || "-"} />
          <Info label="Opposite party" value={caseData.parties.find((p: any) => p.role === "OPPOSITE_PARTY")?.name || "-"} />
          <Info label="Reason" value={outcome?.nonstarter_reason_name || outcome?.reason_text || "-"} />
          <Info label="Reason code" value={outcome?.nonstarter_reason_code || "-"} />
          <Info label="Authority task" value={authorityTask ? authorityTask.status : "Not found"} />
          <Info label="Approved by" value={outcome?.approved_by_name || "-"} />
        </section>

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Form-3 Document</h2>
          {document ? (
            <div className="mt-3 flex flex-col justify-between gap-3 rounded border p-4 md:flex-row md:items-center">
              <div>
                <div className="font-medium">{document.document_title}</div>
                <div className="text-sm text-gray-500">
                  Version {document.version_no} / {formatDate(document.document_date)}
                </div>
              </div>
              <a
                href={`/api/pim/documents/download/${caseId}/${document.id}`}
                className="rounded border px-4 py-2 text-sm font-medium"
              >
                Download
              </a>
            </div>
          ) : (
            <p className="mt-3 text-sm text-gray-500">
              Form-3 must be completed before authority decision.
            </p>
          )}
        </section>

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Record Decision</h2>
          <label className="mt-4 block">
            <span className="text-xs font-medium uppercase text-gray-500">
              Remarks
            </span>
            <textarea
              value={remarks}
              onChange={(event) => setRemarks(event.target.value)}
              rows={3}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={recordDecision}
            disabled={
              !canApprove ||
              saving ||
              c.status_code !== "AUTHORITY_DECISION_PENDING" ||
              !document ||
              authorityTask?.status !== "PENDING"
            }
            className="mt-4 rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {saving ? "Recording..." : "Record Authority Decision"}
          </button>
        </section>

        <section className="grid gap-5 md:grid-cols-2">
          <History title="Non-Starter Docket" rows={branchDocket} dateKey="docket_date" textKey="entry_text" />
          <History title="Status History" rows={branchHistory} dateKey="changed_at" textKey="reason" />
        </section>
      </div>
    </main>
  );
}

function History({
  title,
  rows,
  dateKey,
  textKey,
}: {
  title: string;
  rows: any[];
  dateKey: string;
  textKey: string;
}) {
  return (
    <section className="rounded-lg border bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4 space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500">No entries found.</p>
        ) : (
          rows.map((row) => (
            <div key={`${title}-${row.id}`} className="rounded border p-3">
              <div className="text-xs text-gray-500">
                {formatDate(row[dateKey])}
              </div>
              <div className="mt-1 text-sm">{row[textKey] || "-"}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase text-gray-500">{label}</div>
      <div className="mt-2 text-sm font-semibold text-gray-950">{value}</div>
    </div>
  );
}
