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

type FeeSummary = {
  totalFee: number | null;
  shareAmount: number | null;
  applicantPaid: number;
  applicantOutstanding: number | null;
  applicantOverpaid: number;
  opSidePaid: number;
  opSideOutstanding: number | null;
  opSideOverpaid: number;
  totalPaid: number;
  totalOutstanding: number | null;
  fullyPaid: boolean;
};

type Payment = {
  id: number;
  paying_side: "APPLICANT" | "OP_SIDE";
  amount: number;
  payment_date: string;
  payment_mode: string;
  dd_number: string | null;
  dd_date: string | null;
  bank_name: string | null;
  reference_number: string | null;
  remarks: string | null;
  created_at: string;
};

type PageData = {
  case: CaseData;
  summary: FeeSummary;
  payments: Payment[];
};

type Side = "APPLICANT" | "OP_SIDE";

type SideForm = {
  amount: string;
  ddNumber: string;
  ddDate: string;
  bankName: string;
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptySideForm(): SideForm {
  return { amount: "", ddNumber: "", ddDate: today(), bankName: "" };
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
  if (status === "FEE_PENDING") return "bg-yellow-100 text-yellow-800";
  if (status === "MEDIATOR_ASSIGNMENT_PENDING") return "bg-blue-100 text-blue-800";
  return "bg-gray-100 text-gray-800";
}

export default function FeePage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [applicant, setApplicant] = useState<SideForm>(emptySideForm());
  const [oppositeParty, setOppositeParty] = useState<SideForm>(emptySideForm());
  const [remarks, setRemarks] = useState("");

  useEffect(() => {
    loadData();
  }, [id]);

  function updateSide(side: Side, field: keyof SideForm, value: string) {
    const setter = side === "APPLICANT" ? setApplicant : setOppositeParty;
    setter((current) => ({ ...current, [field]: value }));
  }

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`/api/pim/fee/${id}`, { cache: "no-store" });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to load fee data.");
      }

      setData(json.data as PageData);
      setApplicant(emptySideForm());
      setOppositeParty(emptySideForm());
      setRemarks("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load fee data.");
    } finally {
      setLoading(false);
    }
  }

  function validateSide(label: string, form: SideForm): string | null {
    const hasAnyInput = form.amount || form.ddNumber || form.bankName;
    if (!hasAnyInput) return null; // this side simply isn't part of this submission
    if (!Number.isFinite(Number(form.amount)) || Number(form.amount) <= 0) {
      return `${label} amount must be greater than zero.`;
    }
    if (!form.ddNumber.trim()) return `${label} DD number is required.`;
    if (!form.ddDate) return `${label} DD date is required.`;
    if (!form.bankName.trim()) return `${label} bank name is required.`;
    return null;
  }

  async function postPayment(payingSide: Side, form: SideForm) {
    const response = await fetch(`/api/pim/fee/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payingSide,
        amount: Number(form.amount),
        ddNumber: form.ddNumber.trim(),
        ddDate: form.ddDate,
        bankName: form.bankName.trim(),
        remarks: remarks.trim() || null,
      }),
    });
    const json = await response.json();
    if (!response.ok || !json.success) {
      throw new Error(json.message || "Unable to record mediation fee.");
    }
    return json;
  }

  async function saveFee() {
    if (saving || !data) return;

    setError("");
    setSuccess("");

    const applicantError = validateSide("Applicant", applicant);
    if (applicantError) return setError(applicantError);

    const oppositeError = validateSide("Opposite party side", oppositeParty);
    if (oppositeError) return setError(oppositeError);

    const applicantEntered = Boolean(applicant.amount);
    const oppositeEntered = Boolean(oppositeParty.amount);

    if (!applicantEntered && !oppositeEntered) {
      return setError("Enter at least one side's payment.");
    }

    if (!confirm("Record this mediation fee payment?")) return;

    try {
      setSaving(true);

      let lastResult = null;
      if (applicantEntered) lastResult = await postPayment("APPLICANT", applicant);
      if (oppositeEntered) lastResult = await postPayment("OP_SIDE", oppositeParty);

      setSuccess(lastResult?.message || "Mediation fee recorded.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to record mediation fee.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-100 p-6"><div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">Loading fee...</div></main>;
  }

  if (error && !data) {
    return <main className="min-h-screen bg-gray-100 p-6"><div className="mx-auto max-w-6xl rounded-lg border border-red-300 bg-red-50 p-6 text-red-800">{error}</div></main>;
  }

  if (!data) return null;

  const canCollect = data.case.status_code === "FEE_PENDING";
  const summary = data.summary;

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <div className="text-sm text-gray-500">PIM Mediation Fee</div>
              <h1 className="mt-1 text-2xl font-bold">{data.case.pim_number || "PIM Number Not Assigned"}</h1>
              <p className="mt-1 text-sm text-gray-600">Received Number: {data.case.received_number || "-"}</p>
            </div>
            <span className={`rounded-full px-4 py-2 text-sm font-semibold ${statusClass(data.case.status_code)}`}>{data.case.status_name}</span>
          </div>

          {error && <div className="mt-5 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
          {success && <div className="mt-5 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-800">{success}</div>}
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Fee Summary</h2>
          <div className="grid gap-5 md:grid-cols-3">
            <Info label="Claim Amount" value={money(data.case.claim_amount)} />
            <Info label="Total Mediation Fee" value={money(summary.totalFee)} />
            <Info label="Required Share (each side)" value={money(summary.shareAmount)} />
          </div>
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <SideSummary title="Applicant" paid={summary.applicantPaid} outstanding={summary.applicantOutstanding} overpaid={summary.applicantOverpaid} />
            <SideSummary title="Opposite Party Side" paid={summary.opSidePaid} outstanding={summary.opSideOutstanding} overpaid={summary.opSideOverpaid} />
          </div>
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Fee Receipt</h2>

          {summary.fullyPaid ? (
            <div className="space-y-5">
              <div className="rounded border border-green-300 bg-green-50 p-4 text-sm text-green-800">Mediation fee has been received in full from both sides.</div>
              <a href={`/pim/mediator/${id}`} className="inline-flex rounded bg-black px-5 py-3 text-sm font-medium text-white">Assign Mediator</a>
            </div>
          ) : !canCollect ? (
            <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">This case is not currently available for mediation fee collection.</div>
          ) : (
            <div className="space-y-6">
              <p className="text-sm text-gray-600">Enter either or both sides' payment below. Each side is recorded as its own immutable payment entry.</p>
              <div className="grid gap-6 md:grid-cols-2">
                <SideCard title="Applicant" outstanding={summary.applicantOutstanding} form={applicant} onChange={(field, value) => updateSide("APPLICANT", field, value)} />
                <SideCard title="Opposite Party Side" outstanding={summary.opSideOutstanding} form={oppositeParty} onChange={(field, value) => updateSide("OP_SIDE", field, value)} />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Remarks</label>
                <textarea rows={3} value={remarks} onChange={(event) => setRemarks(event.target.value)} className="mt-2 w-full rounded border p-3 text-sm" />
              </div>

              <div className="flex justify-end">
                <button type="button" onClick={saveFee} disabled={saving} className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50">{saving ? "Saving..." : "Record Mediation Fee"}</button>
              </div>
            </div>
          )}
        </section>

        {data.payments.length > 0 && (
          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-5 text-lg font-semibold">Payment History</h2>
            <div className="space-y-3">
              {data.payments.map((payment) => (
                <div key={payment.id} className="rounded border p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="font-semibold">{payment.paying_side === "APPLICANT" ? "Applicant" : "Opposite Party Side"}</span>
                    <span>{money(payment.amount)}</span>
                  </div>
                  <div className="mt-1 text-xs text-gray-600">
                    {formatDate(payment.payment_date)} · {payment.payment_mode}
                    {payment.dd_number ? ` · DD ${payment.dd_number}${payment.dd_date ? ` dated ${formatDate(payment.dd_date)}` : ""}` : ""}
                    {payment.bank_name ? ` · ${payment.bank_name}` : ""}
                  </div>
                  {payment.remarks && <div className="mt-1 text-xs text-gray-600">{payment.remarks}</div>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function SideSummary({ title, paid, outstanding, overpaid }: { title: string; paid: number; outstanding: number | null; overpaid: number }) {
  return (
    <div className="rounded border p-5">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Info label="Paid" value={money(paid)} />
        <Info label="Outstanding" value={outstanding === 0 ? "Fully paid" : money(outstanding)} />
      </div>
      {overpaid > 0 && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">Overpaid by {money(overpaid)}. Please verify.</div>
      )}
    </div>
  );
}

function SideCard({ title, outstanding, form, onChange }: { title: string; outstanding: number | null; form: SideForm; onChange: (field: keyof SideForm, value: string) => void }) {
  return (
    <div className="rounded border p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-gray-600">Outstanding: {outstanding === 0 ? "Fully paid" : money(outstanding)}</p>
      <div className="mt-5 space-y-4">
        <Field label="Amount" value={form.amount} onChange={(value) => onChange("amount", value)} type="number" />
        <Field label="DD Number" value={form.ddNumber} onChange={(value) => onChange("ddNumber", value)} />
        <Field label="DD Date" value={form.ddDate} onChange={(value) => onChange("ddDate", value)} type="date" />
        <Field label="Bank Name" value={form.bankName} onChange={(value) => onChange("bankName", value)} />
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div><div className="mt-1 text-sm font-medium text-gray-900">{value}</div></div>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <div><label className="block text-sm font-medium text-gray-700">{label}</label><input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded border p-3 text-sm" /></div>;
}
