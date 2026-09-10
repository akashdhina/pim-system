"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Notice = {
  notice_id: number;
  notice_type: string;
  notice_date: string;
  appearance_date: string | null;
  appearance_time: string | null;
  notice_status: string;
  service_attempt_id: number | null;
  dispatch_date: string | null;
  tracking_no: string | null;
  tracking_status: string | null;
  postal_endorsement: string | null;
  delivered_date: string | null;
  returned_date: string | null;
  service_remarks: string | null;
};

type Party = {
  case_party_id: number;
  party_id: number;
  name: string;
  entity_type: string;
  role: string;
  sequence_no: number;
  is_primary: number;
  notices: Notice[];
};

type ResponseRecord = {
  id: number;
  party_id: number;
  party_name: string;
  notice_type: string | null;
  response_date: string;
  appearance_mode: string | null;
  response_type: string;
  time_requested_until: string | null;
  consent: number | null;
  mediation_fee_requested: number | null;
  remarks: string | null;
};

type CaseData = {
  id: number;
  pim_number: string | null;
  received_number: string | null;
  registration_date: string | null;
  claim_amount: number | null;
  status_code: string;
  status_name: string;
};

type PageData = {
  case: CaseData;
  oppositeParties: Party[];
  responses: ResponseRecord[];
  today: string;
  maxAlternateDate: string;
};

function noticeLabel(noticeType: string) {
  return noticeType === "FORM_2_FINAL" ? "Final Notice" : "Initial Notice";
}

function serviceEvidenceText(notice: Notice) {
  if (notice.delivered_date) {
    return notice.postal_endorsement &&
      /ack|acknowledg/i.test(notice.postal_endorsement)
      ? `Delivered ${notice.delivered_date} - physical acknowledgment recorded.`
      : `Delivered ${notice.delivered_date} as per tracking (${notice.tracking_status || notice.tracking_no || "India Post"}); physical acknowledgment card not separately recorded.`;
  }

  if (notice.returned_date) {
    return `Returned ${notice.returned_date}.`;
  }

  if (notice.dispatch_date) {
    return `Dispatched ${notice.dispatch_date}; delivery not yet recorded.`;
  }

  return "No service attempt recorded.";
}

export default function ResponsePage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] =
    useState<PageData | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [error, setError] =
    useState("");

  const [success, setSuccess] =
    useState("");

  const [partyId, setPartyId] =
    useState("");

  const [noticeId, setNoticeId] =
    useState("");

  const [responseDate, setResponseDate] =
    useState(
      new Date()
        .toISOString()
        .slice(0, 10)
    );

  const [appearanceMode, setAppearanceMode] =
    useState("IN_PERSON");

  const [responseType, setResponseType] =
    useState("APPEARED");

  const [timeRequestedUntil, setTimeRequestedUntil] =
    useState("");

  const [consent, setConsent] =
    useState("");

  const [mediationFeeRequested, setMediationFeeRequested] =
    useState("");

  const [remarks, setRemarks] =
    useState("");

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(
        `/api/pim/response/${id}`,
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
            "Unable to load OP response data."
        );
      }

      setData(json.data);

      if (
        json.data.oppositeParties.length &&
        !partyId
      ) {
        const firstParty =
          json.data.oppositeParties[0];

        setPartyId(String(firstParty.party_id));

        if (firstParty.notices?.length) {
          setNoticeId(
            String(firstParty.notices[0].notice_id)
          );
        }
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load OP response data."
      );
    } finally {
      setLoading(false);
    }
  }

  async function saveResponse() {
    if (saving) return;

    setError("");
    setSuccess("");

    if (!partyId) {
      setError(
        "Select the opposite party."
      );
      return;
    }

    if (!noticeId) {
      setError(
        "Select the specific notice this response relates to."
      );
      return;
    }

    if (!responseDate) {
      setError(
        "Response date is required."
      );
      return;
    }

    if (
      responseType ===
        "SOUGHT_TIME" &&
      !timeRequestedUntil
    ) {
      setError(
        "Alternate appearance date is required when time is sought."
      );
      return;
    }

    if (
      responseType === "SOUGHT_TIME" &&
      data &&
      timeRequestedUntil > data.maxAlternateDate
    ) {
      setError(
        `Alternate date cannot be later than ${data.maxAlternateDate} (10 days from today).`
      );
      return;
    }

    if (
      responseType ===
        "APPEARED" &&
      consent === ""
    ) {
      setError(
        "Record whether the opposite party consented to mediation."
      );
      return;
    }

    if (
      responseType === "DID_NOT_APPEAR" &&
      selectedThresholdDate &&
      data &&
      data.today < selectedThresholdDate
    ) {
      setError(
        `Absence cannot be recorded before ${selectedThresholdDate}.`
      );
      return;
    }

    if (
      !confirm(
        "Record this opposite party response?"
      )
    ) {
      return;
    }

    try {
      setSaving(true);

      const response =
        await fetch(
          `/api/pim/response/${id}`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              partyId: Number(
                partyId
              ),
              noticeId: Number(
                noticeId
              ),
              responseDate,
              appearanceMode,
              responseType,
              timeRequestedUntil:
                responseType ===
                "SOUGHT_TIME"
                  ? timeRequestedUntil
                  : null,
              consent:
                responseType ===
                "APPEARED"
                  ? Number(consent)
                  : null,
              mediationFeeRequested:
                responseType ===
                "APPEARED" &&
                mediationFeeRequested !==
                  ""
                  ? Number(
                      mediationFeeRequested
                    )
                  : null,
              remarks:
                remarks.trim() ||
                null,
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
            "Unable to save response."
        );
      }

      setSuccess(
        json.message
      );

      setRemarks("");

      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to save response."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          Loading OP response...
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          {error ||
            "Unable to load case."}
        </div>
      </main>
    );
  }

  const canRecord =
    data.case.status_code === "SERVICE_PENDING" ||
    data.case.status_code === "OP_APPEARANCE_PENDING";

  const onAlternateDate =
    data.case.status_code === "OP_APPEARANCE_PENDING";

  const selectedParty = data.oppositeParties.find(
    (party) => String(party.party_id) === partyId
  );

  const selectedNotice = selectedParty?.notices.find(
    (notice) => String(notice.notice_id) === noticeId
  );

  const selectedThresholdDate = onAlternateDate
    ? data.responses.find(
        (response) =>
          response.party_id === selectedParty?.party_id &&
          response.response_type === "SOUGHT_TIME"
      )?.time_requested_until || null
    : selectedNotice?.appearance_date || null;

  const availableResponseTypes = onAlternateDate
    ? ["APPEARED", "REFUSED", "DID_NOT_APPEAR"]
    : ["APPEARED", "SOUGHT_TIME", "REFUSED", "DID_NOT_APPEAR"];

  function handlePartyChange(value: string) {
    setPartyId(value);

    const party = data?.oppositeParties.find(
      (item) => String(item.party_id) === value
    );

    setNoticeId(
      party?.notices?.length
        ? String(party.notices[0].notice_id)
        : ""
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">

        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row">
            <div>
              <h1 className="text-2xl font-bold">
                Opposite Party Response
              </h1>

              <p className="mt-1 text-sm text-gray-600">
                PIM Number:{" "}
                <strong>
                  {data.case.pim_number ||
                    "-"}
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
            Case Details
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

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Record OP Response
          </h2>

          {!canRecord ? (
            <div className="rounded border border-gray-300 bg-gray-50 p-4 text-sm text-gray-700">
              This case is not currently
              available for recording an OP
              response.
            </div>
          ) : (
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
                  Notice
                </label>

                <select
                  value={noticeId}
                  onChange={(event) =>
                    setNoticeId(
                      event.target.value
                    )
                  }
                  className="mt-2 w-full rounded border p-3 text-sm"
                >
                  <option value="">
                    Select the issued notice
                  </option>

                  {selectedParty?.notices.map(
                    (notice) => (
                      <option
                        key={notice.notice_id}
                        value={notice.notice_id}
                      >
                        {noticeLabel(notice.notice_type)} · Notice #
                        {notice.notice_id} · Appearance:{" "}
                        {notice.appearance_date || "-"}
                      </option>
                    )
                  )}
                </select>

                {selectedParty &&
                  selectedParty.notices.length === 0 && (
                    <p className="mt-2 text-sm text-amber-700">
                      No issued (dispatched/served) notice was
                      found for this opposite party.
                    </p>
                  )}
              </div>

              {selectedNotice && (
                <div className="rounded border bg-gray-50 p-4 text-sm">
                  <p className="font-medium text-gray-900">
                    {noticeLabel(selectedNotice.notice_type)}{" "}
                    &middot; Appearance Date:{" "}
                    {selectedNotice.appearance_date || "-"}{" "}
                    {selectedNotice.appearance_time || ""}
                  </p>
                  <p className="mt-1 text-gray-700">
                    Service evidence:{" "}
                    {serviceEvidenceText(selectedNotice)}
                  </p>
                  {onAlternateDate && (
                    <p className="mt-1 text-gray-700">
                      Alternate appearance date on record:{" "}
                      {selectedThresholdDate || "-"}
                    </p>
                  )}
                </div>
              )}

              <div className="grid gap-5 md:grid-cols-3">

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Response Date
                  </label>

                  <input
                    type="date"
                    value={
                      responseDate
                    }
                    onChange={(event) =>
                      setResponseDate(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Appearance Mode
                  </label>

                  <select
                    value={
                      appearanceMode
                    }
                    onChange={(event) =>
                      setAppearanceMode(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                  >
                    <option value="IN_PERSON">
                      In Person
                    </option>

                    <option value="ONLINE">
                      Online
                    </option>

                    <option value="REPRESENTATIVE">
                      Through Representative
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Response
                  </label>

                  <select
                    value={
                      responseType
                    }
                    onChange={(event) => {
                      setResponseType(
                        event.target.value
                      );

                      if (
                        event.target.value !==
                        "SOUGHT_TIME"
                      ) {
                        setTimeRequestedUntil(
                          ""
                        );
                      }

                      if (
                        event.target.value !==
                        "APPEARED"
                      ) {
                        setConsent("");
                        setMediationFeeRequested(
                          ""
                        );
                      }
                    }}
                    className="mt-2 w-full rounded border p-3 text-sm"
                  >
                    {availableResponseTypes.includes(
                      "APPEARED"
                    ) && (
                      <option value="APPEARED">
                        Appeared
                      </option>
                    )}

                    {availableResponseTypes.includes(
                      "SOUGHT_TIME"
                    ) && (
                      <option value="SOUGHT_TIME">
                        Sought Time
                      </option>
                    )}

                    {availableResponseTypes.includes(
                      "REFUSED"
                    ) && (
                      <option value="REFUSED">
                        Refused Mediation
                      </option>
                    )}

                    {availableResponseTypes.includes(
                      "DID_NOT_APPEAR"
                    ) && (
                      <option value="DID_NOT_APPEAR">
                        Did Not Appear / No Response
                      </option>
                    )}
                  </select>
                </div>
              </div>

              {responseType ===
                "SOUGHT_TIME" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Alternate Appearance Date
                  </label>

                  <input
                    type="date"
                    max={data.maxAlternateDate}
                    value={
                      timeRequestedUntil
                    }
                    onChange={(event) =>
                      setTimeRequestedUntil(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                  />

                  <p className="mt-1 text-xs text-gray-500">
                    Maximum permissible alternate date:{" "}
                    {data.maxAlternateDate} (10 days from
                    today). An earlier date is fine - 7 days is
                    not a mandatory default.
                  </p>
                </div>
              )}

              {responseType ===
                "DID_NOT_APPEAR" &&
                selectedThresholdDate &&
                data.today < selectedThresholdDate && (
                  <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">
                    Absence cannot be recorded before{" "}
                    {selectedThresholdDate}.
                  </div>
                )}

              {responseType ===
                "APPEARED" && (
                <div className="grid gap-5 md:grid-cols-2">

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Consent to Mediation
                    </label>

                    <select
                      value={consent}
                      onChange={(event) =>
                        setConsent(
                          event.target.value
                        )
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    >
                      <option value="">
                        Select
                      </option>

                      <option value="1">
                        Consented
                      </option>

                      <option value="0">
                        Refused
                      </option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Mediation Fee Requested
                    </label>

                    <select
                      value={
                        mediationFeeRequested
                      }
                      onChange={(event) =>
                        setMediationFeeRequested(
                          event.target.value
                        )
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    >
                      <option value="">
                        Not recorded
                      </option>

                      <option value="1">
                        Yes
                      </option>

                      <option value="0">
                        No
                      </option>
                    </select>
                  </div>

                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Remarks
                </label>

                <textarea
                  rows={4}
                  value={remarks}
                  onChange={(event) =>
                    setRemarks(
                      event.target.value
                    )
                  }
                  className="mt-2 w-full rounded border p-3 text-sm"
                  placeholder="Record relevant proceedings remarks."
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={
                    saveResponse
                  }
                  disabled={
                    saving ||
                    !noticeId ||
                    (responseType ===
                      "DID_NOT_APPEAR" &&
                      Boolean(
                        selectedThresholdDate &&
                          data.today <
                            selectedThresholdDate
                      ))
                  }
                  className="rounded bg-black px-6 py-3 font-medium text-white disabled:opacity-50"
                >
                  {saving
                    ? "Saving..."
                    : "Record OP Response"}
                </button>
              </div>
            </div>
          )}
        </section>

        {data.responses.length > 0 && (
          <section className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-5 text-lg font-semibold">
              Response History
            </h2>

            <div className="space-y-4">
              {data.responses.map(
                (response) => (
                  <div
                    key={response.id}
                    className="rounded border p-4"
                  >
                    <div className="grid gap-4 md:grid-cols-4">
                      <Info
                        label="Party"
                        value={`${response.party_name}${
                          response.notice_type
                            ? ` (${noticeLabel(
                                response.notice_type
                              )})`
                            : ""
                        }`}
                      />

                      <Info
                        label="Date"
                        value={
                          response.response_date
                        }
                      />

                      <Info
                        label="Response"
                        value={
                          response.response_type
                        }
                      />

                      <Info
                        label="Appearance Mode"
                        value={
                          response.appearance_mode ||
                          "-"
                        }
                      />
                    </div>

                    {response.time_requested_until && (
                      <p className="mt-3 text-sm text-gray-700">
                        Time requested until:{" "}
                        {
                          response.time_requested_until
                        }
                      </p>
                    )}

                    {response.consent !==
                      null && (
                      <p className="mt-2 text-sm text-gray-700">
                        Mediation consent:{" "}
                        {response.consent ===
                        1
                          ? "Consented"
                          : "Refused"}
                      </p>
                    )}

                    {response.mediation_fee_requested !==
                      null && (
                      <p className="mt-2 text-sm text-gray-700">
                        Mediation fee requested:{" "}
                        {response.mediation_fee_requested ===
                        1
                          ? "Yes"
                          : "No"}
                      </p>
                    )}

                    {response.remarks && (
                      <p className="mt-3 text-sm text-gray-700">
                        Remarks:{" "}
                        {response.remarks}
                      </p>
                    )}
                  </div>
                )
              )}
            </div>
          </section>
        )}

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">
            Workflow
          </h2>

          <div className="grid gap-3 md:grid-cols-5">

            <WorkflowStep
              number="1"
              label="PIM Registered"
              done
            />

            <WorkflowStep
              number="2"
              label="Form-2 Pending"
              done
            />

            <WorkflowStep
              number="3"
              label="Form-2 Issued"
              done
            />

            <WorkflowStep
              number="4"
              label="Service Completed"
              done
            />

            <WorkflowStep
              number="5"
              label="OP Response"
              active={
                data.case.status_code ===
                "SERVICE_PENDING"
              }
              done={
                data.case.status_code !==
                "SERVICE_PENDING"
              }
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
  active = false,
  done = false,
}: {
  number: string;
  label: string;
  active?: boolean;
  done?: boolean;
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