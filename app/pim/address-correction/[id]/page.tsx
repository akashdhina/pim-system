"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Address = {
  id: number;
  address_type: string;
  address_line1: string;
  address_line2: string | null;
  village_town: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
  is_current: number;
};

type Candidate = {
  service_attempt_id: number;
  return_reason: string | null;
  postal_endorsement: string | null;
  returned_date: string | null;
  service_remarks: string | null;
  notice_id: number;
  notice_type: string;
  notice_date: string;
  recipient_party_id: number;
  recipient_name: string | null;
  recipientAddresses: Address[];
};

type CaseData = {
  id: number;
  pim_number: string | null;
  received_number: string | null;
  status_code: string;
  status_name: string;
};

type PageData = {
  case: CaseData;
  candidates: Candidate[];
};

export default function AddressCorrectionPage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [selectedAttemptId, setSelectedAttemptId] =
    useState<number | null>(null);

  const [decision, setDecision] = useState<
    "" | "CORRECTED_ADDRESS_RECEIVED" | "NO_CORRECTED_ADDRESS"
  >("");

  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [villageTown, setVillageTown] = useState("");
  const [district, setDistrict] = useState("");
  const [state, setState] = useState("");
  const [pincode, setPincode] = useState("");
  const [addressType, setAddressType] = useState("POSTAL");

  const [appearanceDate, setAppearanceDate] = useState("");
  const [appearanceTime, setAppearanceTime] = useState("");

  const [confirmed, setConfirmed] = useState(false);
  const [remarks, setRemarks] = useState("");

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(
        `/api/pim/address-correction/${id}`,
        { cache: "no-store" }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          json.message || "Unable to load address correction data."
        );
      }

      setData(json.data);

      if (json.data.candidates.length === 1) {
        setSelectedAttemptId(
          json.data.candidates[0].service_attempt_id
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load address correction data."
      );
    } finally {
      setLoading(false);
    }
  }

  const selectedCandidate = data?.candidates.find(
    (candidate) =>
      candidate.service_attempt_id === selectedAttemptId
  );

  async function submit() {
    if (saving) return;

    setError("");
    setSuccess("");

    if (!selectedCandidate) {
      setError("Select the returned notice to act on.");
      return;
    }

    if (!decision) {
      setError("Select a decision.");
      return;
    }

    if (decision === "CORRECTED_ADDRESS_RECEIVED") {
      if (!addressLine1.trim()) {
        setError("Corrected address line 1 is required.");
        return;
      }

      if (!appearanceDate) {
        setError("Appearance date for the fresh notice is required.");
        return;
      }

      if (!appearanceTime) {
        setError("Appearance time for the fresh notice is required.");
        return;
      }

      if (
        !confirm(
          "Record this corrected address and prepare a fresh Initial Form-2 notice?"
        )
      ) {
        return;
      }
    } else {
      if (!remarks.trim()) {
        setError("Remarks are required when no corrected address is available.");
        return;
      }

      if (!confirmed) {
        setError("Confirm that no corrected/alternate address is available.");
        return;
      }

      if (
        !confirm(
          "Confirm no corrected address is available? This will move the case to Final Notice Pending."
        )
      ) {
        return;
      }
    }

    try {
      setSaving(true);

      const payload =
        decision === "CORRECTED_ADDRESS_RECEIVED"
          ? {
              serviceAttemptId: selectedCandidate.service_attempt_id,
              decision,
              partyId: selectedCandidate.recipient_party_id,
              addressType,
              addressLine1: addressLine1.trim(),
              addressLine2: addressLine2.trim() || null,
              villageTown: villageTown.trim() || null,
              district: district.trim() || null,
              state: state.trim() || null,
              pincode: pincode.trim() || null,
              appearanceDate,
              appearanceTime,
              remarks: remarks.trim() || null,
            }
          : {
              serviceAttemptId: selectedCandidate.service_attempt_id,
              decision,
              confirmed,
              remarks: remarks.trim(),
            };

      const response = await fetch(
        `/api/pim/address-correction/${id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to save address correction.");
      }

      setSuccess(json.message);
      setDecision("");
      setAddressLine1("");
      setAddressLine2("");
      setVillageTown("");
      setDistrict("");
      setState("");
      setPincode("");
      setAppearanceDate("");
      setAppearanceTime("");
      setConfirmed(false);
      setRemarks("");

      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to save address correction."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-5xl rounded-lg bg-white p-6 shadow">
          Loading address correction...
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-5xl rounded-lg bg-white p-6 shadow">
          <p className="text-red-700">
            {error || "Unable to load case."}
          </p>
        </div>
      </main>
    );
  }

  const isAddressCorrectionPending =
    data.case.status_code === "ADDRESS_CORRECTION_PENDING";

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <h1 className="text-2xl font-bold">
                Address Correction
              </h1>

              <p className="mt-1 text-sm text-gray-600">
                PIM Number:{" "}
                <strong>{data.case.pim_number || "-"}</strong>
              </p>

              <p className="text-sm text-gray-600">
                Received Number: {data.case.received_number || "-"}
              </p>
            </div>

            <div
              className={`rounded px-4 py-2 text-sm font-semibold ${
                isAddressCorrectionPending
                  ? "bg-yellow-100 text-yellow-800"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {data.case.status_name}
            </div>
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

          {!isAddressCorrectionPending && (
            <div className="mt-5 rounded border border-gray-300 bg-gray-50 p-4 text-sm text-gray-700">
              This case is not currently awaiting address correction.
            </div>
          )}
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">
            Returned Notice
          </h2>

          {data.candidates.length === 0 ? (
            <p className="text-sm text-gray-500">
              No outstanding returned notices found for this case.
            </p>
          ) : (
            <div className="space-y-3">
              {data.candidates.length > 1 && (
                <p className="text-sm text-amber-700">
                  Multiple returned notices were found. Select the
                  one this address correction applies to.
                </p>
              )}

              {data.candidates.map((candidate) => (
                <button
                  key={candidate.service_attempt_id}
                  type="button"
                  onClick={() =>
                    setSelectedAttemptId(
                      candidate.service_attempt_id
                    )
                  }
                  className={`block w-full rounded border p-4 text-left ${
                    selectedAttemptId ===
                    candidate.service_attempt_id
                      ? "border-black"
                      : "border-gray-200"
                  }`}
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-semibold">
                      {candidate.recipient_name || "Opposite party"}
                    </span>
                    <span className="text-xs text-gray-500">
                      Notice #{candidate.notice_id} / Service Attempt
                      #{candidate.service_attempt_id}
                    </span>
                  </div>

                  <p className="mt-1 text-sm text-gray-600">
                    Postal Return Reason:{" "}
                    <strong>{candidate.return_reason || "-"}</strong>
                  </p>

                  {candidate.postal_endorsement && (
                    <p className="text-sm text-gray-600">
                      Postal Endorsement: {candidate.postal_endorsement}
                    </p>
                  )}

                  {candidate.service_remarks && (
                    <p className="text-sm text-gray-600">
                      Remarks: {candidate.service_remarks}
                    </p>
                  )}

                  <p className="text-sm text-gray-600">
                    Returned Date: {candidate.returned_date || "-"}
                  </p>
                </button>
              ))}
            </div>
          )}
        </section>

        {selectedCandidate && (
          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-4 text-lg font-semibold">
              Current / Last-Used Addresses
            </h2>

            <div className="space-y-3">
              {selectedCandidate.recipientAddresses.map((address) => (
                <div
                  key={address.id}
                  className="rounded border p-4 text-sm"
                >
                  <div className="flex justify-between">
                    <span className="font-medium">
                      {address.address_type}
                    </span>
                    <span
                      className={
                        address.is_current
                          ? "text-green-700"
                          : "text-gray-400"
                      }
                    >
                      {address.is_current ? "Current" : "Superseded"}
                    </span>
                  </div>

                  <p className="mt-1 text-gray-700">
                    {[
                      address.address_line1,
                      address.address_line2,
                      address.village_town,
                      address.district,
                      address.state,
                      address.pincode,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                </div>
              ))}

              {selectedCandidate.recipientAddresses.length === 0 && (
                <p className="text-sm text-gray-500">
                  No addresses recorded for this party.
                </p>
              )}
            </div>
          </section>
        )}

        {selectedCandidate && isAddressCorrectionPending && (
          <section className="rounded-lg border border-gray-300 bg-white p-6 shadow">
            <h2 className="text-lg font-semibold">Decision</h2>

            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700">
                Decision
              </label>

              <select
                value={decision}
                onChange={(event) =>
                  setDecision(
                    event.target.value as typeof decision
                  )
                }
                className="mt-2 w-full rounded border p-3 text-sm md:w-1/2"
              >
                <option value="">Select a decision</option>
                <option value="CORRECTED_ADDRESS_RECEIVED">
                  Corrected address received
                </option>
                <option value="NO_CORRECTED_ADDRESS">
                  No corrected address available
                </option>
              </select>
            </div>

            {decision === "CORRECTED_ADDRESS_RECEIVED" && (
              <div className="mt-6 space-y-5">
                <div className="grid gap-5 md:grid-cols-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Address Type
                    </label>
                    <select
                      value={addressType}
                      onChange={(event) =>
                        setAddressType(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    >
                      <option value="POSTAL">Postal</option>
                      <option value="REGISTERED_OFFICE">
                        Registered Office
                      </option>
                      <option value="ALTERNATE">Alternate</option>
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Address Line 1
                    </label>
                    <input
                      value={addressLine1}
                      onChange={(event) =>
                        setAddressLine1(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>

                  <div className="md:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      Address Line 2
                    </label>
                    <input
                      value={addressLine2}
                      onChange={(event) =>
                        setAddressLine2(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Village / Town
                    </label>
                    <input
                      value={villageTown}
                      onChange={(event) =>
                        setVillageTown(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      District
                    </label>
                    <input
                      value={district}
                      onChange={(event) =>
                        setDistrict(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      State
                    </label>
                    <input
                      value={state}
                      onChange={(event) =>
                        setState(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Pincode
                    </label>
                    <input
                      value={pincode}
                      onChange={(event) =>
                        setPincode(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Fresh Notice Appearance Date
                    </label>
                    <input
                      type="date"
                      value={appearanceDate}
                      onChange={(event) =>
                        setAppearanceDate(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Must not exceed 10 days from today.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Fresh Notice Appearance Time
                    </label>
                    <input
                      type="time"
                      value={appearanceTime}
                      onChange={(event) =>
                        setAppearanceTime(event.target.value)
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Remarks (optional)
                  </label>
                  <textarea
                    rows={2}
                    value={remarks}
                    onChange={(event) =>
                      setRemarks(event.target.value)
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                  />
                </div>
              </div>
            )}

            {decision === "NO_CORRECTED_ADDRESS" && (
              <div className="mt-6 space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Remarks
                  </label>
                  <textarea
                    rows={3}
                    value={remarks}
                    onChange={(event) =>
                      setRemarks(event.target.value)
                    }
                    placeholder="Explain what was done to try to locate a corrected/alternate address."
                    className="mt-2 w-full rounded border p-3 text-sm"
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) =>
                      setConfirmed(event.target.checked)
                    }
                  />
                  I confirm no corrected/alternate address is
                  available for this opposite party.
                </label>
              </div>
            )}

            {decision && (
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={submit}
                  disabled={saving}
                  className="rounded bg-black px-6 py-3 font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Decision"}
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
