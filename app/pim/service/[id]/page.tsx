"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type ServiceAttempt = {
  id: number;
  notice_id: number;
  address_id: number | null;
  dispatch_mode: string;
  dispatch_date: string | null;
  postal_receipt_no: string | null;
  tracking_no: string | null;
  tracking_status: string | null;
  postal_endorsement: string | null;
  delivered_date: string | null;
  returned_date: string | null;
  proof_document_id: number | null;
  remarks: string | null;

  notice_type: string;
  form_no: string;
  notice_date: string;
  appearance_date: string | null;
  appearance_time: string | null;
  notice_status: string;
  recipient_name: string | null;

  address_type: string | null;
  address_line1: string | null;
  address_line2: string | null;
  village_town: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
};

type Notice = {
  id: number;
  notice_type: string;
  form_no: string;
  notice_date: string;
  appearance_date: string | null;
  appearance_time: string | null;
  recipient_name: string | null;
  status: string;
  dispatch_date: string | null;
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
  notices: Notice[];
  serviceAttempts: ServiceAttempt[];
};

export default function ServicePage() {
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

  const [selectedAttemptId, setSelectedAttemptId] =
    useState<number | null>(null);

  const [result, setResult] =
    useState<
      "DELIVERED" |
      "RETURNED" |
      "TRACKING_UPDATE"
    >("DELIVERED");

  const [trackingStatus, setTrackingStatus] =
    useState("");

  const [postalEndorsement, setPostalEndorsement] =
    useState("");

  const [deliveredDate, setDeliveredDate] =
    useState("");

  const [returnedDate, setReturnedDate] =
    useState("");

  const [remarks, setRemarks] =
    useState("");

  const [returnReason, setReturnReason] =
    useState<
      "" |
      "ADDRESSEE_LEFT" |
      "INSUFFICIENT_ADDRESS" |
      "UNCLAIMED" |
      "REFUSED_BY_ADDRESSEE" |
      "OTHER"
    >("");

  const [administrativeAction, setAdministrativeAction] =
    useState<
      "" |
      "SEEK_CORRECTED_ADDRESS" |
      "PROCEED_TO_FINAL_NOTICE"
    >("");

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(
        `/api/pim/service/${id}`,
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
            "Unable to load service data."
        );
      }

      setData(json.data);

      const activeAttempt =
        json.data.serviceAttempts.find(
          (attempt: ServiceAttempt) =>
            attempt.notice_status ===
              "DISPATCHED" &&
            !attempt.delivered_date &&
            !attempt.returned_date
        );

      if (activeAttempt) {
        setSelectedAttemptId(
          activeAttempt.id
        );

        setTrackingStatus(
          activeAttempt.tracking_status ||
            ""
        );

        setPostalEndorsement(
          activeAttempt.postal_endorsement ||
            ""
        );

        setRemarks(
          activeAttempt.remarks ||
            ""
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load service data."
      );
    } finally {
      setLoading(false);
    }
  }

  const selectedAttempt =
    data?.serviceAttempts.find(
      (attempt) =>
        attempt.id ===
        selectedAttemptId
    );

  async function saveResult() {
    if (saving) return;

    setError("");
    setSuccess("");

    if (!selectedAttempt) {
      setError(
        "Select a service attempt."
      );
      return;
    }

    if (
      result === "DELIVERED" &&
      !deliveredDate
    ) {
      setError(
        "Delivered date is required."
      );
      return;
    }

    if (
      result === "RETURNED" &&
      !returnedDate
    ) {
      setError(
        "Returned date is required."
      );
      return;
    }

    if (
      result === "RETURNED" &&
      !postalEndorsement.trim()
    ) {
      setError(
        "Postal endorsement is required for a returned notice."
      );
      return;
    }

    if (
      result === "RETURNED" &&
      !returnReason
    ) {
      setError(
        "Return reason is required for a returned notice."
      );
      return;
    }

    if (
      result === "RETURNED" &&
      returnReason === "OTHER" &&
      !remarks.trim()
    ) {
      setError(
        "Remarks are required when the return reason is OTHER."
      );
      return;
    }

    if (
      result === "RETURNED" &&
      returnReason === "OTHER" &&
      !administrativeAction
    ) {
      setError(
        "Select whether to seek a corrected address or proceed to the Final Notice."
      );
      return;
    }

    const confirmation =
      result === "DELIVERED"
        ? "Record this Form-2 notice as delivered?"
        : result === "RETURNED"
          ? "Record this Form-2 notice as returned?"
          : "Save this tracking update?";

    if (!confirm(confirmation)) {
      return;
    }

    try {
      setSaving(true);

      const response = await fetch(
        `/api/pim/service/${id}`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            serviceAttemptId:
              selectedAttempt.id,

            result,

            trackingStatus:
              trackingStatus.trim() ||
              null,

            postalEndorsement:
              postalEndorsement.trim() ||
              null,

            deliveredDate:
              result === "DELIVERED"
                ? deliveredDate
                : null,

            returnedDate:
              result === "RETURNED"
                ? returnedDate
                : null,

            returnReason:
              result === "RETURNED"
                ? returnReason
                : null,

            administrativeAction:
              result === "RETURNED" &&
              returnReason === "OTHER"
                ? administrativeAction
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
            "Unable to update service."
        );
      }

      setSuccess(
        json.message
      );

      await loadData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update service."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-6xl rounded-lg bg-white p-6 shadow">
          Loading service tracking...
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

  const isServicePending =
    data.case.status_code ===
    "SERVICE_PENDING";

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl space-y-6">

        <section className="rounded-lg bg-white p-6 shadow">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">

            <div>
              <h1 className="text-2xl font-bold">
                Service Tracking
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

            <div
              className={`rounded px-4 py-2 text-sm font-semibold ${
                isServicePending
                  ? "bg-yellow-100 text-yellow-800"
                  : "bg-green-100 text-green-800"
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
            Form-2 Notices
          </h2>

          <div className="space-y-4">
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
                        Notice Date:{" "}
                        {notice.notice_date}
                      </p>

                      {notice.dispatch_date && (
                        <p className="text-sm text-gray-600">
                          Dispatch Date:{" "}
                          {notice.dispatch_date}
                        </p>
                      )}
                    </div>

                    <span
                      className={`h-fit rounded px-3 py-1 text-xs font-semibold ${
                        notice.status ===
                        "DISPATCHED"
                          ? "bg-yellow-100 text-yellow-800"
                          : notice.status ===
                              "SERVED"
                            ? "bg-green-100 text-green-800"
                            : notice.status ===
                                "RETURNED"
                              ? "bg-red-100 text-red-800"
                              : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {notice.status}
                    </span>
                  </div>
                </div>
              )
            )}

            {data.notices.length === 0 && (
              <p className="text-sm text-gray-500">
                No Form-2 notices found.
              </p>
            )}
          </div>
        </section>

        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-5 text-lg font-semibold">
            Service Attempts
          </h2>

          {data.serviceAttempts.length ===
            0 ? (
            <p className="text-sm text-gray-500">
              No service attempts recorded.
            </p>
          ) : (
            <div className="space-y-4">
              {data.serviceAttempts.map(
                (attempt) => (
                  <div
                    key={attempt.id}
                    className={`rounded border p-5 ${
                      selectedAttemptId ===
                      attempt.id
                        ? "border-black"
                        : ""
                    }`}
                  >
                    <div className="grid gap-5 md:grid-cols-4">

                      <Info
                        label="Attempt ID"
                        value={String(
                          attempt.id
                        )}
                      />

                      <Info
                        label="Dispatch Mode"
                        value={
                          attempt.dispatch_mode
                        }
                      />

                      <Info
                        label="Dispatch Date"
                        value={
                          attempt.dispatch_date ||
                          "-"
                        }
                      />

                      <Info
                        label="Postal Receipt"
                        value={
                          attempt.postal_receipt_no ||
                          "-"
                        }
                      />

                      <Info
                        label="Tracking Number"
                        value={
                          attempt.tracking_no ||
                          "-"
                        }
                      />

                      <Info
                        label="Tracking Status"
                        value={
                          attempt.tracking_status ||
                          "-"
                        }
                      />

                      <Info
                        label="Delivered Date"
                        value={
                          attempt.delivered_date ||
                          "-"
                        }
                      />

                      <Info
                        label="Returned Date"
                        value={
                          attempt.returned_date ||
                          "-"
                        }
                      />
                    </div>

                    <div className="mt-5">
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                        Service Address
                      </p>

                      <p className="mt-1 text-sm text-gray-800">
                        {[
                          attempt.address_line1,
                          attempt.address_line2,
                          attempt.village_town,
                          attempt.district,
                          attempt.state,
                          attempt.pincode,
                        ]
                          .filter(Boolean)
                          .join(", ") ||
                          "-"}
                      </p>
                    </div>

                    {!attempt.delivered_date &&
                      !attempt.returned_date &&
                      attempt.notice_status ===
                        "DISPATCHED" &&
                      isServicePending && (
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedAttemptId(
                              attempt.id
                            )
                          }
                          className="mt-5 rounded bg-black px-5 py-2 text-sm font-medium text-white"
                        >
                          Record Service Result
                        </button>
                      )}
                  </div>
                )
              )}
            </div>
          )}
        </section>

        {selectedAttempt &&
          isServicePending &&
          selectedAttempt.notice_status ===
            "DISPATCHED" && (
            <section className="rounded-lg border border-gray-300 bg-white p-6 shadow">
              <h2 className="text-lg font-semibold">
                Record Service Result
              </h2>

              <p className="mt-1 text-sm text-gray-600">
                Service Attempt ID:{" "}
                <strong>
                  {selectedAttempt.id}
                </strong>
              </p>

              <div className="mt-6 grid gap-5 md:grid-cols-3">

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Result
                  </label>

                  <select
                    value={result}
                    onChange={(event) => {
                      setResult(
                        event.target
                          .value as
                          | "DELIVERED"
                          | "RETURNED"
                          | "TRACKING_UPDATE"
                      );
                      setReturnReason("");
                      setAdministrativeAction(
                        ""
                      );
                    }}
                    className="mt-2 w-full rounded border p-3 text-sm"
                  >
                    <option value="DELIVERED">
                      Delivered
                    </option>

                    <option value="RETURNED">
                      Returned
                    </option>

                    <option value="TRACKING_UPDATE">
                      Tracking Update
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Tracking Status
                  </label>

                  <input
                    value={
                      trackingStatus
                    }
                    onChange={(event) =>
                      setTrackingStatus(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                    placeholder="e.g. Delivered"
                  />
                </div>

                {result ===
                  "DELIVERED" && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Delivered Date
                    </label>

                    <input
                      type="date"
                      value={
                        deliveredDate
                      }
                      onChange={(event) =>
                        setDeliveredDate(
                          event.target.value
                        )
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>
                )}

                {result ===
                  "RETURNED" && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Returned Date
                    </label>

                    <input
                      type="date"
                      value={
                        returnedDate
                      }
                      onChange={(event) =>
                        setReturnedDate(
                          event.target.value
                        )
                      }
                      className="mt-2 w-full rounded border p-3 text-sm"
                    />
                  </div>
                )}
              </div>

              {result ===
                "RETURNED" && (
                <div className="mt-5">
                  <label className="block text-sm font-medium text-gray-700">
                    Postal Endorsement
                  </label>

                  <input
                    value={
                      postalEndorsement
                    }
                    onChange={(event) =>
                      setPostalEndorsement(
                        event.target.value
                      )
                    }
                    className="mt-2 w-full rounded border p-3 text-sm"
                    placeholder="e.g. Door locked / Left / Insufficient address"
                  />
                </div>
              )}

              {result ===
                "RETURNED" && (
                <div className="mt-5">
                  <label className="block text-sm font-medium text-gray-700">
                    Return Reason
                  </label>

                  <select
                    value={returnReason}
                    onChange={(event) => {
                      setReturnReason(
                        event.target
                          .value as typeof returnReason
                      );
                      setAdministrativeAction(
                        ""
                      );
                    }}
                    className="mt-2 w-full rounded border p-3 text-sm"
                  >
                    <option value="">
                      Select a return reason
                    </option>

                    <option value="ADDRESSEE_LEFT">
                      Addressee Left
                    </option>

                    <option value="INSUFFICIENT_ADDRESS">
                      Insufficient Address
                    </option>

                    <option value="UNCLAIMED">
                      Unclaimed
                    </option>

                    <option value="REFUSED_BY_ADDRESSEE">
                      Refused by Addressee (postal delivery refusal)
                    </option>

                    <option value="OTHER">
                      Other
                    </option>
                  </select>

                  {(returnReason ===
                    "ADDRESSEE_LEFT" ||
                    returnReason ===
                      "INSUFFICIENT_ADDRESS") && (
                    <p className="mt-2 text-xs text-gray-600">
                      This will move the case to Address
                      Correction Pending and create an Address
                      Correction task.
                    </p>
                  )}

                  {(returnReason ===
                    "UNCLAIMED" ||
                    returnReason ===
                      "REFUSED_BY_ADDRESSEE") && (
                    <p className="mt-2 text-xs text-gray-600">
                      This will move the case to Final Notice
                      Pending and create a Final Notice
                      Follow-up task. This does not mean the
                      opposite party refused mediation.
                    </p>
                  )}

                  {returnReason ===
                    "OTHER" && (
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700">
                        Administrative Action
                      </label>

                      <select
                        value={
                          administrativeAction
                        }
                        onChange={(event) =>
                          setAdministrativeAction(
                            event.target
                              .value as typeof administrativeAction
                          )
                        }
                        className="mt-2 w-full rounded border p-3 text-sm"
                      >
                        <option value="">
                          Select an action
                        </option>

                        <option value="SEEK_CORRECTED_ADDRESS">
                          Seek corrected address
                        </option>

                        <option value="PROCEED_TO_FINAL_NOTICE">
                          Proceed to Final Notice
                        </option>
                      </select>

                      <p className="mt-2 text-xs text-gray-600">
                        Remarks are required below when the
                        return reason is Other.
                      </p>
                    </div>
                  )}
                </div>
              )}

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
                  placeholder="Optional remarks."
                />
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={saveResult}
                  disabled={saving}
                  className="rounded bg-black px-6 py-3 font-medium text-white disabled:opacity-50"
                >
                  {saving
                    ? "Saving..."
                    : "Save Service Result"}
                </button>
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
              label="Service Pending"
              active={
                data.case.status_code ===
                "SERVICE_PENDING"
              }
              done={false}
            />

            <WorkflowStep
              number="5"
              label="OP Response"
              active={false}
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