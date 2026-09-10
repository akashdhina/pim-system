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

function getForm3RuleReference(outcome: any) {
  const source = [
    outcome?.rule_reference,
    outcome?.nonstarter_reason_code,
    outcome?.reason_code,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  return source.includes("3(6)") ||
    source.includes("3_6") ||
    source.includes("3(5)-(6)") ||
    source.includes("3(5)-3(6)")
    ? "3(6)"
    : "3(4)";
}

export default function NonStarterForm3Page() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;
  const { hasPermission } = usePimAuth();
  const [caseData, setCaseData] = useState<any | null>(null);
  const [nonstarter, setNonstarter] = useState<any | null>(null);
  const [ruleReference, setRuleReference] = useState("3(4)");
  const [remarks, setRemarks] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedReasonId, setSelectedReasonId] = useState("");

  const canGenerate = hasPermission("GENERATE_DOCUMENT");
  const canComplete = hasPermission("COMPLETE_NONSTARTER_FORM3");
  const canRecord = hasPermission("RECORD_OUTCOME");

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
    setRuleReference(
      getForm3RuleReference(nonstarterJson.data.outcome)
    );

    if (
      !nonstarterJson.data.outcome &&
      nonstarterJson.data.context?.reasonCode
    ) {
      const recommended = nonstarterJson.data.nonstarterReasons.find(
        (r: any) => r.code === nonstarterJson.data.context.reasonCode
      );
      if (recommended) {
        setSelectedReasonId(String(recommended.id));
      }
    }
  }

  async function recordNonStarter() {
    if (!canRecord || saving || !selectedReasonId) return;
    if (!confirm("Record this case as Non-Starter?")) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/nonstarter/${caseId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nonstarterReasonId: Number(selectedReasonId),
          remarks,
        }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to record non-starter outcome.");
      }

      setNotice("Non-starter outcome recorded. Form-3 is now pending.");
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to record non-starter outcome."
      );
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
      .catch((err) =>
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load Form-3 page."
        )
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  async function generate(regenerate = false) {
    if (!canGenerate || saving) return;
    if (regenerate && !confirm("Regenerate current Form-3?")) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/documents/form3/${caseId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ruleReference, remarks }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to generate Form-3.");
      }

      setNotice(regenerate ? "Form-3 regenerated." : "Form-3 generated.");
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to generate Form-3."
      );
    } finally {
      setSaving(false);
    }
  }

  async function complete() {
    if (!canComplete || saving || !caseData) return;

    const document = currentForm3(caseData.documents);
    if (!document) {
      setError("Generate Form-3 before completing this task.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/nonstarter/form3/${caseId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documentId: document.id,
          remarks,
        }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to complete Form-3.");
      }

      setNotice(json.message || "Form-3 completed.");
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to complete Form-3."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          Loading Form-3 workflow...
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
  const form3Task = nonstarter.tasks.find(
    (task: any) => task.task_type_code === "NONSTARTER_FORM3"
  );
  const document = currentForm3(caseData.documents);

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">
              Complete Form-3
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Non-starter report for {c.pim_number || c.received_number || "-"}.
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
          <Info
            label="Opposite party"
            value={
              nonstarter.context?.party?.name ||
              caseData.parties.find((p: any) => p.role === "OPPOSITE_PARTY")?.name ||
              "-"
            }
          />
          <Info label="Non-starter reason" value={outcome?.nonstarter_reason_name || outcome?.reason_text || "-"} />
          <Info label="Authority decision" value={outcome?.requires_authority_decision ? "Required" : "Not required"} />
          <Info label="Form-3 task" value={form3Task ? form3Task.status : "Not found"} />
          <Info label="Outcome date" value={formatDate(outcome?.outcome_date || null)} />
        </section>

        {!outcome && (
          <section className="rounded-lg border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Record Non-Starter</h2>

            {nonstarter.context?.evidence ? (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-medium">Why this case reached Non-Starter</p>
                <p className="mt-1">{nonstarter.context.evidence}</p>
                {nonstarter.context.notice && (
                  <p className="mt-1">
                    Notice type:{" "}
                    {nonstarter.context.notice.notice_type === "FORM_2_FINAL"
                      ? "Final Notice"
                      : "Initial Notice"}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-gray-500">
                No automatic case-fact trigger was found. Only the
                manually-invoked reasons (mediation fee not
                submitted / both parties not willing) apply here.
              </p>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium uppercase text-gray-500">
                  Non-starter reason
                </span>
                <select
                  value={selectedReasonId}
                  onChange={(event) => setSelectedReasonId(event.target.value)}
                  className="mt-1 w-full rounded border px-3 py-2 text-sm"
                >
                  <option value="">Select a reason</option>
                  {nonstarter.nonstarterReasons
                    .filter((r: any) =>
                      nonstarter.context?.reasonCode
                        ? r.code === nonstarter.context.reasonCode
                        : true
                    )
                    .map((r: any) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase text-gray-500">
                  Remarks
                </span>
                <input
                  value={remarks}
                  onChange={(event) => setRemarks(event.target.value)}
                  className="mt-1 w-full rounded border px-3 py-2 text-sm"
                />
              </label>
            </div>

            <div className="mt-4">
              <button
                type="button"
                onClick={recordNonStarter}
                disabled={!canRecord || saving || !selectedReasonId}
                className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                Record Non-Starter
              </button>
            </div>
          </section>
        )}

        {outcome && (
        <>
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
              No current Form-3 document exists.
            </p>
          )}
        </section>

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Actions</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium uppercase text-gray-500">
                Rule reference
              </span>
              <select
                value={ruleReference}
                onChange={(event) => setRuleReference(event.target.value)}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              >
                <option value="3(4)">3(4)</option>
                <option value="3(6)">3(6)</option>
              </select>
            </label>
            <label className="block md:col-span-2">
              <span className="text-xs font-medium uppercase text-gray-500">
                Remarks
              </span>
              <input
                value={remarks}
                onChange={(event) => setRemarks(event.target.value)}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => generate(false)}
              disabled={!canGenerate || saving || Boolean(document)}
              className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Generate Form-3
            </button>
            <button
              type="button"
              onClick={() => generate(true)}
              disabled={!canGenerate || saving || !document}
              className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              Regenerate Form-3
            </button>
            <button
              type="button"
              onClick={complete}
              disabled={!canComplete || saving || !document || form3Task?.status !== "PENDING"}
              className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              Complete Form-3
            </button>
          </div>
        </section>
        </>
        )}
      </div>
    </main>
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
