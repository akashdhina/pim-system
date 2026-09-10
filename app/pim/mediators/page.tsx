"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePimAuth } from "../../../lib/use-pim-auth";

type MediatorRow = {
  id: number;
  name: string;
  enrollment_no: string | null;
  category: string | null;
  contact_phone: string | null;
  email: string | null;
  empanelment_date: string | null;
  panel_valid_until: string | null;
  active: number;
  active_assignments: number;
  total_sessions: number;
};

type PaginationData = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

function today() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

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

function statusTone(row: MediatorRow) {
  if (!row.active) return "bg-gray-100 text-gray-500";
  if (row.panel_valid_until && row.panel_valid_until < today()) {
    return "bg-red-50 text-red-800";
  }
  if (
    row.panel_valid_until &&
    row.panel_valid_until <= addDays(today(), 30)
  ) {
    return "bg-amber-50 text-amber-800";
  }
  return "bg-white text-gray-900";
}

export default function MediatorsPage() {
  const searchParams = useSearchParams();
  const { hasPermission } = usePimAuth();
  const [rows, setRows] = useState<MediatorRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [pagination, setPagination] = useState<PaginationData>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filters, setFilters] = useState({
    search: searchParams.get("search") || "",
    active: searchParams.get("active") || "",
    category: searchParams.get("category") || "",
    validity: searchParams.get("validity") || "",
    empanelmentFrom: searchParams.get("empanelmentFrom") || "",
    empanelmentTo: searchParams.get("empanelmentTo") || "",
    sort: searchParams.get("sort") || "name",
    direction: searchParams.get("direction") || "asc",
    page: searchParams.get("page") || "1",
  });
  const query = useMemo(() => toQuery(filters), [filters]);
  const canManage = hasPermission("MANAGE_MEDIATOR");

  useEffect(() => {
    fetch(`/api/pim/mediators?${query}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(json.message || "Unable to load mediators.");
        }

        return json.data;
      })
      .then((data) => {
        setRows(data.rows);
        setCategories(data.categories);
        setPagination(data.pagination);
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Unable to load mediators."
        );
      })
      .finally(() => setLoading(false));
  }, [query]);

  function updateFilter(key: string, value: string) {
    setLoading(true);
    setError("");
    setFilters((current) => ({
      ...current,
      [key]: value,
      page: "1",
    }));
  }

  function setPage(page: number) {
    setLoading(true);
    setError("");
    setFilters((current) => ({
      ...current,
      page: String(page),
    }));
  }

  function sortBy(field: string) {
    setLoading(true);
    setError("");
    setFilters((current) => ({
      ...current,
      sort: field,
      direction:
        current.sort === field && current.direction === "asc"
          ? "desc"
          : "asc",
      page: "1",
    }));
  }

  async function toggleActive(row: MediatorRow) {
    if (!canManage || savingId) return;

    setSavingId(row.id);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/mediators/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: row.active ? 0 : 1 }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to update mediator.");
      }

      setNotice(json.message || "Mediator updated.");
      setLoading(true);
      const reload = await fetch(`/api/pim/mediators?${query}`, {
        cache: "no-store",
      });
      const reloadJson = await reload.json();
      setRows(reloadJson.data.rows);
      setCategories(reloadJson.data.categories);
      setPagination(reloadJson.data.pagination);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update mediator."
      );
    } finally {
      setSavingId(null);
      setLoading(false);
    }
  }

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold">Mediator Register</h1>
            <p className="mt-1 text-sm text-gray-500">
              Panel status, validity, assignments, and mediation workload.
            </p>
          </div>
          <div className="flex gap-2">
            {canManage && (
              <Link
                href="/pim/mediators/new"
                className="rounded bg-black px-4 py-2 text-sm font-medium text-white"
              >
                Add Mediator
              </Link>
            )}
            <Link
              href="/pim"
              className="rounded border px-4 py-2 text-sm font-medium"
            >
              Dashboard
            </Link>
          </div>
        </div>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Input
              label="Search"
              value={filters.search}
              onChange={(value) => updateFilter("search", value)}
            />
            <Select
              label="Active"
              value={filters.active}
              onChange={(value) => updateFilter("active", value)}
              options={[
                ["", "All"],
                ["1", "Active"],
                ["0", "Inactive"],
              ]}
            />
            <Select
              label="Category"
              value={filters.category}
              onChange={(value) => updateFilter("category", value)}
              options={[
                ["", "All"],
                ...categories.map((category) => [
                  category,
                  category,
                ] as [string, string]),
              ]}
            />
            <Select
              label="Panel validity"
              value={filters.validity}
              onChange={(value) => updateFilter("validity", value)}
              options={[
                ["", "All"],
                ["valid", "Valid"],
                ["expiring", "Expiring in 30 days"],
                ["expired", "Expired"],
              ]}
            />
            <Input
              label="Empanelled from"
              type="date"
              value={filters.empanelmentFrom}
              onChange={(value) =>
                updateFilter("empanelmentFrom", value)
              }
            />
            <Input
              label="Empanelled to"
              type="date"
              value={filters.empanelmentTo}
              onChange={(value) => updateFilter("empanelmentTo", value)}
            />
          </div>
        </section>

        {notice && (
          <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            {notice}
          </div>
        )}
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
                  <Sortable label="Mediator name" field="name" filters={filters} onSort={sortBy} />
                  <Sortable label="Category" field="category" filters={filters} onSort={sortBy} />
                  <Sortable label="Enrollment" field="enrollment_no" filters={filters} onSort={sortBy} />
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Contact</th>
                  <Sortable label="Empanelment" field="empanelment_date" filters={filters} onSort={sortBy} />
                  <Sortable label="Valid until" field="panel_valid_until" filters={filters} onSort={sortBy} />
                  <Sortable label="Status" field="active" filters={filters} onSort={sortBy} />
                  <Sortable label="Active assignments" field="active_assignments" filters={filters} onSort={sortBy} />
                  <Sortable label="Sessions" field="total_sessions" filters={filters} onSort={sortBy} />
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td className="p-4" colSpan={10}>
                      Loading mediators...
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="p-4" colSpan={10}>
                      No mediators found.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id} className={statusTone(row)}>
                      <Td>
                        <div className="font-medium">{row.name}</div>
                      </Td>
                      <Td>{row.category || "-"}</Td>
                      <Td>{row.enrollment_no || "-"}</Td>
                      <Td>
                        <div>{row.contact_phone || "-"}</div>
                        <div className="text-xs text-gray-500">
                          {row.email || "-"}
                        </div>
                      </Td>
                      <Td>{formatDate(row.empanelment_date)}</Td>
                      <Td>{formatDate(row.panel_valid_until)}</Td>
                      <Td>{row.active ? "Active" : "Inactive"}</Td>
                      <Td>{row.active_assignments || 0}</Td>
                      <Td>{row.total_sessions || 0}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-2">
                          <Link
                            href={`/pim/mediators/${row.id}`}
                            className="rounded border bg-white px-3 py-2 text-xs font-medium"
                          >
                            View
                          </Link>
                          <Link
                            href={`/pim/mediators/${row.id}?mode=edit`}
                            className={`rounded border bg-white px-3 py-2 text-xs font-medium ${
                              canManage ? "" : "pointer-events-none opacity-40"
                            }`}
                          >
                            Edit
                          </Link>
                          <button
                            type="button"
                            disabled={!canManage || savingId === row.id}
                            onClick={() => toggleActive(row)}
                            className="rounded border bg-white px-3 py-2 text-xs font-medium disabled:opacity-40"
                          >
                            {row.active ? "Deactivate" : "Activate"}
                          </button>
                          <Link
                            href={`/pim/mediators/${row.id}#assignments`}
                            className="rounded border bg-white px-3 py-2 text-xs font-medium"
                          >
                            Cases
                          </Link>
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

function Sortable({
  label,
  field,
  filters,
  onSort,
}: {
  label: string;
  field: string;
  filters: Record<string, string>;
  onSort: (field: string) => void;
}) {
  return (
    <th className="whitespace-nowrap px-4 py-3 font-semibold">
      <button
        type="button"
        onClick={() => onSort(field)}
        className="hover:text-gray-950"
      >
        {label}
        {filters.sort === field && (
          <span className="ml-1">
            {filters.direction === "asc" ? "Asc" : "Desc"}
          </span>
        )}
      </button>
    </th>
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
        onChange={(event) => onChange(event.target.value)}
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
        onChange={(event) => onChange(event.target.value)}
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
      <div>{total} mediators</div>
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
