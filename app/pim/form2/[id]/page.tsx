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
  is_current?: number;
};

type OppositeParty = {
  party_id: number;
  role: string;
  sequence_no: number;
  is_primary: number;
  name: string;
  entity_type: string;
  addresses: Address[];
  allAddresses: Address[];
};

type FinalNoticeCandidate = {
  service_attempt_id: number;
  return_reason: string | null;
  postal_endorsement: string | null;
  returned_date: string | null;
  notice_id: number;
  notice_type: string;
  notice_date: string;
  appearance_date: string | null;
  recipient_party_id: number;
  notice_address_id: number | null;
  recipient_name: string | null;
};

type Notice = {
  id: number;
  notice_type: string;
  form_no: string;
  notice_date: string;
  appearance_date: string | null;
  appearance_time: string | null;
  recipient_party_id: number | null;
  recipient_name: string | null;
  address_id: number | null;
  status: string;
  dispatch_date: string | null;
  document_id: number | null;
  document_title: string | null;
  document_date: string | null;
  document_has_file: number;
  document_version_no: number | null;
  document_is_current: number | null;
  document_created_at: string | null;
  remarks: string | null;
};

type CaseData = {
  id: number;
  pim_number: string | null;
  received_number: string | null;
  received_date: string;
  application_date: string;
  registration_date: string | null;
  claim_amount: number | null;
  dispute_description: string | null;
  status_code: string;
  status_name: string;
};

type Form2Data = {
  case: CaseData;
  oppositeParties: OppositeParty[];
  notices: Notice[];
  task: {
    id: number;
    status: string;
    due_date: string | null;
    description: string;
  } | null;
  finalNoticeCandidates: FinalNoticeCandidate[];
};

export default function Form2Page() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] =
    useState<Form2Data | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState("");

  const [success, setSuccess] =
    useState("");

  const [saving, setSaving] =
    useState(false);

  const [generatingNoticeId, setGeneratingNoticeId] =
    useState<number | null>(null);

  const [partyId, setPartyId] =
    useState("");

  const [addressId, setAddressId] =
    useState("");

  const [appearanceDate, setAppearanceDate] =
    useState("");

  const [appearanceTime, setAppearanceTime] =
    useState("");

  const [noticeType, setNoticeType] =
    useState<
      "FORM_2_INITIAL" | "FORM_2_FINAL"
    >("FORM_2_INITIAL");

  const [selectedCandidateId, setSelectedCandidateId] =
    useState<number | null>(null);

  const [remarks, setRemarks] =
    useState("");

  const [contactAffidavitReceived, setContactAffidavitReceived] =
    useState(false);

  const [contactAffidavitDate, setContactAffidavitDate] =
    useState("");

  const [dispatchMode, setDispatchMode] =
    useState("REGISTERED_POST");

  const [postalReceiptNo, setPostalReceiptNo] =
    useState("");

  const [trackingNo, setTrackingNo] =
    useState("");

  useEffect(() => {
    loadData();
  }, [id]);

  function applyCandidate(
    candidate: FinalNoticeCandidate,
    oppositeParties: OppositeParty[]
  ) {
    setSelectedCandidateId(
      candidate.service_attempt_id
    );

    setPartyId(
      String(candidate.recipient_party_id)
    );

    const party = oppositeParties?.find(
      (item) =>
        item.party_id ===
        candidate.recipient_party_id
    );

    // Prefer the exact address this notice's history used;
    // never silently fall back to "today's is_current" alone.
    const recommendedAddress =
      party?.allAddresses?.find(
        (address) =>
          address.id ===
          candidate.notice_address_id
      ) || party?.allAddresses?.[0];

    setAddressId(
      recommendedAddress
        ? String(recommendedAddress.id)
        : ""
    );
  }

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(
        `/api/pim/form2/${id}`,
        {
          cache: "no-store",
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
            "Unable to load Form-2 data."
        );
      }

      setData(json.data);

      const preparedNotice =
        json.data.notices?.find(
          (notice: Notice) =>
            notice.status === "PREPARED"
        );

      if (preparedNotice) {
        setPartyId(
          preparedNotice.recipient_party_id
            ? String(
                preparedNotice.recipient_party_id
              )
            : ""
        );

        setAppearanceDate(
          preparedNotice.appearance_date ||
            ""
        );

        setAppearanceTime(
          preparedNotice.appearance_time ||
            ""
        );

        setNoticeType(
          preparedNotice.notice_type ===
            "FORM_2_FINAL"
            ? "FORM_2_FINAL"
            : "FORM_2_INITIAL"
        );

        const party =
          json.data.oppositeParties?.find(
            (item: OppositeParty) =>
              item.party_id ===
              preparedNotice.recipient_party_id
          );

        if (
          preparedNotice.notice_type ===
          "FORM_2_FINAL"
        ) {
          // Reflect the exact address this Final Notice was
          // prepared with - it may not be the party's current
          // address, so don't default to addresses[0].
          const noticeAddress =
            party?.allAddresses?.find(
              (address: Address) =>
                address.id ===
                preparedNotice.address_id
            );

          setAddressId(
            noticeAddress
              ? String(noticeAddress.id)
              : preparedNotice.address_id
                ? String(preparedNotice.address_id)
                : ""
          );
        } else if (party?.addresses?.length) {
          setAddressId(
            String(
              party.addresses[0].id
            )
          );
        }
      } else if (
        json.data.case.status_code ===
        "FINAL_NOTICE_PENDING"
      ) {
        setNoticeType("FORM_2_FINAL");

        const candidates: FinalNoticeCandidate[] =
          json.data.finalNoticeCandidates || [];

        if (candidates.length === 1) {
          applyCandidate(
            candidates[0],
            json.data.oppositeParties
          );
        } else {
          // Ambiguous (none or multiple): require explicit staff selection.
          setSelectedCandidateId(null);
          setPartyId("");
          setAddressId("");
        }
      } else {
        setNoticeType("FORM_2_INITIAL");

        const firstParty =
          json.data.oppositeParties?.[0];

        if (firstParty) {
          setPartyId(
            String(firstParty.party_id)
          );

          const firstAddress =
            firstParty.addresses?.[0];

          if (firstAddress) {
            setAddressId(
              String(firstAddress.id)
            );
          }
        }
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load Form-2 data."
      );
    } finally {
      setLoading(false);
    }
  }

  const preparedNotice =
    data?.notices.find(
      (notice) =>
        notice.status === "PREPARED"
    );

  const selectedParty =
    data?.oppositeParties.find(
      (party) =>
        String(party.party_id) ===
        partyId
    );

  const isFinalNoticeMode =
    data?.case.status_code ===
    "FINAL_NOTICE_PENDING";

  const canPrepare =
    data?.case.status_code ===
      "FORM2_PENDING" ||
    isFinalNoticeMode;

  function handlePartyChange(
    value: string
  ) {
    setPartyId(value);
    setSelectedCandidateId(null);

    const party =
      data?.oppositeParties.find(
        (item) =>
          String(item.party_id) ===
          value
      );

    const firstAddress = isFinalNoticeMode
      ? party?.allAddresses?.[0]
      : party?.addresses?.[0];

    setAddressId(
      firstAddress
        ? String(firstAddress.id)
        : ""
    );
  }

  async function prepareForm2() {
    if (saving) return;

    setError("");
    setSuccess("");

    if (!partyId) {
      setError(
        "Select an opposite party."
      );
      return;
    }

    if (!addressId) {
      setError(
        "Select the service address."
      );
      return;
    }

    if (!appearanceDate) {
      setError(
        "Enter the appearance date."
      );
      return;
    }

    if (!appearanceTime) {
      setError(
        "Enter the appearance time."
      );
      return;
    }

    if (
      !confirm(
        "Prepare Form-2 for the selected opposite party?"
      )
    ) {
      return;
    }

    try {
      setSaving(true);

      const response = await fetch(
        `/api/pim/form2/${id}`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            partyId: Number(partyId),
            addressId: Number(addressId),
            appearanceDate,
            appearanceTime,
            noticeType,
            remarks:
              remarks.trim() || null,
            contactAffidavitReceived,
            contactAffidavitDate:
              contactAffidavitReceived
                ? contactAffidavitDate || null
                : null,
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
            "Unable to prepare Form-2."
        );
      }

      setSuccess(
        `Form-2 prepared successfully for ${
          selectedParty?.name ||
          "the opposite party"
        }. Notice ID: ${
          json.data.noticeId
        }`
      );

      setRemarks("");
      setContactAffidavitReceived(false);
      setContactAffidavitDate("");

      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to prepare Form-2."
      );
    } finally {
      setSaving(false);
    }
  }

  async function generateForm2(
    notice: Notice,
    regenerate = false
  ) {
    if (saving || generatingNoticeId) return;

    if (
      regenerate &&
      !confirm(
        "Regenerate Form-2 and create the next document version?"
      )
    ) {
      return;
    }

    try {
      setGeneratingNoticeId(notice.id);
      setError("");
      setSuccess("");

      const response = await fetch(
        `/api/pim/documents/form2/${notice.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            regenerate,
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
            "Unable to generate Form-2."
        );
      }

      setSuccess(
        `${json.data.reused ? "Current Form-2 document reused" : "Form-2 document generated"}. Document ID: ${json.data.document.id}`
      );

      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to generate Form-2."
      );
    } finally {
      setGeneratingNoticeId(null);
    }
  }

  async function issueForm2() {
    if (saving) return;

    if (!preparedNotice) {
      setError(
        "No prepared Form-2 notice is available."
      );
      return;
    }

    if (!addressId) {
      setError(
        "Select the service address."
      );
      return;
    }

    if (!confirm(
      "Issue and dispatch this Form-2 notice?"
    )) {
      return;
    }

    try {
      setSaving(true);
      setError("");
      setSuccess("");

      const response = await fetch(
        `/api/pim/form2/issue/${id}`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            noticeId:
              preparedNotice.id,
            addressId: Number(
              addressId
            ),
            dispatchMode,
            postalReceiptNo:
              postalReceiptNo.trim() ||
              null,
            trackingNo:
              trackingNo.trim() ||
              null,
            remarks:
              remarks.trim() || null,
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
            "Unable to issue Form-2."
        );
      }

      setSuccess(
        `Form-2 issued successfully. Service attempt ID: ${json.data.serviceAttemptId}`
      );

      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to issue Form-2."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          Loading Form-2...
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          <p className="text-red-700">
            {error ||
              "Unable to load case."}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">

        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <h1 className="text-2xl font-bold">
                Form-2 Preparation
              </h1>

              <p className="mt-1 text-sm text-gray-600">
                PIM Number:{" "}
                <strong>
                  {data.case.pim_number ||
                    "Not assigned"}
                </strong>
              </p>

              <p className="text-sm text-gray-600">
                Received Number:{" "}
                {data.case.received_number ||
                  "-"}
              </p>
            </div>

            <div className="rounded bg-yellow-100 px-4 py-2 text-sm font-semibold text-yellow-800">
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
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Application Details
          </h2>

          <div className="grid gap-5 md:grid-cols-4">
            <Info
              label="PIM Number"
              value={
                data.case.pim_number ||
                "-"
              }
            />

            <Info
              label="Registration Date"
              value={
                data.case.registration_date ||
                "-"
              }
            />

            <Info
              label="Received Number"
              value={
                data.case.received_number ||
                "-"
              }
            />

            <Info
              label="Claim Amount"
              value={
                data.case.claim_amount !==
                null
                  ? `₹${Number(
                      data.case.claim_amount
                    ).toLocaleString(
                      "en-IN"
                    )}`
                  : "-"
              }
            />
          </div>
        </section>

        {data.notices.length > 0 && (
          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-5 text-lg font-semibold">
              Form-2 Notices
            </h2>

            <div className="space-y-3">
              {data.notices.map(
                (notice) => (
                  <div
                    key={notice.id}
                    className="rounded border p-4"
                  >
                    <div className="flex flex-col justify-between gap-4 md:flex-row">
                      <div>
                        <p className="font-semibold">
                          {notice.form_no}
                        </p>

                        <p className="text-sm text-gray-600">
                          Recipient:{" "}
                          {notice.recipient_name ||
                            "-"}
                        </p>

                        <p className="text-sm text-gray-600">
                          Appearance:{" "}
                          {notice.appearance_date ||
                            "-"}{" "}
                          {notice.appearance_time ||
                            ""}
                        </p>

                        <p className="text-sm text-gray-600">
                          Notice date:{" "}
                          {notice.notice_date}
                        </p>

                        {notice.dispatch_date && (
                          <p className="text-sm text-gray-600">
                            Dispatch date:{" "}
                            {notice.dispatch_date}
                          </p>
                        )}

                        {notice.document_id &&
                          notice.document_has_file ===
                            1 && (
                            <div className="mt-3 rounded border bg-gray-50 p-3 text-sm">
                              <p className="font-medium text-gray-900">
                                {notice.document_title ||
                                  "Form-2 Notice"}
                              </p>

                              <p className="mt-1 text-gray-600">
                                Version{" "}
                                {notice.document_version_no ||
                                  "-"}{" "}
                                · Date{" "}
                                {notice.document_date ||
                                  "-"}
                              </p>

                              <div className="mt-2 flex flex-wrap gap-3">
                                <a
                                  href={`/api/pim/documents/download/${data.case.id}/${notice.document_id}`}
                                  className="font-medium text-blue-700 underline"
                                >
                                  View / Download
                                </a>

                                <button
                                  type="button"
                                  onClick={() =>
                                    generateForm2(
                                      notice,
                                      true
                                    )
                                  }
                                  disabled={
                                    generatingNoticeId ===
                                    notice.id
                                  }
                                  className="font-medium text-gray-700 underline disabled:opacity-50"
                                >
                                  Regenerate
                                </button>
                              </div>
                            </div>
                          )}
                      </div>

                      <div className="flex flex-col items-start gap-3 md:items-end">
                        <span
                          className={`h-fit rounded px-3 py-1 text-xs font-semibold ${
                            notice.status ===
                            "PREPARED"
                              ? "bg-yellow-100 text-yellow-800"
                              : notice.status ===
                                  "DISPATCHED"
                                ? "bg-green-100 text-green-800"
                                : "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {notice.status}
                        </span>

                        {notice.document_has_file !==
                          1 && (
                          <button
                            type="button"
                            onClick={() =>
                              generateForm2(
                                notice
                              )
                            }
                            disabled={
                              generatingNoticeId ===
                              notice.id
                            }
                            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                          >
                            {generatingNoticeId ===
                            notice.id
                              ? "Generating..."
                              : "Generate Form-2"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          </section>
        )}

        {canPrepare &&
          !preparedNotice && (
            <section className="rounded-lg bg-white p-6 shadow">
              <h2 className="mb-5 text-lg font-semibold">
                {isFinalNoticeMode
                  ? "Prepare Final Notice"
                  : "Prepare Form-2"}
              </h2>

              {isFinalNoticeMode && (
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-gray-700">
                    Why this case reached Final Notice
                  </h3>

                  {data.finalNoticeCandidates.length === 0 && (
                    <p className="mt-2 text-sm text-gray-500">
                      No outstanding returned notice was found.
                      Select the opposite party and address
                      manually below.
                    </p>
                  )}

                  {data.finalNoticeCandidates.length > 1 && (
                    <p className="mt-2 text-sm text-amber-700">
                      Multiple returned notices were found.
                      Select the one this Final Notice applies to.
                    </p>
                  )}

                  <div className="mt-3 space-y-3">
                    {data.finalNoticeCandidates.map(
                      (candidate) => (
                        <button
                          key={
                            candidate.service_attempt_id
                          }
                          type="button"
                          onClick={() =>
                            applyCandidate(
                              candidate,
                              data.oppositeParties
                            )
                          }
                          className={`block w-full rounded border p-4 text-left ${
                            selectedCandidateId ===
                            candidate.service_attempt_id
                              ? "border-black"
                              : "border-gray-200"
                          }`}
                        >
                          <div className="flex flex-wrap justify-between gap-2">
                            <span className="font-semibold">
                              {candidate.recipient_name ||
                                "Opposite party"}
                            </span>
                            <span className="text-xs text-gray-500">
                              Notice #{candidate.notice_id}
                            </span>
                          </div>

                          <p className="mt-1 text-sm text-gray-600">
                            Postal Return Reason:{" "}
                            <strong>
                              {candidate.return_reason ||
                                "-"}
                            </strong>
                          </p>

                          <p className="text-sm text-gray-600">
                            Prior Notice Date:{" "}
                            {candidate.notice_date} · Prior
                            Appearance:{" "}
                            {candidate.appearance_date || "-"}
                          </p>

                          <p className="text-sm text-gray-600">
                            Returned Date:{" "}
                            {candidate.returned_date || "-"}
                          </p>
                        </button>
                      )
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-6">

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Opposite Party
                  </label>

                  <select
                    value={partyId}
                    onChange={(event) =>
                      handlePartyChange(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                  >
                    <option value="">
                      Select opposite party
                    </option>

                    {data.oppositeParties.map(
                      (party) => (
                        <option
                          key={
                            party.party_id
                          }
                          value={
                            party.party_id
                          }
                        >
                          {party.sequence_no}.{" "}
                          {party.name}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Service Address
                    {isFinalNoticeMode && (
                      <span className="ml-2 font-normal text-gray-400">
                        (any address on record — pick the
                        intended one)
                      </span>
                    )}
                  </label>

                  <select
                    value={addressId}
                    onChange={(event) =>
                      setAddressId(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                  >
                    <option value="">
                      Select address
                    </option>

                    {(isFinalNoticeMode
                      ? selectedParty?.allAddresses
                      : selectedParty?.addresses
                    )?.map(
                      (address) => (
                        <option
                          key={address.id}
                          value={
                            address.id
                          }
                        >
                          {
                            address.address_type
                          }{" "}
                          —{" "}
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
                          {!address.is_current
                            ? " (superseded)"
                            : ""}
                        </option>
                      )
                    )}
                  </select>
                </div>

                {isFinalNoticeMode ? (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Notice Type
                    </label>
                    <p className="mt-2 rounded border bg-gray-50 p-3 text-sm text-gray-700">
                      Final Notice (Form-2)
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Notice Type
                    </label>

                    <select
                      value={noticeType}
                      onChange={(event) =>
                        setNoticeType(
                          event.target
                            .value as
                            | "FORM_2_INITIAL"
                            | "FORM_2_FINAL"
                        )
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    >
                      <option value="FORM_2_INITIAL">
                        Form-2 Initial Notice
                      </option>
                    </select>
                  </div>
                )}

                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Appearance Date
                    </label>

                    <input
                      type="date"
                      value={
                        appearanceDate
                      }
                      onChange={(event) =>
                        setAppearanceDate(
                          event.target.value
                        )
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Appearance Time
                    </label>

                    <input
                      type="time"
                      value={
                        appearanceTime
                      }
                      onChange={(event) =>
                        setAppearanceTime(
                          event.target.value
                        )
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                    <input
                      type="checkbox"
                      checked={
                        contactAffidavitReceived
                      }
                      onChange={(event) => {
                        const checked =
                          event.target.checked;
                        setContactAffidavitReceived(
                          checked
                        );
                        if (!checked) {
                          setContactAffidavitDate(
                            ""
                          );
                        }
                      }}
                    />
                    Applicant&apos;s contact-particulars affidavit received
                    (SOP clause 5(a))
                  </label>

                  <p className="mt-1 text-xs text-gray-500">
                    Confirms the applicant has affirmed the opposite
                    party&apos;s postal address, phone/mobile number and
                    email ID used for this notice are correct and have
                    been in use during the preceding 30 days. Leave
                    unchecked unless the affidavit has actually been
                    received for this notice.
                  </p>

                  {contactAffidavitReceived && (
                    <input
                      type="date"
                      value={
                        contactAffidavitDate
                      }
                      onChange={(event) =>
                        setContactAffidavitDate(
                          event.target.value
                        )
                      }
                      className="mt-2 w-full max-w-xs rounded border p-3 text-sm"
                    />
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Remarks
                  </label>

                  <textarea
                    rows={3}
                    value={remarks}
                    onChange={(event) =>
                      setRemarks(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                    placeholder="Optional remarks."
                  />
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={
                      prepareForm2
                    }
                    disabled={saving}
                    className="rounded bg-black px-6 py-3 font-medium text-white disabled:opacity-50"
                  >
                    {saving
                      ? "Preparing..."
                      : "Prepare Form-2"}
                  </button>
                </div>
              </div>
            </section>
          )}

        {preparedNotice && (
          <section className="rounded-lg border border-yellow-300 bg-yellow-50 p-6 shadow">
            <h2 className="text-lg font-semibold">
              Review & Issue Form-2
            </h2>

            <p className="mt-1 text-sm text-gray-700">
              The Form-2 notice has been prepared.
              Review the details before recording
              its issue and dispatch.
            </p>

            <div className="mt-5 grid gap-5 md:grid-cols-3">
              <Info
                label="Recipient"
                value={
                  preparedNotice.recipient_name ||
                  "-"
                }
              />

              <Info
                label="Appearance Date"
                value={
                  preparedNotice.appearance_date ||
                  "-"
                }
              />

              <Info
                label="Appearance Time"
                value={
                  preparedNotice.appearance_time ||
                  "-"
                }
              />
            </div>

            <div className="mt-5 rounded border bg-white p-4">
              {preparedNotice.document_id &&
              preparedNotice.document_has_file ===
                1 ? (
                <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
                  <div>
                    <p className="font-medium">
                      {preparedNotice.document_title ||
                        "Form-2 Notice"}
                    </p>

                    <p className="mt-1 text-sm text-gray-600">
                      Version{" "}
                      {preparedNotice.document_version_no ||
                        "-"}{" "}
                      · Date{" "}
                      {preparedNotice.document_date ||
                        "-"}
                    </p>
                  </div>

                  <a
                    href={`/api/pim/documents/download/${data.case.id}/${preparedNotice.document_id}`}
                    className="font-medium text-blue-700 underline"
                  >
                    View / Download
                  </a>
                </div>
              ) : (
                <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
                  <p className="text-sm text-gray-700">
                    Generate the official Form-2 document before issue and dispatch.
                  </p>

                  <button
                    type="button"
                    onClick={() =>
                      generateForm2(
                        preparedNotice
                      )
                    }
                    disabled={
                      generatingNoticeId ===
                      preparedNotice.id
                    }
                    className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {generatingNoticeId ===
                    preparedNotice.id
                      ? "Generating..."
                      : "Generate Form-2"}
                  </button>
                </div>
              )}
            </div>

            <div className="mt-6 border-t pt-6">
              <h3 className="font-semibold">
                Dispatch Details
              </h3>

              <div className="mt-4 grid gap-5 md:grid-cols-3">

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Dispatch Mode
                  </label>

                  <select
                    value={
                      dispatchMode
                    }
                    onChange={(event) =>
                      setDispatchMode(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                  >
                    <option value="REGISTERED_POST">
                      Registered Post
                    </option>

                    <option value="SPEED_POST">
                      Speed Post
                    </option>

                    <option value="EMAIL">
                      Email
                    </option>

                    <option value="WHATSAPP">
                      WhatsApp
                    </option>

                    <option value="HAND_DELIVERY">
                      Hand Delivery
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Postal Receipt No.
                  </label>

                  <input
                    value={
                      postalReceiptNo
                    }
                    onChange={(event) =>
                      setPostalReceiptNo(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                    placeholder="Optional"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Tracking No.
                  </label>

                  <input
                    value={trackingNo}
                    onChange={(event) =>
                      setTrackingNo(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                    placeholder="Optional"
                  />
                </div>
              </div>

              <div className="mt-5">
                <label className="block text-sm font-medium text-gray-700">
                  Remarks
                </label>

                <textarea
                  rows={3}
                  value={remarks}
                  onChange={(event) =>
                    setRemarks(
                      event.target.value
                    )
                  }
                  className="mt-2 w-full rounded border p-3 text-sm"
                  placeholder="Optional dispatch remarks."
                />
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={issueForm2}
                  disabled={
                    saving ||
                    preparedNotice.document_has_file !==
                      1
                  }
                  className="rounded bg-black px-6 py-3 font-medium text-white disabled:opacity-50"
                >
                  {saving
                    ? "Issuing..."
                    : "Issue & Dispatch Form-2"}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">
            Workflow
          </h2>

          <div className="grid gap-3 md:grid-cols-4">
            <WorkflowStep
              number="1"
              label="PIM Registered"
              active={false}
              done
            />

            <WorkflowStep
              number="2"
              label="Form-2 Pending"
              active={
                data.case.status_code ===
                "FORM2_PENDING"
              }
              done={
                data.case.status_code !==
                  "FORM2_PENDING" &&
                data.case.status_code !==
                  "REGISTERED"
              }
            />

            <WorkflowStep
              number="3"
              label="Form-2 Issued"
              active={
                data.case.status_code ===
                "FORM2_ISSUED"
              }
              done={
                data.case.status_code ===
                  "SERVICE_PENDING"
              }
            />

            <WorkflowStep
              number="4"
              label="Service Pending"
              active={
                data.case.status_code ===
                "SERVICE_PENDING"
              }
              done={false}
            />
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

      <p className="mt-1 text-sm font-medium text-gray-900">
        {value}
      </p>
    </div>
  );
}

function WorkflowStep({
  number,
  label,
  active,
  done,
}: {
  number: string;
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <div
      className={`rounded border p-4 ${
        active
          ? "border-yellow-300 bg-yellow-50"
          : done
            ? "border-green-300 bg-green-50"
            : "bg-gray-50"
      }`}
    >
      <div className="text-xs font-medium text-gray-500">
        Step {number}
      </div>

      <div className="mt-1 font-semibold">
        {label}
      </div>

      <div className="mt-1 text-xs text-gray-600">
        {done
          ? "Completed"
          : active
            ? "Current"
            : "Pending"}
      </div>
    </div>
  );
}
