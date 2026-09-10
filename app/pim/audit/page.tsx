"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type AuditRow = Record<string, any>;

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-IN");
}

function toQuery(filters: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [users, setUsers] = useState<AuditRow[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({
    from: "",
    to: "",
    userId: "",
    action: "",
    table: "",
    pimNumber: "",
    recordId: "",
    sort: "changed_at",
    direction: "desc",
    page: "1",
  });

  const query = useMemo(() => toQuery(filters), [filters]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");

    fetch(`/api/pim/audit?${query}`, { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Unable to load audit.");
        }
        return json.data;
      })
      .then((data) => {
        setRows(data.rows);
        setUsers(data.users);
        setPagination(data.pagination);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load audit.")
      )
      .finally(() => setLoading(false));
  }, [query]);

  function update(key: string, value: string) {
    setFilters((current) => ({
      ...current,
      [key]: value,
      page: "1",
    }));
  }

  function setPage(page: number) {
    setFilters((current) => ({ ...current, page: String(page) }));
  }

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">
              Audit Register
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Review system activity without exposing credentials or tokens.
            </p>
          </div>
          <Link href="/pim" className="rounded border px-4 py-2 text-sm font-medium">
            Dashboard
          </Link>
        </div>

        <section className="grid gap-3 rounded-lg border bg-white p-4 shadow-sm md:grid-cols-4 lg:grid-cols-6">
          <Input label="From" type="date" value={filters.from} onChange={(v) => update("from", v)} />
          <Input label="To" type="date" value={filters.to} onChange={(v) => update("to", v)} />
          <Select label="User" value={filters.userId} onChange={(v) => update("userId", v)} options={[["", "All"], ...users.map((u) => [String(u.id), u.display_name] as [string, string])]} />
          <Input label="Action" value={filters.action} onChange={(v) => update("action", v)} />
          <Input label="Module" value={filters.table} onChange={(v) => update("table", v)} />
          <Input label="PIM / received" value={filters.pimNumber} onChange={(v) => update("pimNumber", v)} />
          <Input label="Record ID" value={filters.recordId} onChange={(v) => update("recordId", v)} />
          <Select label="Sort" value={filters.sort} onChange={(v) => update("sort", v)} options={[["changed_at", "Date"], ["action", "Action"], ["table_name", "Module"], ["user", "User"]]} />
          <Select label="Direction" value={filters.direction} onChange={(v) => update("direction", v)} options={[["desc", "Newest"], ["asc", "Oldest"]]} />
        </section>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        <section className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <Th>Date/time</Th>
                  <Th>User</Th>
                  <Th>Action</Th>
                  <Th>Module</Th>
                  <Th>Case</Th>
                  <Th>Summary</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr><td className="p-4" colSpan={6}>Loading audit...</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td className="p-4" colSpan={6}>No audit entries found.</td></tr>
                ) : rows.map((row) => (
                  <tr key={row.id}>
                    <Td>{formatDate(row.changed_at)}</Td>
                    <Td>
                      <div>{row.user_display_name || "System"}</div>
                      <div className="text-xs text-gray-500">
                        {row.user_designation || row.user_role || "-"}
                      </div>
                    </Td>
                    <Td>{row.action}</Td>
                    <Td>{row.table_name}</Td>
                    <Td>
                      {row.case_id ? (
                        <Link className="font-medium underline" href={`/pim/case/${row.case_id}`}>
                          {row.pim_number || row.received_number || row.case_id}
                        </Link>
                      ) : row.record_id}
                    </Td>
                    <Td>{row.reason || "-"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="flex items-center justify-between rounded-lg border bg-white p-4 text-sm">
          <div>{pagination.total} entries</div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage(pagination.page - 1)} disabled={pagination.page <= 1} className="rounded border px-3 py-2 disabled:opacity-40">
              Previous
            </button>
            <span>Page {pagination.page} of {pagination.totalPages}</span>
            <button type="button" onClick={() => setPage(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages} className="rounded border px-3 py-2 disabled:opacity-40">
              Next
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase text-gray-500">{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border px-3 py-2 text-sm" />
    </label>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase text-gray-500">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border px-3 py-2 text-sm">
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>{labelText}</option>
        ))}
      </select>
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-4 py-3 font-semibold">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="whitespace-nowrap px-4 py-3">{children}</td>;
}
