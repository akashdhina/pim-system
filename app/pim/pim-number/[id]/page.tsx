"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type CaseData = {
  id: number;
  pim_number: string | null;
  received_number: string | null;
  received_date: string;
  application_date: string;
  registration_date: string | null;
  claim_amount: number | null;
  dispute_description: string | null;
  current_status_id: number;
  status_code: string;
  status_name: string;
  scrutiny_status: string | null;
  internal_60_day_date: string | null;
  statutory_due_date: string | null;
};

type Party = {
  party_id: number;
  role: string;
  sequence_no: number;
  is_primary: number;
  name: string;
  entity_type: string;
  addresses: Address[];
  advocates: Advocate[];
};

type Address = {
  id: number;
  address_type: string;
  address_line1: string;
  address_line2: string | null;
  village_town: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
};

type Advocate = {
  id: number;
  advocate_name: string;
  enrollment_no: string | null;
  phone: string | null;
};

type DocketEntry = {
  id: number;
  docket_date: string;
  entry_text: string;
  event_name: string;
  action_required: string | null;
};

type Scrutiny = {
  scrutiny_result: string | null;
  defect_details: string | null;
  scrutinised_at: string | null;
};

type ApiData = {
  case: CaseData;
  parties: Party[];
  docket: DocketEntry[];
  scrutiny: Scrutiny | null;
};

type LastRegistered = {
  year: number;
  lastRunningNumber: number | null;
};

export default function AssignPimNumberPage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<ApiData | null>(null);
  const [lastRegistered, setLastRegistered] = useState<LastRegistered | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [assigned, setAssigned] = useState(false);
  const [runningNumber, setRunningNumber] = useState("");
  const [year, setYear] = useState(() => new Date().getFullYear());

  useEffect(() => {
    async function loadCase() {
      try {
        setLoading(true);
        setError("");

        const [caseRes, lastRegisteredRes] = await Promise.all([
          fetch(`/api/pim/scrutiny/${id}`, { cache: "no-store" }),
          fetch(`/api/pim/pim-number`, { cache: "no-store" }),
        ]);

        const caseJson = await caseRes.json();
        if (!caseRes.ok || !caseJson.success) {
          throw new Error(caseJson.message || "Unable to load case.");
        }

        setData({
          case: caseJson.data.case,
          parties: caseJson.data.parties || [],
          docket: caseJson.data.docket || [],
          scrutiny: caseJson.data.scrutiny || null,
        });

        const lastRegisteredJson = await lastRegisteredRes.json();
        if (lastRegisteredRes.ok && lastRegisteredJson.success) {
          setLastRegistered(lastRegisteredJson.data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load case.");
      } finally {
        setLoading(false);
      }
    }

    if (id) {
      loadCase();
    }
  }, [id]);

  async function assign(confirmGap = false, confirmLower = false) {
    if (saving || assigned) {
      return;
    }

    const parsedRunningNumber = Number(runningNumber);
    if (!Number.isInteger(parsedRunningNumber) || parsedRunningNumber <= 0) {
      setError("Enter the PIM running number from the official register (a positive whole number).");
      return;
    }

    if (!confirmGap && !confirmLower && !confirm(`Register this case as PIM/${parsedRunningNumber}/${year}?`)) {
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch("/api/pim/pim-number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: Number(id),
          runningNumber: parsedRunningNumber,
          year,
          confirmGap,
          confirmLower,
        }),
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to register the PIM number.");
      }

      if (json.data.requiresConfirmation) {
        const proceed = confirm(`${json.data.message}\n\nContinue anyway?`);
        setSaving(false);
        if (proceed) {
          if (json.data.warningType === "GAP") {
            return assign(true, false);
          }
          return assign(false, true);
        }
        return;
      }

      setAssigned(true);
      setSuccess(`PIM number registered successfully: ${json.data.pimNumber}`);

      if (data) {
        setData({
          ...data,
          case: {
            ...data.case,
            pim_number: json.data.pimNumber,
            registration_date: json.data.registrationDate,
            status_code: "FORM2_PENDING",
            status_name: "Form-2 Pending",
            internal_60_day_date: json.data.internal60DayDate,
          },
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to register the PIM number.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          Loading...
        </div>
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          <p className="text-red-700">{error}</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return null;
  }

  const caseData = data.case;

  const applicants = data.parties.filter((party) => party.role === "APPLICANT");
  const opponents = data.parties.filter((party) => party.role === "OPPOSITE_PARTY");

  const isPending = caseData.status_code === "PIM_NUMBER_PENDING";
  const isDone = Boolean(caseData.pim_number) || assigned;

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">

        {/* HEADER */}

        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <h1 className="text-2xl font-bold">Assign PIM Number</h1>
              <p className="mt-1 text-sm text-gray-600">Received Application ID: {caseData.id}</p>
            </div>

            <div
              className={`rounded px-4 py-2 text-sm font-semibold ${
                isDone
                  ? "bg-green-100 text-green-800"
                  : isPending
                    ? "bg-yellow-100 text-yellow-800"
                    : "bg-gray-100 text-gray-700"
              }`}
            >
              {caseData.status_name}
            </div>
          </div>

          {isPending && !isDone && (
            <div className="mt-5 rounded border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-900">
              Scrutiny has been completed and this case is awaiting PIM number assignment.
            </div>
          )}

          {isDone && (
            <div className="mt-5 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900">
              This application has already been assigned a PIM number and registered.
            </div>
          )}
        </section>

        {/* CASE DETAILS */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Application Details</h2>

          <div className="grid gap-5 md:grid-cols-4">
            <Info label="Received Number" value={caseData.received_number || "-"} />
            <Info label="Received Date" value={caseData.received_date} />
            <Info label="Application Date" value={caseData.application_date} />
            <Info
              label="Claim Amount"
              value={
                caseData.claim_amount !== null
                  ? `₹${Number(caseData.claim_amount).toLocaleString("en-IN")}`
                  : "-"
              }
            />
          </div>

          <div className="mt-5">
            <Info label="Current PIM Number" value={caseData.pim_number || "Not yet assigned"} />
          </div>

          <div className="mt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Dispute Description</p>
            <div className="mt-1 rounded border bg-gray-50 p-3 text-sm">
              {caseData.dispute_description || "Not provided"}
            </div>
          </div>
        </section>

        {/* PARTIES */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Parties</h2>
          <PartyGroup title="Applicants" parties={applicants} />
          <div className="mt-6">
            <PartyGroup title="Opposite Parties" parties={opponents} />
          </div>
        </section>

        {/* SCRUTINY */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Scrutiny Result</h2>

          <div className="grid gap-5 md:grid-cols-3">
            <Info label="Scrutiny Status" value={caseData.scrutiny_status || data.scrutiny?.scrutiny_result || "-"} />
            <Info label="Scrutinised At" value={data.scrutiny?.scrutinised_at || "-"} />
            <Info label="Defects" value={data.scrutiny?.defect_details || "None recorded"} />
          </div>

          <div className="mt-5 rounded border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            Scrutiny completed. This case is ready for PIM number assignment.
          </div>
        </section>

        {/* DOCKET */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">Docket History</h2>

          <div className="space-y-4">
            {data.docket.length === 0 ? (
              <p className="text-sm text-gray-500">No docket entries.</p>
            ) : (
              data.docket.map((entry) => (
                <div key={entry.id} className="border-l-4 border-gray-300 pl-4">
                  <p className="font-medium">{entry.event_name}</p>
                  <p className="text-xs text-gray-500">{entry.docket_date}</p>
                  <p className="mt-1 text-sm">{entry.entry_text}</p>
                  {entry.action_required && (
                    <p className="mt-1 text-xs text-gray-600">Action: {entry.action_required}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        {/* ASSIGNMENT */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">PIM Number Assignment</h2>

          {isPending && !isDone ? (
            <>
              <div className="rounded border bg-gray-50 p-4 text-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Last Registered Number ({lastRegistered?.year ?? year})</p>
                <p className="mt-1 text-lg font-semibold text-gray-900">
                  {lastRegistered?.lastRunningNumber != null ? lastRegistered.lastRunningNumber : "None registered yet this year"}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Enter the official running number for this case from the PIM/Assignment Register below. The system
                  will not generate a number for you.
                </p>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-xs font-medium uppercase tracking-wide text-gray-500">Running Number</label>
                  <input
                    type="number"
                    min={1}
                    value={runningNumber}
                    onChange={(event) => setRunningNumber(event.target.value)}
                    placeholder="e.g. 119"
                    className="mt-1 w-full rounded border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium uppercase tracking-wide text-gray-500">Year</label>
                  <input
                    type="number"
                    value={year}
                    onChange={(event) => setYear(Number(event.target.value))}
                    className="mt-1 w-full rounded border px-3 py-2 text-sm"
                  />
                </div>
              </div>

              {runningNumber && Number.isInteger(Number(runningNumber)) && Number(runningNumber) > 0 && (
                <p className="mt-2 text-sm text-gray-600">
                  This case will be registered as <span className="font-semibold">PIM/{runningNumber}/{year}</span>.
                </p>
              )}

              {error && (
                <div className="mt-4 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>
              )}

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => assign()}
                  disabled={saving}
                  className="rounded bg-black px-6 py-3 font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? "Registering..." : "Register PIM Number"}
                </button>
              </div>
            </>
          ) : (
            <div className="rounded border border-green-300 bg-green-50 p-5">
              <p className="font-semibold text-green-900">PIM Number Assigned</p>

              <div className="mt-4 grid gap-5 md:grid-cols-3">
                <Info label="PIM Number" value={caseData.pim_number || "-"} />
                <Info label="Registration Date" value={caseData.registration_date || "-"} />
                <Info label="Internal 60-Day Date" value={caseData.internal_60_day_date || "-"} />
              </div>
            </div>
          )}
        </section>

        {success && (
          <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm font-medium text-green-800">
            {success}
          </div>
        )}

      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-gray-900">{value}</p>
    </div>
  );
}

function PartyGroup({ title, parties }: { title: string; parties: Party[] }) {
  return (
    <div>
      <h3 className="mb-3 font-medium">{title}</h3>

      {parties.length === 0 ? (
        <p className="text-sm text-gray-500">None recorded.</p>
      ) : (
        <div className="space-y-4">
          {parties.map((party) => (
            <div key={party.party_id} className="rounded border p-4">
              <div className="flex justify-between">
                <div>
                  <p className="font-semibold">{party.name}</p>
                  <p className="text-xs text-gray-500">{party.entity_type}</p>
                </div>
                {party.is_primary === 1 && (
                  <span className="text-xs font-medium text-gray-600">Primary</span>
                )}
              </div>

              <div className="mt-4">
                <p className="text-sm font-medium">Address</p>
                {party.addresses.length > 0 ? (
                  party.addresses.map((address) => (
                    <div key={address.id} className="mt-2 rounded bg-gray-50 p-3 text-sm">
                      <p>{address.address_line1}</p>
                      {address.address_line2 && <p>{address.address_line2}</p>}
                      <p>
                        {[address.village_town, address.district, address.state, address.pincode]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="mt-2 text-sm text-red-600">No address recorded.</p>
                )}
              </div>

              <div className="mt-4">
                <p className="text-sm font-medium">Advocate</p>
                {party.advocates.length > 0 ? (
                  party.advocates.map((advocate) => (
                    <div key={advocate.id} className="mt-2 rounded bg-gray-50 p-3 text-sm">
                      <p className="font-medium">{advocate.advocate_name}</p>
                      {advocate.enrollment_no && <p>Enrollment: {advocate.enrollment_no}</p>}
                      {advocate.phone && <p>Phone: {advocate.phone}</p>}
                    </div>
                  ))
                ) : (
                  <p className="mt-2 text-sm text-gray-500">No advocate recorded.</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
