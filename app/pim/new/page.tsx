"use client";

import { useState } from "react";

const MIN_PIM_CLAIM_AMOUNT = 300000;
const MAX_PIM_CLAIM_AMOUNT = 10000000;
const PIM_CLAIM_AMOUNT_MESSAGE =
  "For filing PIM before DLSA, claim amount must be above ₹3,00,000 and below ₹1,00,00,000.";

type Address = {
  addressType: string;
  addressLine1: string;
  addressLine2: string;
  villageTown: string;
  district: string;
  state: string;
  pincode: string;
};

type Advocate = {
  name: string;
  enrollmentNo: string;
  phone: string;
  email: string;
  address: string;
};

type Party = {
  name: string;
  entityType: string;
  addresses: Address[];
  advocate: Advocate;
};

const emptyAddress = (): Address => ({
  addressType: "POSTAL",
  addressLine1: "",
  addressLine2: "",
  villageTown: "",
  district: "",
  state: "Tamil Nadu",
  pincode: "",
});

const emptyAdvocate = (): Advocate => ({
  name: "",
  enrollmentNo: "",
  phone: "",
  email: "",
  address: "",
});

const emptyParty = (): Party => ({
  name: "",
  entityType: "INDIVIDUAL",
  addresses: [emptyAddress()],
  advocate: emptyAdvocate(),
});

export default function NewPimPage() {
  const [applicants, setApplicants] = useState<Party[]>([
    emptyParty(),
  ]);

  const [opponents, setOpponents] = useState<Party[]>([
    emptyParty(),
  ]);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedCaseId, setSavedCaseId] = useState<number | null>(null);

  const [receipt, setReceipt] = useState({
    receivedNumber: "",
    receivedDate: "",
    applicationDate: "",
  });

  const [dispute, setDispute] = useState({
    claimAmount: "",
    description: "",
  });

  const [fee, setFee] = useState({
    ddNumber: "",
    ddDate: "",
    ddBank: "",
    ddAmount: "1000",
  });

  function updateReceipt(
    field: keyof typeof receipt,
    value: string
  ) {
    setReceipt((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateDispute(
    field: keyof typeof dispute,
    value: string
  ) {
    setDispute((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateFee(
    field: keyof typeof fee,
    value: string
  ) {
    setFee((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateParty(
    type: "applicant" | "opponent",
    partyIndex: number,
    field: keyof Party,
    value: string
  ) {
    const setter =
      type === "applicant"
        ? setApplicants
        : setOpponents;

    setter((current) =>
      current.map((party, index) =>
        index === partyIndex
          ? {
              ...party,
              [field]: value,
            }
          : party
      )
    );
  }

  function updateAddress(
    type: "applicant" | "opponent",
    partyIndex: number,
    addressIndex: number,
    field: keyof Address,
    value: string
  ) {
    const setter =
      type === "applicant"
        ? setApplicants
        : setOpponents;

    setter((current) =>
      current.map((party, index) => {
        if (index !== partyIndex) {
          return party;
        }

        return {
          ...party,
          addresses: party.addresses.map(
            (address, index2) =>
              index2 === addressIndex
                ? {
                    ...address,
                    [field]: value,
                  }
                : address
          ),
        };
      })
    );
  }

  function updateAdvocate(
    type: "applicant" | "opponent",
    partyIndex: number,
    field: keyof Advocate,
    value: string
  ) {
    const setter =
      type === "applicant"
        ? setApplicants
        : setOpponents;

    setter((current) =>
      current.map((party, index) =>
        index === partyIndex
          ? {
              ...party,
              advocate: {
                ...party.advocate,
                [field]: value,
              },
            }
          : party
      )
    );
  }

  function addParty(type: "applicant" | "opponent") {
    if (type === "applicant") {
      setApplicants((current) => [
        ...current,
        emptyParty(),
      ]);
    } else {
      setOpponents((current) => [
        ...current,
        emptyParty(),
      ]);
    }
  }

  function removeParty(
    type: "applicant" | "opponent",
    partyIndex: number
  ) {
    if (type === "applicant") {
      setApplicants((current) =>
        current.filter(
          (_, index) => index !== partyIndex
        )
      );
    } else {
      setOpponents((current) =>
        current.filter(
          (_, index) => index !== partyIndex
        )
      );
    }
  }

  function addAddress(
    type: "applicant" | "opponent",
    partyIndex: number
  ) {
    const setter =
      type === "applicant"
        ? setApplicants
        : setOpponents;

    setter((current) =>
      current.map((party, index) =>
        index === partyIndex
          ? {
              ...party,
              addresses: [
                ...party.addresses,
                emptyAddress(),
              ],
            }
          : party
      )
    );
  }

  function removeAddress(
    type: "applicant" | "opponent",
    partyIndex: number,
    addressIndex: number
  ) {
    const setter =
      type === "applicant"
        ? setApplicants
        : setOpponents;

    setter((current) =>
      current.map((party, index) => {
        if (index !== partyIndex) {
          return party;
        }

        if (party.addresses.length <= 1) {
          return party;
        }

        return {
          ...party,
          addresses: party.addresses.filter(
            (_, index2) => index2 !== addressIndex
          ),
        };
      })
    );
  }

  function validateForm() {
    if (!receipt.receivedNumber.trim()) {
      return "Received Number is required.";
    }

    if (!receipt.receivedDate) {
      return "Received Date is required.";
    }

    if (!receipt.applicationDate) {
      return "Application Date is required.";
    }

    if (applicants.length === 0) {
      return "At least one applicant is required.";
    }

    if (opponents.length === 0) {
      return "At least one opposite party is required.";
    }

    for (let i = 0; i < applicants.length; i++) {
      if (!applicants[i].name.trim()) {
        return `Applicant ${i + 1}: name is required.`;
      }

      const hasAddress = applicants[i].addresses.some(
        (address) =>
          address.addressLine1.trim() !== ""
      );

      if (!hasAddress) {
        return `Applicant ${
          i + 1
        }: at least one postal address is required.`;
      }
    }

    const claimAmount = Number(dispute.claimAmount);

    if (
      !dispute.claimAmount.trim() ||
      !Number.isFinite(claimAmount) ||
      claimAmount <= MIN_PIM_CLAIM_AMOUNT ||
      claimAmount >= MAX_PIM_CLAIM_AMOUNT
    ) {
      return PIM_CLAIM_AMOUNT_MESSAGE;
    }

    for (let i = 0; i < opponents.length; i++) {
      if (!opponents[i].name.trim()) {
        return `Opposite Party ${
          i + 1
        }: name is required.`;
      }

      const hasAddress = opponents[i].addresses.some(
        (address) =>
          address.addressLine1.trim() !== ""
      );

      if (!hasAddress) {
        return `Opposite Party ${
          i + 1
        }: at least one postal address is required.`;
      }
    }

    if (!fee.ddNumber.trim()) {
      return "Application fee DD Number is required.";
    }

    if (!fee.ddDate) {
      return "Application fee DD Date is required.";
    }

    if (!fee.ddBank.trim()) {
      return "Application fee Bank is required.";
    }

    if (!fee.ddAmount || Number(fee.ddAmount) <= 0) {
      return "Valid application fee amount is required.";
    }

    return null;
  }

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setMessage("");
    setError("");
    setSavedCaseId(null);

    const validationError = validateForm();

    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);

    try {
      const payload = {
        receivedNumber: receipt.receivedNumber.trim(),
        receivedDate: receipt.receivedDate,
        applicationDate: receipt.applicationDate,

        claimAmount:
          dispute.claimAmount.trim() === ""
            ? null
            : Number(dispute.claimAmount),

        disputeDescription:
          dispute.description.trim() || null,

        applicants: applicants.map((party) => ({
          name: party.name.trim(),
          entityType: party.entityType,

          addresses: party.addresses
            .filter(
              (address) =>
                address.addressLine1.trim() !== ""
            )
            .map((address) => ({
              addressType: address.addressType,
              addressLine1:
                address.addressLine1.trim(),
              addressLine2:
                address.addressLine2.trim() || null,
              villageTown:
                address.villageTown.trim() || null,
              district:
                address.district.trim() || null,
              state:
                address.state.trim() || null,
              pincode:
                address.pincode.trim() || null,
            })),

          advocate:
            party.advocate.name.trim() !== ""
              ? {
                  name:
                    party.advocate.name.trim(),
                  enrollmentNo:
                    party.advocate.enrollmentNo.trim() ||
                    null,
                  phone:
                    party.advocate.phone.trim() ||
                    null,
                  email:
                    party.advocate.email.trim() ||
                    null,
                  address:
                    party.advocate.address.trim() ||
                    null,
                }
              : null,
        })),

        oppositeParties: opponents.map(
          (party) => ({
            name: party.name.trim(),
            entityType: party.entityType,

            addresses: party.addresses
              .filter(
                (address) =>
                  address.addressLine1.trim() !== ""
              )
              .map((address) => ({
                addressType:
                  address.addressType,
                addressLine1:
                  address.addressLine1.trim(),
                addressLine2:
                  address.addressLine2.trim() ||
                  null,
                villageTown:
                  address.villageTown.trim() ||
                  null,
                district:
                  address.district.trim() ||
                  null,
                state:
                  address.state.trim() ||
                  null,
                pincode:
                  address.pincode.trim() ||
                  null,
              })),

            advocate:
              party.advocate.name.trim() !== ""
                ? {
                    name:
                      party.advocate.name.trim(),
                    enrollmentNo:
                      party.advocate.enrollmentNo.trim() ||
                      null,
                    phone:
                      party.advocate.phone.trim() ||
                      null,
                    email:
                      party.advocate.email.trim() ||
                      null,
                    address:
                      party.advocate.address.trim() ||
                      null,
                  }
                : null,
          })
        ),

        applicationFee: {
          amount: Number(fee.ddAmount),
          ddNumber: fee.ddNumber.trim(),
          ddDate: fee.ddDate,
          bankName: fee.ddBank.trim(),
          payee: "Chairman, DLSA",
        },
      };

      const response = await fetch(
        "/api/pim/received",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          result.message ||
            "Unable to save the application."
        );
      }

      setSavedCaseId(result.caseId);

      setMessage(
        "Received application saved successfully. No PIM number has been assigned yet."
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to save the application."
      );
    } finally {
      setSaving(false);
    }
  }

  function renderPartySection(
    type: "applicant" | "opponent",
    parties: Party[]
  ) {
    const isApplicant = type === "applicant";
    const title = isApplicant
      ? "Applicants"
      : "Opposite Parties";

    const addLabel = isApplicant
      ? "+ Add Applicant"
      : "+ Add Opposite Party";

    return (
      <section className="rounded-lg bg-white p-6 shadow">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {title}
          </h2>

          <button
            type="button"
            onClick={() => addParty(type)}
            className="rounded bg-black px-3 py-2 text-sm text-white hover:bg-gray-800"
          >
            {addLabel}
          </button>
        </div>

        <div className="space-y-6">
          {parties.map((party, partyIndex) => (
            <div
              key={partyIndex}
              className="rounded-lg border p-5"
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-semibold">
                  {isApplicant
                    ? `Applicant ${partyIndex + 1}`
                    : `Opposite Party ${
                        partyIndex + 1
                      }`}
                </h3>

                {parties.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      removeParty(
                        type,
                        partyIndex
                      )
                    }
                    className="text-sm text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium">
                    Name
                  </label>

                  <input
                    value={party.name}
                    onChange={(e) =>
                      updateParty(
                        type,
                        partyIndex,
                        "name",
                        e.target.value
                      )
                    }
                    className="mt-1 w-full rounded border p-2"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium">
                    Entity Type
                  </label>

                  <select
                    value={party.entityType}
                    onChange={(e) =>
                      updateParty(
                        type,
                        partyIndex,
                        "entityType",
                        e.target.value
                      )
                    }
                    className="mt-1 w-full rounded border p-2"
                  >
                    <option value="INDIVIDUAL">
                      Individual
                    </option>
                    <option value="COMPANY">
                      Company
                    </option>
                    <option value="FIRM">
                      Firm
                    </option>
                    <option value="LLP">
                      LLP
                    </option>
                    <option value="OTHER">
                      Other
                    </option>
                  </select>
                </div>
              </div>

              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h4 className="font-medium">
                    Postal Address(es)
                  </h4>

                  <button
                    type="button"
                    onClick={() =>
                      addAddress(
                        type,
                        partyIndex
                      )
                    }
                    className="text-sm font-medium text-blue-700 hover:underline"
                  >
                    + Add Address
                  </button>
                </div>

                <div className="space-y-4">
                  {party.addresses.map(
                    (address, addressIndex) => (
                      <div
                        key={addressIndex}
                        className="rounded border bg-gray-50 p-4"
                      >
                        <div className="mb-3 flex items-center justify-between">
                          <span className="text-sm font-medium">
                            Address{" "}
                            {addressIndex + 1}
                          </span>

                          {party.addresses
                            .length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                removeAddress(
                                  type,
                                  partyIndex,
                                  addressIndex
                                )
                              }
                              className="text-xs text-red-600 hover:underline"
                            >
                              Remove
                            </button>
                          )}
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                          <div>
                            <label className="block text-xs font-medium">
                              Address Type
                            </label>

                            <select
                              value={
                                address.addressType
                              }
                              onChange={(e) =>
                                updateAddress(
                                  type,
                                  partyIndex,
                                  addressIndex,
                                  "addressType",
                                  e.target.value
                                )
                              }
                              className="mt-1 w-full rounded border p-2 text-sm"
                            >
                              <option value="POSTAL">
                                Postal
                              </option>
                              <option value="REGISTERED_OFFICE">
                                Registered Office
                              </option>
                              <option value="ALTERNATE">
                                Alternate
                              </option>
                              <option value="OTHER">
                                Other
                              </option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-xs font-medium">
                              Pincode
                            </label>

                            <input
                              value={
                                address.pincode
                              }
                              onChange={(e) =>
                                updateAddress(
                                  type,
                                  partyIndex,
                                  addressIndex,
                                  "pincode",
                                  e.target.value
                                )
                              }
                              className="mt-1 w-full rounded border p-2 text-sm"
                            />
                          </div>
                        </div>

                        <input
                          value={
                            address.addressLine1
                          }
                          onChange={(e) =>
                            updateAddress(
                              type,
                              partyIndex,
                              addressIndex,
                              "addressLine1",
                              e.target.value
                            )
                          }
                          placeholder="Address Line 1"
                          className="mt-3 w-full rounded border p-2 text-sm"
                          required
                        />

                        <input
                          value={
                            address.addressLine2
                          }
                          onChange={(e) =>
                            updateAddress(
                              type,
                              partyIndex,
                              addressIndex,
                              "addressLine2",
                              e.target.value
                            )
                          }
                          placeholder="Address Line 2"
                          className="mt-3 w-full rounded border p-2 text-sm"
                        />

                        <div className="mt-3 grid gap-3 md:grid-cols-3">
                          <input
                            value={
                              address.villageTown
                            }
                            onChange={(e) =>
                              updateAddress(
                                type,
                                partyIndex,
                                addressIndex,
                                "villageTown",
                                e.target.value
                              )
                            }
                            placeholder="Village / Town"
                            className="rounded border p-2 text-sm"
                          />

                          <input
                            value={
                              address.district
                            }
                            onChange={(e) =>
                              updateAddress(
                                type,
                                partyIndex,
                                addressIndex,
                                "district",
                                e.target.value
                              )
                            }
                            placeholder="District"
                            className="rounded border p-2 text-sm"
                          />

                          <input
                            value={address.state}
                            onChange={(e) =>
                              updateAddress(
                                type,
                                partyIndex,
                                addressIndex,
                                "state",
                                e.target.value
                              )
                            }
                            placeholder="State"
                            className="rounded border p-2 text-sm"
                          />
                        </div>
                      </div>
                    )
                  )}
                </div>
              </div>

              <div className="mt-6">
                <h4 className="mb-3 font-medium">
                  Advocate
                </h4>

                <div className="rounded border bg-gray-50 p-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <input
                      value={party.advocate.name}
                      onChange={(e) =>
                        updateAdvocate(
                          type,
                          partyIndex,
                          "name",
                          e.target.value
                        )
                      }
                      placeholder="Advocate Name"
                      className="rounded border p-2 text-sm"
                    />

                    <input
                      value={
                        party.advocate.enrollmentNo
                      }
                      onChange={(e) =>
                        updateAdvocate(
                          type,
                          partyIndex,
                          "enrollmentNo",
                          e.target.value
                        )
                      }
                      placeholder="Enrollment Number"
                      className="rounded border p-2 text-sm"
                    />

                    <input
                      value={party.advocate.phone}
                      onChange={(e) =>
                        updateAdvocate(
                          type,
                          partyIndex,
                          "phone",
                          e.target.value
                        )
                      }
                      placeholder="Phone"
                      className="rounded border p-2 text-sm"
                    />

                    <input
                      value={party.advocate.email}
                      onChange={(e) =>
                        updateAdvocate(
                          type,
                          partyIndex,
                          "email",
                          e.target.value
                        )
                      }
                      placeholder="Email"
                      className="rounded border p-2 text-sm"
                    />
                  </div>

                  <textarea
                    value={party.advocate.address}
                    onChange={(e) =>
                      updateAdvocate(
                        type,
                        partyIndex,
                        "address",
                        e.target.value
                      )
                    }
                    placeholder="Advocate Address"
                    rows={2}
                    className="mt-3 w-full rounded border p-2 text-sm"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">
            New PIM Application
          </h1>

          <p className="mt-1 text-sm text-gray-600">
            DLSA Nilgiris — Pre-Institution Mediation
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-6"
        >
          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-4 text-lg font-semibold">
              Receipt
            </h2>

            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="block text-sm font-medium">
                  Received Number
                </label>

                <input
                  value={receipt.receivedNumber}
                  onChange={(e) =>
                    updateReceipt(
                      "receivedNumber",
                      e.target.value
                    )
                  }
                  className="mt-1 w-full rounded border p-2"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium">
                  Received Date
                </label>

                <input
                  type="date"
                  value={receipt.receivedDate}
                  onChange={(e) =>
                    updateReceipt(
                      "receivedDate",
                      e.target.value
                    )
                  }
                  className="mt-1 w-full rounded border p-2"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium">
                  Application Date
                </label>

                <input
                  type="date"
                  value={receipt.applicationDate}
                  onChange={(e) =>
                    updateReceipt(
                      "applicationDate",
                      e.target.value
                    )
                  }
                  className="mt-1 w-full rounded border p-2"
                  required
                />
              </div>
            </div>
          </section>

          {renderPartySection(
            "applicant",
            applicants
          )}

          {renderPartySection(
            "opponent",
            opponents
          )}

          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-4 text-lg font-semibold">
              Dispute
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium">
                  Claim Amount
                </label>

                <input
                  type="number"
                  min="300001"
                  value={dispute.claimAmount}
                  onChange={(e) =>
                    updateDispute(
                      "claimAmount",
                      e.target.value
                    )
                  }
                  placeholder="Above 300000 and below 10000000"
                  className="mt-1 w-full rounded border p-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium">
                  Nature / Description of Commercial Dispute
                </label>

                <textarea
                  value={dispute.description}
                  onChange={(e) =>
                    updateDispute(
                      "description",
                      e.target.value
                    )
                  }
                  rows={5}
                  className="mt-1 w-full rounded border p-2"
                />
              </div>
            </div>
          </section>

          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-4 text-lg font-semibold">
              Application Fee — ₹1,000
            </h2>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium">
                  DD Number
                </label>

                <input
                  value={fee.ddNumber}
                  onChange={(e) =>
                    updateFee(
                      "ddNumber",
                      e.target.value
                    )
                  }
                  className="mt-1 w-full rounded border p-2"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium">
                  DD Date
                </label>

                <input
                  type="date"
                  value={fee.ddDate}
                  onChange={(e) =>
                    updateFee(
                      "ddDate",
                      e.target.value
                    )
                  }
                  className="mt-1 w-full rounded border p-2"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium">
                  Bank
                </label>

                <input
                  value={fee.ddBank}
                  onChange={(e) =>
                    updateFee(
                      "ddBank",
                      e.target.value
                    )
                  }
                  className="mt-1 w-full rounded border p-2"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium">
                  Amount
                </label>

                <input
                  type="number"
                  min="1"
                  value={fee.ddAmount}
                  onChange={(e) =>
                    updateFee(
                      "ddAmount",
                      e.target.value
                    )
                  }
                  className="mt-1 w-full rounded border p-2"
                  required
                />
              </div>
            </div>

            <p className="mt-3 text-sm text-gray-500">
              Payee: Chairman, DLSA
            </p>
          </section>

          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-4 text-lg font-semibold">
              Documents
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium">
                  DD Memo
                </label>

                <input
                  id="ddMemo"
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  className="mt-1"
                />
              </div>

              <div>
                <label className="block text-sm font-medium">
                  Supporting Documents
                </label>

                <input
                  id="supportingDocuments"
                  type="file"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                  className="mt-1"
                />
              </div>
            </div>

            <p className="mt-3 text-xs text-gray-500">
              Document storage will be connected to the local
              PIM document folder in the next stage.
            </p>
          </section>

          {error && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              <strong>Error:</strong> {error}
            </div>
          )}

          {message && (
            <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-800">
              <strong>{message}</strong>

              {savedCaseId !== null && (
                <div className="mt-2">
                  Received Application ID:{" "}
                  <strong>{savedCaseId}</strong>
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg bg-white p-6 shadow">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium">
                  Initial Status: RECEIVED
                </p>

                <p className="mt-1 text-sm text-gray-600">
                  No PIM number will be assigned at this
                  stage. The application will go to scrutiny.
                </p>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="rounded bg-black px-6 py-3 font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving
                  ? "Saving..."
                  : "Save Received Application"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}

