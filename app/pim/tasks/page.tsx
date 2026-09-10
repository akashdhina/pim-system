"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

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

export default function PimTasksPage() {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<any[]>([]);
  const [taskTypes, setTaskTypes] = useState<any[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [filters, setFilters] = useState({
    status: searchParams.get("status") || "PENDING",
    taskType: searchParams.get("taskType") || "",
    priority: searchParams.get("priority") || "",
    overdue: searchParams.get("overdue") || "",
    dueDate: searchParams.get("dueDate") || "",
    caseStatus: searchParams.get("caseStatus") || "",
    page: searchParams.get("page") || "1",
  });

  const query = useMemo(
    () => toQuery(filters),
    [filters]
  );

  useEffect(() => {
    setLoading(true);
    setError("");

    fetch(`/api/pim/tasks?${query}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(
            json.message || "Unable to load tasks."
          );
        }

        return json.data;
      })
      .then((data) => {
        setRows(data.rows);
        setTaskTypes(data.taskTypes);
        setPagination(data.pagination);
      })
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load tasks."
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
              PIM Tasks
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Work queue with action links resolved from the
              current task.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/pim"
              className="rounded border px-4 py-2 text-sm font-medium"
            >
              Dashboard
            </Link>
            <Link
              href="/pim/cases"
              className="rounded border px-4 py-2 text-sm font-medium"
            >
              Cases
            </Link>
          </div>
        </div>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Select
              label="Status"
              value={filters.status}
              onChange={(value) =>
                updateFilter("status", value)
              }
              options={[
                ["PENDING", "Pending"],
                ["COMPLETED", "Completed"],
                ["all", "All"],
              ]}
            />
            <Select
              label="Task type"
              value={filters.taskType}
              onChange={(value) =>
                updateFilter("taskType", value)
              }
              options={[
                ["", "All"],
                ...taskTypes.map((taskType) => [
                  taskType.code,
                  taskType.name,
                ] as [string, string]),
              ]}
            />
            <Select
              label="Priority"
              value={filters.priority}
              onChange={(value) =>
                updateFilter("priority", value)
              }
              options={[
                ["", "All"],
                ["NORMAL", "Normal"],
                ["URGENT", "Urgent"],
              ]}
            />
            <Select
              label="Overdue"
              value={filters.overdue}
              onChange={(value) =>
                updateFilter("overdue", value)
              }
              options={[
                ["", "All"],
                ["1", "Overdue only"],
              ]}
            />
            <Input
              type="date"
              label="Due date"
              value={filters.dueDate}
              onChange={(value) =>
                updateFilter("dueDate", value)
              }
            />
            <Input
              label="Case status"
              value={filters.caseStatus}
              onChange={(value) =>
                updateFilter("caseStatus", value)
              }
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
                  <Th>Task</Th>
                  <Th>Status</Th>
                  <Th>Due date</Th>
                  <Th>Priority</Th>
                  <Th>Case status</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td className="p-4" colSpan={7}>
                      Loading tasks...
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="p-4" colSpan={7}>
                      No tasks found.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id}>
                      <Td>
                        {row.pim_number ||
                          row.received_number ||
                          "-"}
                      </Td>
                      <Td>
                        <div className="font-medium">
                          {row.task_name}
                        </div>
                        <div className="text-xs text-gray-500">
                          {row.description}
                        </div>
                      </Td>
                      <Td>{row.status}</Td>
                      <Td>
                        <span
                          className={
                            row.overdue
                              ? "font-semibold text-red-700"
                              : ""
                          }
                        >
                          {formatDate(row.due_date)}
                        </span>
                      </Td>
                      <Td>{row.priority || "-"}</Td>
                      <Td>{row.case_status_name}</Td>
                      <Td>
                        <div className="flex gap-2">
                          <Link
                            href={`/pim/case/${row.case_id}`}
                            className="rounded border px-3 py-2 text-xs font-medium"
                          >
                            Case
                          </Link>
                          {row.action?.href ? (
                            <Link
                              href={row.action.href}
                              className="rounded bg-black px-3 py-2 text-xs font-medium text-white"
                            >
                              {row.action.label}
                            </Link>
                          ) : row.action?.missingPage ? (
                            <span className="rounded border px-3 py-2 text-xs text-gray-500">
                              Page pending
                            </span>
                          ) : null}
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
      <div>{total} tasks</div>
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
