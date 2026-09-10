"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type CaseRow = Record<string, any>;

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN");
}

function toQuery(filters: Record<string, string>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }

  return params.toString();
}

export default function PimCasesPage() {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [filters, setFilters] = useState({
    pimNumber: searchParams.get("pimNumber") || "",
    receivedNumber:
      searchParams.get("receivedNumber") || "",
    partyName: searchParams.get("partyName") || "",
    status: searchParams.get("status") || "",
    outcome: searchParams.get("outcome") || "",
    registrationFrom:
      searchParams.get("registrationFrom") || "",
    registrationTo:
      searchParams.get("registrationTo") || "",
    openClosed: searchParams.get("openClosed") || "",
    deadline: searchParams.get("deadline") || "",
    page: searchParams.get("page") || "1",
  });

  const query = useMemo(
    () => toQuery(filters),
    [filters]
  );

  useEffect(() => {
    setLoading(true);
    setError("");

    fetch(`/api/pim/cases?${query}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(
            json.message || "Unable to load cases."
          );
        }

        return json.data;
      })
      .then((data) => {
        setRows(data.rows);
        setPagination(data.pagination);
      })
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load cases."
        );
      })
      .finally(() => setLoading(false));
  }, [query]);

  function updateFilter(key: string, value: string) {
    setFilters((current) => ({
      ...current,
      [key]: value,
      page: "1",
    }));
  }

  function setPage(page: number) {
    setFilters((current) => ({
      ...current,
      page: String(page),
    }));
  }

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold">
              PIM Cases
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Search and open case workflow actions.
            </p>
          </div>
          <Link
            href="/pim"
            className="rounded border px-4 py-2 text-sm font-medium"
          >
            Dashboard
          </Link>
        </div>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
            <Input
              label="PIM number"
              value={filters.pimNumber}
              onChange={(value) =>
                updateFilter("pimNumber", value)
              }
            />
            <Input
              label="Received number"
              value={filters.receivedNumber}
              onChange={(value) =>
                updateFilter("receivedNumber", value)
              }
            />
            <Input
              label="Applicant / OP"
              value={filters.partyName}
              onChange={(value) =>
                updateFilter("partyName", value)
              }
            />
            <Select
              label="Status"
              value={filters.status}
              onChange={(value) =>
                updateFilter("status", value)
              }
              options={[
                ["", "All"],
                ["SCRUTINY_PENDING", "Scrutiny pending"],
                [
                  "SECRETARY_APPROVAL_PENDING",
                  "Secretary approval",
                ],
                ["FORM2_PENDING", "Form-2 pending"],
                ["SERVICE_PENDING", "Service pending"],
                ["OP_CONSENT_PENDING", "OP consent"],
                ["FEE_PENDING", "Fee pending"],
                [
                  "MEDIATOR_ASSIGNMENT_PENDING",
                  "Mediator assignment",
                ],
                ["MEDIATION_ONGOING", "Mediation ongoing"],
                ["OUTCOME_FORM_PENDING", "Outcome form"],
                [
                  "AUTHORITY_DECISION_PENDING",
                  "Authority decision",
                ],
                ["CLOSED_SETTLED", "Closed settled"],
                ["CLOSED_FAILED", "Closed failed"],
                ["WITHDRAWN", "Withdrawn"],
                [
                  "CLOSED_NON_STARTER",
                  "Closed non-starter",
                ],
              ]}
            />
            <Select
              label="Outcome"
              value={filters.outcome}
              onChange={(value) =>
                updateFilter("outcome", value)
              }
              options={[
                ["", "All"],
                ["SETTLED", "Settled"],
                ["FAILED", "Failed"],
                ["WITHDRAWN", "Withdrawn"],
                ["NON_STARTER", "Non-starter"],
              ]}
            />
            <Input
              type="date"
              label="Registered from"
              value={filters.registrationFrom}
              onChange={(value) =>
                updateFilter("registrationFrom", value)
              }
            />
            <Input
              type="date"
              label="Registered to"
              value={filters.registrationTo}
              onChange={(value) =>
                updateFilter("registrationTo", value)
              }
            />
            <Select
              label="Open / closed"
              value={filters.openClosed}
              onChange={(value) =>
                updateFilter("openClosed", value)
              }
              options={[
                ["", "All"],
                ["open", "Open"],
                ["closed", "Closed"],
              ]}
            />
            <Select
              label="60-day date"
              value={filters.deadline}
              onChange={(value) =>
                updateFilter("deadline", value)
              }
              options={[
                ["", "All"],
                ["due", "Has due date"],
                ["approaching", "Due within 7 days"],
                ["overdue", "Overdue"],
              ]}
            />
          </div>
        </section>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
            {error}
          </div>
        )}

        <section className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <Th>PIM number</Th>
                  <Th>Received number</Th>
                  <Th>Applicant</Th>
                  <Th>Opposite party</Th>
                  <Th>Registration</Th>
                  <Th>Status</Th>
                  <Th>60-day date</Th>
                  <Th>Priority</Th>
                  <Th>Next pending task</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td className="p-4" colSpan={10}>
                      Loading cases...
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="p-4" colSpan={10}>
                      No cases found.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id}>
                      <Td>{row.pim_number || "-"}</Td>
                      <Td>{row.received_number || "-"}</Td>
                      <Td>{row.applicant_name || "-"}</Td>
                      <Td>
                        {row.opposite_party_name || "-"}
                      </Td>
                      <Td>
                        {formatDate(row.registration_date)}
                      </Td>
                      <Td>{row.status_name}</Td>
                      <Td>
                        {formatDate(
                          row.internal_60_day_date
                        )}
                      </Td>
                      <Td>{row.priority || "-"}</Td>
                      <Td>
                        {row.pending_task_description ||
                          "-"}
                      </Td>
                      <Td>
                        <div className="flex gap-2">
                          <Link
                            href={`/pim/case/${row.id}`}
                            className="rounded border px-3 py-2 text-xs font-medium"
                          >
                            Case
                          </Link>
                          {row.action?.href && (
                            <Link
                              href={row.action.href}
                              className="rounded bg-black px-3 py-2 text-xs font-medium text-white"
                            >
                              {row.action.label}
                            </Link>
                          )}
                        </div>
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <Pagination
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          onPage={setPage}
        />
      </div>
    </main>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase text-gray-500">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) =>
          onChange(event.target.value)
        }
        className="mt-1 w-full rounded border px-3 py-2 text-sm"
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase text-gray-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) =>
          onChange(event.target.value)
        }
        className="mt-1 w-full rounded border px-3 py-2 text-sm"
      >
        {options.map(([optionValue, label]) => (
          <option key={optionValue} value={optionValue}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="whitespace-nowrap px-4 py-3 font-semibold">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="whitespace-nowrap px-4 py-3">
      {children}
    </td>
  );
}

function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-white p-4 text-sm">
      <div>{total} cases</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="rounded border px-3 py-2 disabled:opacity-40"
        >
          Previous
        </button>
        <span>
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          className="rounded border px-3 py-2 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
