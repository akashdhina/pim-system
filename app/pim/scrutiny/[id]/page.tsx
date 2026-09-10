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
};

type Advocate = {
  id: number;
  advocate_name: string;
  enrollment_no: string | null;
  phone: string | null;
  email: string | null;
  advocate_address: string | null;
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

type Fee = {
  id: number;
  case_id: number;
  party_id: number | null;
  fee_type: string;
  amount_due: number;
  amount_received: number;
  dd_number: string | null;
  dd_date: string | null;
  bank_name: string | null;
  payee: string | null;
  received_date: string | null;
  deposited_date: string | null;
  refund_amount: number;
  refund_date: string | null;
  status: string;
  remarks: string | null;
};

type CaseData = {
  id: number;
  pim_number: string | null;
  received_number: string;
  received_date: string;
  application_date: string;
  claim_amount: number | null;
  dispute_description: string | null;
  status_code: string;
  status_name: string;
};

type DocketEntry = {
  id: number;
  docket_date: string;
  entry_text: string;
  event_name: string;
};

type ScrutinyData = {
  application_fee_received: number | null;
  dd_number: string | null;
  dd_date: string | null;
  dd_bank: string | null;
  dd_amount: number | null;
  dd_payee_correct: number | null;
  dd_valid: number | null;
  opposite_party_address_available: number | null;
  commercial_dispute_checked: number | null;
  territorial_jurisdiction_checked: number | null;
  supporting_documents_checked: number | null;
  scrutiny_result: string | null;
  defect_details: string | null;
  rectification_date: string | null;
  scrutinised_by: number | null;
  scrutinised_at: string | null;
};

export default function ScrutinyPage() {
  const params = useParams();
  const id = params.id as string;

  const [caseData, setCaseData] =
    useState<CaseData | null>(null);

  const [parties, setParties] =
    useState<Party[]>([]);

  const [fees, setFees] =
    useState<Fee[]>([]);

  const [docket, setDocket] =
    useState<DocketEntry[]>([]);

  const [scrutiny, setScrutiny] =
    useState<ScrutinyData | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [saved, setSaved] =
    useState(false);

  const [error, setError] =
    useState("");

  const [success, setSuccess] =
    useState("");

  const [result, setResult] =
    useState<"COMPLETE" | "DEFECT">(
      "COMPLETE"
    );

  const [defectDetails, setDefectDetails] =
    useState("");

  const [checks, setChecks] = useState({
    applicationFeeReceived: false,
    ddPayeeCorrect: false,
    ddValid: false,
    oppositePartyAddressAvailable: false,
    commercialDisputeChecked: false,
    territorialJurisdictionChecked: false,
    supportingDocumentsChecked: false,
  });

  useEffect(() => {
    async function loadCase() {
      try {
        setLoading(true);
        setError("");

        const response = await fetch(
          `/api/pim/scrutiny/${id}`,
          {
            cache: "no-store",
          }
        );

        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(
            json.message ||
              "Unable to load scrutiny."
          );
        }

        const loadedCase =
          json.data.case as CaseData;

        setCaseData(loadedCase);
        setParties(json.data.parties || []);
        setFees(json.data.fees || []);
        setDocket(json.data.docket || []);
        setScrutiny(
          json.data.scrutiny || null
        );

        if (json.data.scrutiny) {
          const s =
            json.data.scrutiny as ScrutinyData;

          setChecks({
            applicationFeeReceived:
              !!s.application_fee_received,

            ddPayeeCorrect:
              !!s.dd_payee_correct,

            ddValid:
              !!s.dd_valid,

            oppositePartyAddressAvailable:
              !!s.opposite_party_address_available,

            commercialDisputeChecked:
              !!s.commercial_dispute_checked,

            territorialJurisdictionChecked:
              !!s.territorial_jurisdiction_checked,

            supportingDocumentsChecked:
              !!s.supporting_documents_checked,
          });

          if (
            s.scrutiny_result ===
            "DEFECT"
          ) {
            setResult("DEFECT");

            setDefectDetails(
              s.defect_details || ""
            );
          }

          /*
           * If scrutiny has already been completed,
           * the page becomes read-only.
           */
          if (
            loadedCase.status_code ===
              "SECRETARY_APPROVAL_PENDING" ||
            loadedCase.status_code ===
              "DEFECT_PENDING"
          ) {
            setSaved(true);
          }
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load case."
        );
      } finally {
        setLoading(false);
      }
    }

    if (id) {
      loadCase();
    }
  }, [id]);

  const scrutinyLocked =
    caseData !== null &&
    caseData.status_code !==
      "RECEIVED" &&
    caseData.status_code !==
      "SCRUTINY_PENDING";

  function toggleCheck(
    field: keyof typeof checks
  ) {
    if (scrutinyLocked || saved) {
      return;
    }

    setChecks((current) => ({
      ...current,
      [field]: !current[field],
    }));
  }

  const applicationFee =
    fees.find(
      (fee) =>
        fee.fee_type ===
        "APPLICATION_FEE"
    ) || fees[0];

  const applicants =
    parties.filter(
      (party) =>
        party.role === "APPLICANT"
    );

  const opponents =
    parties.filter(
      (party) =>
        party.role ===
        "OPPOSITE_PARTY"
    );

  function allMandatoryChecksPassed() {
    return Object.values(checks).every(
      Boolean
    );
  }

  async function saveScrutiny() {
    if (
      saving ||
      saved ||
      scrutinyLocked
    ) {
      return;
    }

    setError("");
    setSuccess("");

    if (result === "COMPLETE") {
      if (!allMandatoryChecksPassed()) {
        setError(
          "Complete all scrutiny checks before marking the application as complete."
        );
        return;
      }
    }

    if (
      result === "DEFECT" &&
      !defectDetails.trim()
    ) {
      setError(
        "Enter the defect / rectification details."
      );
      return;
    }

    setSaving(true);

    try {
      const response = await fetch(
        `/api/pim/scrutiny/${id}`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            applicationFeeReceived:
              checks.applicationFeeReceived,

            ddNumber:
              applicationFee?.dd_number ||
              "",

            ddDate:
              applicationFee?.dd_date ||
              "",

            ddBank:
              applicationFee?.bank_name ||
              "",

            ddAmount:
              applicationFee?.amount_received ||
              0,

            ddPayeeCorrect:
              checks.ddPayeeCorrect,

            ddValid:
              checks.ddValid,

            oppositePartyAddressAvailable:
              checks.oppositePartyAddressAvailable,

            commercialDisputeChecked:
              checks.commercialDisputeChecked,

            territorialJurisdictionChecked:
              checks.territorialJurisdictionChecked,

            supportingDocumentsChecked:
              checks.supportingDocumentsChecked,

            scrutinyResult: result,

            defectDetails:
              defectDetails.trim(),
          }),
        }
      );

      const json =
        await response.json();

      if (
        !response.ok ||
        !json.success
      ) {
        throw new Error(
          json.message ||
            "Unable to save scrutiny."
        );
      }

      setSaved(true);

      setSuccess(
        result === "COMPLETE"
          ? "Scrutiny completed. The file has been put up for Secretary approval."
          : "Defect recorded. The case is now pending rectification."
      );

      /*
       * Update the page immediately so the
       * controls become read-only without
       * requiring a refresh.
       */
      if (caseData) {
        setCaseData({
          ...caseData,
          status_code:
            json.status,
          status_name:
            json.status ===
            "DEFECT_PENDING"
              ? "Defect / Rectification Pending"
              : "Secretary Approval Pending",
        });
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to save scrutiny."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          Loading scrutiny...
        </div>
      </main>
    );
  }

  if (!caseData) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          <p className="text-red-600">
            {error ||
              "Case not found."}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">

        {/* HEADER */}

        <div className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <h1 className="text-2xl font-bold">
                PIM Scrutiny
              </h1>

              <p className="mt-1 text-sm text-gray-600">
                Received Application ID:{" "}
                {caseData.id}
              </p>
            </div>

            <div
              className={`rounded px-4 py-2 text-sm font-semibold ${
                caseData.status_code ===
                "SECRETARY_APPROVAL_PENDING"
                  ? "bg-blue-100 text-blue-800"
                  : caseData.status_code ===
                    "DEFECT_PENDING"
                  ? "bg-red-100 text-red-800"
                  : "bg-yellow-100 text-yellow-800"
              }`}
            >
              {caseData.status_name}
            </div>
          </div>

          {scrutinyLocked && (
            <div className="mt-4 rounded border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
              {caseData.status_code ===
              "SECRETARY_APPROVAL_PENDING"
                ? "Scrutiny has been completed. This file is now pending Secretary approval. The scrutiny record is read-only."
                : "This scrutiny record is read-only because the case is no longer at the scrutiny stage."}
            </div>
          )}
        </div>

        {/* APPLICATION DETAILS */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">
            Application Details
          </h2>

          <div className="grid gap-4 md:grid-cols-4">
            <Info
              label="Received Number"
              value={
                caseData.received_number
              }
            />

            <Info
              label="Received Date"
              value={
                caseData.received_date
              }
            />

            <Info
              label="Application Date"
              value={
                caseData.application_date
              }
            />

            <Info
              label="Claim Amount"
              value={
                caseData.claim_amount !==
                null
                  ? `₹${Number(
                      caseData.claim_amount
                    ).toLocaleString(
                      "en-IN"
                    )}`
                  : "-"
              }
            />
          </div>

          <div className="mt-4">
            <p className="text-sm font-medium text-gray-700">
              PIM Number
            </p>

            <p className="mt-1 text-sm">
              {caseData.pim_number ||
                "Not assigned at this stage."}
            </p>
          </div>

          <div className="mt-4">
            <p className="text-sm font-medium text-gray-700">
              Dispute Description
            </p>

            <div className="mt-1 rounded border bg-gray-50 p-3 text-sm">
              {caseData.dispute_description ||
                "Not provided"}
            </div>
          </div>
        </section>

        {/* PARTIES */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Parties
          </h2>

          <div className="space-y-6">

            <PartyGroup
              title="Applicants"
              parties={applicants}
            />

            <PartyGroup
              title="Opposite Parties"
              parties={opponents}
            />

          </div>
        </section>

        {/* FEE */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Application Fee / DD
          </h2>

          {applicationFee ? (
            <div className="grid gap-4 md:grid-cols-3">

              <Info
                label="DD Number"
                value={
                  applicationFee.dd_number ||
                  "-"
                }
              />

              <Info
                label="DD Date"
                value={
                  applicationFee.dd_date ||
                  "-"
                }
              />

              <Info
                label="Bank"
                value={
                  applicationFee.bank_name ||
                  "-"
                }
              />

              <Info
                label="Amount"
                value={`₹${Number(
                  applicationFee.amount_received
                ).toLocaleString(
                  "en-IN"
                )}`}
              />

              <Info
                label="Payee"
                value={
                  applicationFee.payee ||
                  "-"
                }
              />

              <Info
                label="Status"
                value={
                  applicationFee.status
                }
              />

            </div>
          ) : (
            <p className="text-red-600">
              No application fee record found.
            </p>
          )}
        </section>

        {/* DOCUMENTS */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">
            Supporting Documents
          </h2>

          <p className="text-sm text-gray-600">
            Documents attached to this application
            will appear here.
          </p>

          <div className="mt-3 rounded border bg-gray-50 p-4 text-sm">
            No documents recorded.
          </div>
        </section>

        {/* SCRUTINY CHECKS */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Scrutiny Checks
          </h2>

          <div className="space-y-3">

            <CheckRow
              label="Application fee received"
              checked={
                checks.applicationFeeReceived
              }
              disabled={
                scrutinyLocked ||
                saved
              }
              onChange={() =>
                toggleCheck(
                  "applicationFeeReceived"
                )
              }
            />

            <CheckRow
              label="DD payee is correct — Chairman, DLSA"
              checked={
                checks.ddPayeeCorrect
              }
              disabled={
                scrutinyLocked ||
                saved
              }
              onChange={() =>
                toggleCheck(
                  "ddPayeeCorrect"
                )
              }
            />

            <CheckRow
              label="DD is valid"
              checked={
                checks.ddValid
              }
              disabled={
                scrutinyLocked ||
                saved
              }
              onChange={() =>
                toggleCheck(
                  "ddValid"
                )
              }
            />

            <CheckRow
              label="Opposite party address is available"
              checked={
                checks.oppositePartyAddressAvailable
              }
              disabled={
                scrutinyLocked ||
                saved
              }
              onChange={() =>
                toggleCheck(
                  "oppositePartyAddressAvailable"
                )
              }
            />

            <CheckRow
              label="Commercial dispute requirement checked"
              checked={
                checks.commercialDisputeChecked
              }
              disabled={
                scrutinyLocked ||
                saved
              }
              onChange={() =>
                toggleCheck(
                  "commercialDisputeChecked"
                )
              }
            />

            <CheckRow
              label="Territorial jurisdiction checked"
              checked={
                checks.territorialJurisdictionChecked
              }
              disabled={
                scrutinyLocked ||
                saved
              }
              onChange={() =>
                toggleCheck(
                  "territorialJurisdictionChecked"
                )
              }
            />

            <CheckRow
              label="Supporting documents checked"
              checked={
                checks.supportingDocumentsChecked
              }
              disabled={
                scrutinyLocked ||
                saved
              }
              onChange={() =>
                toggleCheck(
                  "supportingDocumentsChecked"
                )
              }
            />

          </div>
        </section>

        {/* RESULT */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Scrutiny Result
          </h2>

          <div className="space-y-4">

            <label
              className={`flex items-center gap-3 ${
                scrutinyLocked ||
                saved
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer"
              }`}
            >
              <input
                type="radio"
                checked={
                  result === "COMPLETE"
                }
                disabled={
                  scrutinyLocked ||
                  saved
                }
                onChange={() =>
                  setResult("COMPLETE")
                }
              />

              <span className="font-medium">
                Scrutiny Complete
              </span>
            </label>

            <label
              className={`flex items-center gap-3 ${
                scrutinyLocked ||
                saved
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer"
              }`}
            >
              <input
                type="radio"
                checked={
                  result === "DEFECT"
                }
                disabled={
                  scrutinyLocked ||
                  saved
                }
                onChange={() =>
                  setResult("DEFECT")
                }
              />

              <span className="font-medium">
                Defect / Rectification Required
              </span>
            </label>

            {result === "DEFECT" && (
              <div>
                <label className="block text-sm font-medium">
                  Defect Details
                </label>

                <textarea
                  value={defectDetails}
                  disabled={
                    scrutinyLocked ||
                    saved
                  }
                  onChange={(e) =>
                    setDefectDetails(
                      e.target.value
                    )
                  }
                  rows={5}
                  className="mt-1 w-full rounded border p-3 disabled:bg-gray-100"
                  placeholder="Record the administrative defect / rectification required."
                />
              </div>
            )}

          </div>
        </section>

        {/* DOCKET */}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">
            Docket History
          </h2>

          <div className="space-y-3">

            {docket.length === 0 ? (
              <p className="text-sm text-gray-500">
                No docket entries.
              </p>
            ) : (
              docket.map((entry) => (
                <div
                  key={entry.id}
                  className="border-l-4 border-gray-300 pl-4"
                >
                  <p className="text-sm font-medium">
                    {entry.event_name}
                  </p>

                  <p className="text-xs text-gray-500">
                    {entry.docket_date}
                  </p>

                  <p className="mt-1 text-sm">
                    {entry.entry_text}
                  </p>
                </div>
              ))
            )}

          </div>
        </section>

        {/* MESSAGES */}

        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
            <strong>Error:</strong>{" "}
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-800">
            <strong>
              {success}
            </strong>
          </div>
        )}

        {/* ACTION */}

        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">

            <div>
              <p className="font-medium">
                AA Scrutiny
              </p>

              <p className="mt-1 text-sm text-gray-600">
                Saving scrutiny does not assign a
                PIM number. Registration remains a
                separate Secretary decision.
              </p>
            </div>

            {!scrutinyLocked &&
            !saved ? (
              <button
                type="button"
                onClick={saveScrutiny}
                disabled={saving}
                className="rounded bg-black px-6 py-3 font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving
                  ? "Saving..."
                  : "Save Scrutiny"}
              </button>
            ) : (
              <div className="rounded bg-gray-100 px-6 py-3 font-medium text-gray-700">
                Scrutiny Saved
              </div>
            )}

          </div>
        </section>

      </div>
    </main>
  );
}

function Info({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>

      <p className="mt-1 text-sm font-medium">
        {value}
      </p>
    </div>
  );
}

function CheckRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex items-center gap-3 rounded border p-3 ${
        disabled
          ? "cursor-not-allowed bg-gray-50 opacity-70"
          : "cursor-pointer hover:bg-gray-50"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="h-4 w-4"
      />

      <span className="text-sm">
        {label}
      </span>
    </label>
  );
}

function PartyGroup({
  title,
  parties,
}: {
  title: string;
  parties: Party[];
}) {
  return (
    <div>
      <h3 className="mb-3 font-medium">
        {title}
      </h3>

      {parties.length === 0 ? (
        <p className="text-sm text-gray-500">
          None recorded.
        </p>
      ) : (
        <div className="space-y-4">
          {parties.map((party) => (
            <div
              key={party.party_id}
              className="rounded border p-4"
            >
              <div className="flex flex-col justify-between gap-2 md:flex-row">
                <div>
                  <p className="font-semibold">
                    {party.name}
                  </p>

                  <p className="text-xs text-gray-500">
                    {party.entity_type}
                  </p>
                </div>

                {party.is_primary ===
                  1 && (
                  <span className="text-xs font-medium text-gray-600">
                    Primary
                  </span>
                )}
              </div>

              <div className="mt-4">
                <p className="text-sm font-medium">
                  Address
                </p>

                {party.addresses.length >
                0 ? (
                  party.addresses.map(
                    (address) => (
                      <div
                        key={address.id}
                        className="mt-2 rounded bg-gray-50 p-3 text-sm"
                      >
                        <p>
                          {
                            address.address_line1
                          }
                        </p>

                        {address.address_line2 && (
                          <p>
                            {
                              address.address_line2
                            }
                          </p>
                        )}

                        <p>
                          {[
                            address.village_town,
                            address.district,
                            address.state,
                            address.pincode,
                          ]
                            .filter(Boolean)
                            .join(", ")}
                        </p>

                        <p className="mt-1 text-xs text-gray-500">
                          {
                            address.address_type
                          }
                        </p>
                      </div>
                    )
                  )
                ) : (
                  <p className="mt-2 text-sm text-red-600">
                    No address recorded.
                  </p>
                )}
              </div>

              <div className="mt-4">
                <p className="text-sm font-medium">
                  Advocate
                </p>

                {party.advocates.length >
                0 ? (
                  party.advocates.map(
                    (advocate) => (
                      <div
                        key={advocate.id}
                        className="mt-2 rounded bg-gray-50 p-3 text-sm"
                      >
                        <p className="font-medium">
                          {
                            advocate.advocate_name
                          }
                        </p>

                        {advocate.enrollment_no && (
                          <p>
                            Enrollment:{" "}
                            {
                              advocate.enrollment_no
                            }
                          </p>
                        )}

                        {advocate.phone && (
                          <p>
                            Phone:{" "}
                            {
                              advocate.phone
                            }
                          </p>
                        )}

                        {advocate.email && (
                          <p>
                            Email:{" "}
                            {
                              advocate.email
                            }
                          </p>
                        )}
                      </div>
                    )
                  )
                ) : (
                  <p className="mt-2 text-sm text-gray-500">
                    No advocate recorded.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
