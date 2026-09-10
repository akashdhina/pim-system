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

type Fee = {
  id: number;
  party_name: string | null;
  party_role: string | null;
  amount_due: number | null;
  amount_received: number | null;
  dd_number: string | null;
  dd_date: string | null;
  bank_name: string | null;
  payee: string | null;
  received_date: string | null;
  deposited_date: string | null;
  status: string;
  remarks: string | null;
};

type FeeSchedule = {
  totalFee: number | null;
  shareAmount: number | null;
  applicantShare: number | null;
  oppositePartyShare: number | null;
};

type PageData = {
  case: CaseData;
  fee: Fee | null;
  fees: Fee[];
  feeSchedule: FeeSchedule;
};

type Side = "applicant" | "oppositeParty";

type SideForm = {
  amountReceived: string;
  ddNumber: string;
  ddDate: string;
  bankName: string;
  payee: string;
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptySideForm(): SideForm {
  return {
    amountReceived: "",
    ddNumber: "",
    ddDate: today(),
    bankName: "",
    payee: "Chairman, DLSA",
  };
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
  const [receivedDate, setReceivedDate] = useState(today());
  const [depositedDate, setDepositedDate] = useState("");
  const [remarks, setRemarks] = useState("");

  useEffect(() => {
    loadData();
  }, [id]);

  function updateSide(side: Side, field: keyof SideForm, value: string) {
    const setter = side === "applicant" ? setApplicant : setOppositeParty;
    setter((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function fillFromFee(fee: Fee | null, shareAmount: number | null): SideForm {
    return {
      amountReceived:
        fee?.amount_received && fee.amount_received > 0
          ? String(fee.amount_received)
          : shareAmount == null
            ? ""
            : String(shareAmount),
      ddNumber: fee?.dd_number || "",
      ddDate: fee?.dd_date || today(),
      bankName: fee?.bank_name || "",
      payee: fee?.payee || "Chairman, DLSA",
    };
  }

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`/api/pim/fee/${id}`, {
        cache: "no-store",
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to load fee data.");
      }

      const pageData = json.data as PageData;
      setData(pageData);

      // There is exactly one case-level MEDIATION_FEE row now
      // (Phase 6.1) - it is linked to whichever side's payment
      // first created it, not to both sides at once. Pre-fill
      // whichever side matches; leave the other blank for fresh
      // entry rather than guessing.
      const feeRow = pageData.fee;
      const applicantFee = feeRow?.party_role === "APPLICANT" ? feeRow : null;
      const oppositeFee = feeRow?.party_role === "OPPOSITE_PARTY" ? feeRow : null;
      const shareAmount = pageData.feeSchedule.shareAmount;

      setApplicant(fillFromFee(applicantFee, shareAmount));
      setOppositeParty(fillFromFee(oppositeFee, shareAmount));
      setReceivedDate(feeRow?.received_date || today());
      setDepositedDate(feeRow?.deposited_date || "");
      setRemarks("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load fee data.");
    } finally {
      setLoading(false);
    }
  }

  function validateSide(label: string, form: SideForm, shareAmount: number | null) {
    if (shareAmount == null) return "Mediation fee could not be calculated for this claim amount.";
    if (!Number.isFinite(Number(form.amountReceived)) || Number(form.amountReceived) <= 0) {
      return `${label} amount received must be greater than zero.`;
    }
    if (!form.ddNumber.trim()) return `${label} DD number is required.`;
    if (!form.ddDate) return `${label} DD date is required.`;
    if (!form.bankName.trim()) return `${label} bank name is required.`;
    if (form.payee.trim() !== "Chairman, DLSA") return `${label} DD must be drawn in favour of Chairman, DLSA.`;
    return null;
  }

  async function saveFee() {
    if (saving || !data) return;

    setError("");
    setSuccess("");

    const shareAmount = data.feeSchedule.shareAmount;
    const applicantError = validateSide("Applicant", applicant, shareAmount);
    if (applicantError) {
      setError(applicantError);
      return;
    }

    const oppositeError = validateSide("Opposite party", oppositeParty, shareAmount);
    if (oppositeError) {
      setError(oppositeError);
      return;
    }

    if (!receivedDate) {
      setError("Received date is required.");
      return;
    }

    if (!confirm("Record mediation fee receipt from both sides?")) return;

    try {
      setSaving(true);

      const response = await fetch(`/api/pim/fee/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicantAmountReceived: Number(applicant.amountReceived),
          applicantDdNumber: applicant.ddNumber.trim(),
          applicantDdDate: applicant.ddDate,
          applicantBankName: applicant.bankName.trim(),
          applicantPayee: applicant.payee.trim(),
          oppositePartyAmountReceived: Number(oppositeParty.amountReceived),
          oppositePartyDdNumber: oppositeParty.ddNumber.trim(),
          oppositePartyDdDate: oppositeParty.ddDate,
          oppositePartyBankName: oppositeParty.bankName.trim(),
          oppositePartyPayee: oppositeParty.payee.trim(),
          receivedDate,
          depositedDate: depositedDate || null,
          remarks: remarks.trim() || null,
        }),
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to record mediation fee.");
      }

      setSuccess(json.message || "Mediation fee recorded.");
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
  // One case-level MEDIATION_FEE row (Phase 6.1): "received" means
  // that single row's cumulative amount_received has cleared the
  // full statutory amount_due.
  const feeReceived = data.fee?.status === "RECEIVED";

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
          <h2 className="mb-5 text-lg font-semibold">Schedule II Calculation</h2>
          <div className="grid gap-5 md:grid-cols-4">
            <Info label="Claim Amount" value={money(data.case.claim_amount)} />
            <Info label="Total Mediation Fee" value={money(data.feeSchedule.totalFee)} />
            <Info label="Applicant Share" value={money(data.feeSchedule.applicantShare)} />
            <Info label="Opposite Party Share" value={money(data.feeSchedule.oppositePartyShare)} />
          </div>
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Fee Receipt</h2>

          {feeReceived ? (
            <div className="space-y-5">
              <div className="rounded border border-green-300 bg-green-50 p-4 text-sm text-green-800">Mediation fee has been received in full.</div>
              <FeeSummary title="Mediation Fee (Case-Level)" fee={data.fee} />
              <a href={`/pim/mediator/${id}`} className="inline-flex rounded bg-black px-5 py-3 text-sm font-medium text-white">Assign Mediator</a>
            </div>
          ) : !canCollect ? (
            <div className="rounded border bg-gray-50 p-4 text-sm text-gray-700">This case is not currently available for mediation fee collection.</div>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-6 md:grid-cols-2">
                <SideCard title="Applicant" form={applicant} shareAmount={data.feeSchedule.applicantShare} onChange={(field, value) => updateSide("applicant", field, value)} />
                <SideCard title="Opposite Party" form={oppositeParty} shareAmount={data.feeSchedule.oppositePartyShare} onChange={(field, value) => updateSide("oppositeParty", field, value)} />
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <Field label="Received Date" value={receivedDate} onChange={setReceivedDate} type="date" />
                <Field label="Deposited Date" value={depositedDate} onChange={setDepositedDate} type="date" />
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
      </div>
    </main>
  );
}

function FeeSummary({ title, fee }: { title: string; fee: Fee | null }) {
  return (
    <div className="rounded border p-5">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Info label="Amount Due" value={money(fee?.amount_due)} />
        <Info label="Amount Received" value={money(fee?.amount_received)} />
        <Info label="Latest DD Number" value={fee?.dd_number || "-"} />
        <Info label="Latest DD Date" value={formatDate(fee?.dd_date || null)} />
      </div>
      {fee?.remarks && (
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Payment History</div>
          <pre className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{fee.remarks}</pre>
        </div>
      )}
    </div>
  );
}

function SideCard({ title, form, shareAmount, onChange }: { title: string; form: SideForm; shareAmount: number | null; onChange: (field: keyof SideForm, value: string) => void }) {
  return <div className="rounded border p-5"><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-gray-600">Required share: {money(shareAmount)}</p><div className="mt-5 space-y-4"><Field label="Amount Received" value={form.amountReceived} onChange={(value) => onChange("amountReceived", value)} type="number" /><Field label="DD Number" value={form.ddNumber} onChange={(value) => onChange("ddNumber", value)} /><Field label="DD Date" value={form.ddDate} onChange={(value) => onChange("ddDate", value)} type="date" /><Field label="Bank Name" value={form.bankName} onChange={(value) => onChange("bankName", value)} /><Field label="Payee" value={form.payee} onChange={(value) => onChange("payee", value)} /></div></div>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div><div className="mt-1 text-sm font-medium text-gray-900">{value}</div></div>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <div><label className="block text-sm font-medium text-gray-700">{label}</label><input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded border p-3 text-sm" /></div>;
}
