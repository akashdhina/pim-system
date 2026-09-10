"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Stage = {
  code: string;
  label: string;
  currentStatus: string;
  pendingTask: string | null;
  requiredDates: string[];
  requiresMediator?: boolean;
  outcomeType?: string;
};

type Mediator = {
  id: number;
  name: string;
  category: string;
  enrollment_no: string | null;
  rotation_order: number | null;
};

type NonstarterReason = {
  id: number;
  code: string;
  name: string;
  rule_reference: string | null;
  requires_authority_decision: number | boolean;
};

type Party = {
  name: string;
  entityType: string;
  phone: string;
  email: string;
  addressLine1: string;
  addressLine2: string;
  villageTown: string;
  district: string;
  state: string;
  pincode: string;
};

type ImportResult = {
  caseId: number;
  currentStatus: string;
  pendingTask: string | null;
};

type ImportPreview = {
  pimNumber: string | null;
  receivedNumber: string | null;
  stage: string;
  stageLabel: string;
  currentStatus: string;
  pendingTask: string | null;
  claimAmount: number | null;
  applicants: string[];
  oppositeParties: string[];
  dates: Record<string, string>;
  mediator: { id: number; name: string; enrollmentNo: string | null } | null;
  outcomeType: string | null;
  nonstarterReason: { id: number; name: string; ruleReference: string | null } | null;
  settlementTerms: string | null;
  formNo: string | null;
  warnings: string[];
};

const blankParty: Party = {
  name: "",
  entityType: "INDIVIDUAL",
  phone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  villageTown: "",
  district: "",
  state: "Tamil Nadu",
  pincode: "",
};

const dateLabels: Record<string, string> = {
  applicationDate: "Application date",
  receivedDate: "Received date",
  scrutinyDate: "Scrutiny completed date",
  registrationDate: "Registration date",
  form2Date: "Form-2 issued date",
  appearanceDate: "Appearance date",
  responseDate: "OP consent date",
  assignmentDate: "Mediator assignment date",
  firstMediationDate: "First mediation date",
  lastSessionDate: "Last completed sitting date",
  nextMediationDate: "Next sitting date",
  form3Date: "Form-3 date",
  outcomeDate: "Outcome / closure date",
};

function emptyForm() {
  return {
    stageCode: "RECEIVED",
    pimNumber: "",
    receivedNumber: "",
    receivedDate: "",
    applicationDate: "",
    scrutinyDate: "",
    registrationDate: "",
    form2Date: "",
    appearanceDate: "",
    appearanceTime: "",
    responseDate: "",
    assignmentDate: "",
    firstMediationDate: "",
    lastSessionDate: "",
    nextMediationDate: "",
    form3Date: "",
    outcomeDate: "",
    claimAmount: "",
    disputeDescription: "",
    applicationFeeDdNumber: "",
    applicationFeeDdDate: "",
    applicationFeeBank: "",
    applicationFeeAmount: "",
    mediatorId: "",
    assignmentOrderNo: "",
    outcomeReason: "",
    nonstarterReasonId: "",
    settlementTerms: "",
    formNo: "",
    statutoryDueDate: "",
    internal60DayDate: "",
    priority: "NORMAL",
    remarks: "",
    dispatchMode: "REGISTERED_POST",
    trackingNo: "",
    applicants: [{ ...blankParty }],
    oppositeParties: [{ ...blankParty }],
  };
}

export default function LegacyImportPage() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [mediators, setMediators] = useState<Mediator[]>([]);
  const [nonstarterReasons, setNonstarterReasons] =
    useState<NonstarterReason[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] =
    useState<ImportResult | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  useEffect(() => {
    fetch("/api/pim/import", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Unable to load import wizard.");
        }
        return json.data;
      })
      .then((data) => {
        setStages(data.stages || []);
        setMediators(data.mediators || []);
        setNonstarterReasons(data.nonstarterReasons || []);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load import wizard.")
      )
      .finally(() => setLoading(false));
  }, []);

  const stage = useMemo(
    () => stages.find((item) => item.code === form.stageCode),
    [stages, form.stageCode]
  );

  const selectedNonstarterReason = useMemo(
    () =>
      nonstarterReasons.find(
        (reason) =>
          String(reason.id) === String(form.nonstarterReasonId)
      ) || null,
    [nonstarterReasons, form.nonstarterReasonId]
  );

  function update(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateParty(group: "applicants" | "oppositeParties", index: number, key: keyof Party, value: string) {
    setForm((current) => ({
      ...current,
      [group]: current[group].map((party, partyIndex) =>
        partyIndex === index ? { ...party, [key]: value } : party
      ),
    }));
  }

  function addParty(group: "applicants" | "oppositeParties") {
    setForm((current) => ({
      ...current,
      [group]: [...current[group], { ...blankParty }],
    }));
  }

  function removeParty(group: "applicants" | "oppositeParties", index: number) {
    setForm((current) => ({
      ...current,
      [group]: current[group].filter((_, partyIndex) => partyIndex !== index),
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreviewing(true);
    setError("");
    setResult(null);
    setPreview(null);

    try {
      const response = await fetch("/api/pim/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, preview: true }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to preview legacy case.");
      }
      setPreview(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to preview legacy case.");
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmImport() {
    setSaving(true);
    setError("");

    try {
      const response = await fetch("/api/pim/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to import legacy case.");
      }
      setResult(json.data);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to import legacy case.");
    } finally {
      setSaving(false);
    }
  }

  function backToEdit() {
    setPreview(null);
    setError("");
  }

  if (loading) {
    return <main className="p-6"><div className="rounded-lg border bg-white p-6">Loading legacy import...</div></main>;
  }

  return (
    <main className="min-h-screen bg-gray-50 p-4 md:p-6">
      <form onSubmit={submit} className="mx-auto max-w-6xl space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-950">Legacy Case Import</h1>
          <p className="mt-1 text-sm text-gray-600">
            Reconstruct the current workflow from the physical file without changing audit timestamps.
          </p>
        </div>

        {error && <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
        {result && (
          <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            Imported successfully. Status: {result.currentStatus}. Pending task: {result.pendingTask || "None"}.{" "}
            <Link className="font-medium underline" href={`/pim/case/${result.caseId}`}>Open case</Link>
          </div>
        )}

        {preview && (
          <Section title="Review Before Import (nothing has been saved yet)">
            <div className="space-y-4">
              {preview.warnings.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                  <div className="mb-1 font-semibold">Warnings</div>
                  <ul className="list-inside list-disc space-y-1">
                    {preview.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-3">
                <Info label="PIM number (assigned on import)" value={preview.pimNumber || "Not assigned at this stage"} />
                <Info label="Received number" value={preview.receivedNumber || "-"} />
                <Info label="Current status" value={preview.currentStatus} />
                <Info label="Pending task" value={preview.pendingTask || "None"} />
                <Info label="Claim amount" value={preview.claimAmount != null ? String(preview.claimAmount) : "-"} />
                <Info label="Applicant(s)" value={preview.applicants.filter(Boolean).join("; ") || "-"} />
                <Info label="Opposite party(ies)" value={preview.oppositeParties.filter(Boolean).join("; ") || "-"} />
                {preview.mediator && <Info label="Mediator" value={preview.mediator.name} />}
                {preview.outcomeType && <Info label="Outcome" value={preview.outcomeType} />}
                {preview.nonstarterReason && <Info label="Non-starter reason" value={preview.nonstarterReason.name} />}
                {preview.settlementTerms && <Info label="Settlement terms" value={preview.settlementTerms} />}
                {preview.formNo && <Info label="Form number" value={preview.formNo} />}
              </div>
              <div>
                <div className="mb-1 text-sm font-medium text-gray-700">Dates</div>
                <div className="grid gap-2 rounded border bg-gray-50 p-3 text-sm md:grid-cols-3">
                  {Object.entries(preview.dates).map(([key, value]) => (
                    <div key={key}>
                      {dateLabels[key] || key}: <span className="font-medium">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={confirmImport}
                  disabled={saving}
                  className="rounded bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Importing..." : "Confirm & Import"}
                </button>
                <button type="button" onClick={backToEdit} className="rounded border bg-white px-5 py-2 text-sm font-medium">
                  Back to Edit
                </button>
              </div>
            </div>
          </Section>
        )}

        <Section title="Current Physical-File Stage">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Stage">
              <select
                value={form.stageCode}
                onChange={(event) => update("stageCode", event.target.value)}
                className="w-full rounded border px-3 py-2"
              >
                {stages.map((item) => (
                  <option key={item.code} value={item.code}>{item.label}</option>
                ))}
              </select>
            </Field>
            <Info label="Current status" value={stage?.currentStatus || "-"} />
            <Info label="Pending task created" value={stage?.pendingTask || "No pending task"} />
          </div>
        </Section>

        <Section title="Case Details">
          <div className="grid gap-4 md:grid-cols-3">
            <Input label="Received number" value={form.receivedNumber} onChange={(value) => update("receivedNumber", value)} />
            <Input label="PIM number" value={form.pimNumber} onChange={(value) => update("pimNumber", value)} />
            <Input label="Claim amount" value={form.claimAmount} onChange={(value) => update("claimAmount", value)} type="number" />
            <Field label="Priority">
              <select value={form.priority} onChange={(event) => update("priority", event.target.value)} className="w-full rounded border px-3 py-2">
                <option value="NORMAL">Normal</option>
                <option value="URGENT">Urgent</option>
              </select>
            </Field>
            <Field label="Dispute description">
              <textarea value={form.disputeDescription} onChange={(event) => update("disputeDescription", event.target.value)} className="min-h-24 w-full rounded border px-3 py-2" />
            </Field>
            <Field label="Remarks">
              <textarea value={form.remarks} onChange={(event) => update("remarks", event.target.value)} className="min-h-24 w-full rounded border px-3 py-2" />
            </Field>
          </div>
        </Section>

        <Section title="Historical Dates">
          <div className="grid gap-4 md:grid-cols-3">
            {Object.entries(dateLabels)
              .filter(([key]) => key === "applicationDate" || key === "receivedDate" || stage?.requiredDates.includes(key))
              .map(([key, label]) => (
                <Input
                  key={key}
                  label={`${label}${stage?.requiredDates.includes(key) ? " *" : ""}`}
                  value={form[key as keyof typeof form] as string}
                  onChange={(value) => update(key, value)}
                  type="date"
                />
              ))}
            <Input label="Appearance time" value={form.appearanceTime} onChange={(value) => update("appearanceTime", value)} type="time" />
          </div>
        </Section>

        {stage?.requiredDates.includes("form2Date") && (
          <Section title="Form-2 / Service">
            <div className="grid gap-4 md:grid-cols-3">
              <Input label="Dispatch mode" value={form.dispatchMode} onChange={(value) => update("dispatchMode", value)} />
              <Input label="Tracking number" value={form.trackingNo} onChange={(value) => update("trackingNo", value)} />
              <Input label="Application fee DD number" value={form.applicationFeeDdNumber} onChange={(value) => update("applicationFeeDdNumber", value)} />
              <Input label="Application fee DD date" value={form.applicationFeeDdDate} onChange={(value) => update("applicationFeeDdDate", value)} type="date" />
              <Input label="Application fee bank" value={form.applicationFeeBank} onChange={(value) => update("applicationFeeBank", value)} />
              <Input label="Application fee amount" value={form.applicationFeeAmount} onChange={(value) => update("applicationFeeAmount", value)} type="number" />
            </div>
          </Section>
        )}

        {stage?.requiresMediator && (
          <Section title="Mediator">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Mediator *">
                <select value={form.mediatorId} onChange={(event) => update("mediatorId", event.target.value)} className="w-full rounded border px-3 py-2">
                  <option value="">Select mediator</option>
                  {mediators.map((mediator) => (
                    <option key={mediator.id} value={mediator.id}>
                      {mediator.name} {mediator.enrollment_no ? `/${mediator.enrollment_no}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Input label="Assignment order number" value={form.assignmentOrderNo} onChange={(value) => update("assignmentOrderNo", value)} />
            </div>
          </Section>
        )}

        {stage?.outcomeType && (
          <Section title="Outcome">
            <div className="grid gap-4 md:grid-cols-3">
              <Info label="Outcome type" value={stage.outcomeType} />

              <Input
                label="Form number"
                value={form.formNo}
                onChange={(value) => update("formNo", value)}
              />

              {stage.outcomeType === "NON_STARTER" ? (
                <>
                  <Field label="Non-starter reason *">
                    <select
                      value={form.nonstarterReasonId}
                      onChange={(event) =>
                        update("nonstarterReasonId", event.target.value)
                      }
                      className="w-full rounded border px-3 py-2"
                    >
                      <option value="">Select reason</option>
                      {nonstarterReasons.map((reason) => (
                        <option key={reason.id} value={reason.id}>
                          {reason.name}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Info
                    label="Rule reference"
                    value={selectedNonstarterReason?.rule_reference || "-"}
                  />

                  <Info
                    label="Authority decision required"
                    value={
                      selectedNonstarterReason
                        ? selectedNonstarterReason.requires_authority_decision
                          ? "Yes"
                          : "No"
                        : "-"
                    }
                  />

                  <Field label="Additional outcome remarks">
                    <textarea
                      value={form.outcomeReason}
                      onChange={(event) =>
                        update("outcomeReason", event.target.value)
                      }
                      className="min-h-24 w-full rounded border px-3 py-2"
                    />
                  </Field>
                </>
              ) : (
                <Field label="Outcome reason">
                  <textarea
                    value={form.outcomeReason}
                    onChange={(event) =>
                      update("outcomeReason", event.target.value)
                    }
                    className="min-h-24 w-full rounded border px-3 py-2"
                  />
                </Field>
              )}

              {stage.outcomeType === "SETTLED" && (
                <Field label="Settlement terms">
                  <textarea
                    value={form.settlementTerms}
                    onChange={(event) =>
                      update("settlementTerms", event.target.value)
                    }
                    className="min-h-24 w-full rounded border px-3 py-2"
                  />
                </Field>
              )}
            </div>
          </Section>
        )}

        <PartySection title="Applicants" group="applicants" parties={form.applicants} updateParty={updateParty} addParty={addParty} removeParty={removeParty} />
        <PartySection title="Opposite Parties" group="oppositeParties" parties={form.oppositeParties} updateParty={updateParty} addParty={addParty} removeParty={removeParty} />

        <div className="flex gap-3">
          <button type="submit" disabled={previewing || Boolean(preview)} className="rounded bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
            {previewing ? "Checking..." : "Review Before Import"}
          </button>
          <Link href="/pim" className="rounded border bg-white px-5 py-2 text-sm font-medium">Dashboard</Link>
        </div>
      </form>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-lg border bg-white p-5 shadow-sm"><h2 className="mb-4 border-b pb-3 text-lg font-semibold">{title}</h2>{children}</section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block font-medium text-gray-700">{label}</span>{children}</label>;
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <Field label={label}><input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded border px-3 py-2" /></Field>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-sm font-medium text-gray-700">{label}</div><div className="mt-1 rounded border bg-gray-50 px-3 py-2 text-sm">{value}</div></div>;
}

function PartySection({
  title,
  group,
  parties,
  updateParty,
  addParty,
  removeParty,
}: {
  title: string;
  group: "applicants" | "oppositeParties";
  parties: Party[];
  updateParty: (group: "applicants" | "oppositeParties", index: number, key: keyof Party, value: string) => void;
  addParty: (group: "applicants" | "oppositeParties") => void;
  removeParty: (group: "applicants" | "oppositeParties", index: number) => void;
}) {
  return (
    <Section title={title}>
      <div className="space-y-4">
        {parties.map((party, index) => (
          <div key={index} className="rounded border p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-medium">{title.slice(0, -1)} {index + 1}</div>
              {parties.length > 1 && (
                <button type="button" onClick={() => removeParty(group, index)} className="rounded border px-3 py-1 text-xs">Remove</button>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {(Object.keys(blankParty) as (keyof Party)[]).map((key) => {
                const labels: Record<keyof Party, string> = {
                  name: "Name *",
                  entityType: "Entity type",
                  phone: "Phone",
                  email: "Email",
                  addressLine1: "Address line 1",
                  addressLine2: "Address line 2",
                  villageTown: "Village / Town",
                  district: "District",
                  state: "State",
                  pincode: "PIN code",
                };

                return (
                  <Input
                    key={key}
                    label={labels[key]}
                    value={party[key]}
                    onChange={(value) =>
                      updateParty(group, index, key, value)
                    }
                  />
                );
              })}
            </div>
          </div>
        ))}
        <button type="button" onClick={() => addParty(group)} className="rounded border px-4 py-2 text-sm font-medium">Add {title.slice(0, -1)}</button>
      </div>
    </Section>
  );
}