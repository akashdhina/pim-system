"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DOCUMENT_TYPE_OPTIONS, documentTypeLabel } from "../../../lib/pim-document-labels";

type ReportColumn = {
  field: string;
  label: string;
  type: string;
  sortable: boolean;
};

type ReportDefinition = {
  key: string;
  title: string;
  description: string;
  dateLabel: string;
  filters: string[];
  columns: ReportColumn[];
  defaultSort: string;
  defaultDirection: string;
};

type ReportValue = string | number | null | undefined;
type ReportRow = Record<string, ReportValue>;

type MonthlySummary = {
  month: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  newCases: number;
  disposals: number;
  disposalBreakdown: {
    settled: number;
    failed: number;
    nonStarter: number;
    withdrawn: number;
  };
  closingBalance: number;
  reconciliation: {
    expectedClosing: number;
    actualClosing: number;
    matches: boolean;
  };
  initialNoticesIssued: number;
  finalNoticesIssued: number;
  feePaidCases: number;
  mediationsCommenced: number;
  sittingsHeld: number;
};

const fallbackReports: ReportDefinition[] = [
  report("register", "PIM Register", "registration_date", "desc"),
  report("pending", "Pending Action Report", "overdue_first", "asc"),
  report("overdue", "Overdue Report", "days_overdue", "desc"),
  report("notices", "Notice / Service Report", "notice_date", "desc"),
  report("address_correction", "Address-Correction Pending", "age_days", "desc"),
  report("final_notice_pending", "Final Notice Pending", "registration_date", "asc"),
  report("fees_pending", "Fee Pending Report", "balance", "desc"),
  report("mediators", "Mediator Register", "name", "asc"),
  report("sessions", "Mediation Session Register", "session_date", "desc"),
  report("monitoring", "60-Day Monitoring", "days_remaining", "asc"),
  report("non_starters", "Non-Starter Report", "outcome_date", "desc"),
  report("settlements", "Settlement Report", "closed_at", "desc"),
  report("failures", "Failure Report", "closed_at", "desc"),
  report("outcomes", "Outcome Statistics", "case_count", "desc"),
  report("documents", "Document Register", "created_at", "desc"),
  report("audit", "Audit Register", "changed_at", "desc"),
];

const filterLabels: Record<string, string> = {
  status: "Case status",
  outcome: "Outcome",
  priority: "Priority",
  category: "Category",
  active: "Active",
  documentType: "Document type",
  action: "Audit action",
  sessionStatus: "Session status",
  mediatorId: "Mediator",
  noticeType: "Notice type",
  noticeStatus: "Service result",
  returnReason: "Return reason",
  feeStatus: "Fee status",
  nonstarterReason: "Non-starter reason",
};

const filterOptions: Record<string, [string, string][]> = {
  status: [
    ["", "All"],
    ["SCRUTINY_PENDING", "Scrutiny pending"],
    ["PIM_NUMBER_PENDING", "PIM number pending"],
    ["SECRETARY_APPROVAL_PENDING", "Secretary approval (legacy)"],
    ["FORM2_PENDING", "Form-2 pending"],
    ["SERVICE_PENDING", "Service pending"],
    ["OP_CONSENT_PENDING", "OP consent"],
    ["FEE_PENDING", "Fee pending"],
    ["MEDIATOR_ASSIGNMENT_PENDING", "Mediator assignment"],
    ["MEDIATION_ONGOING", "Mediation ongoing"],
    ["OUTCOME_FORM_PENDING", "Outcome form"],
    ["AUTHORITY_DECISION_PENDING", "Authority decision"],
    ["CLOSED_SETTLED", "Closed settled"],
    ["CLOSED_FAILED", "Closed failed"],
    ["WITHDRAWN", "Withdrawn"],
    ["CLOSED_NON_STARTER", "Closed non-starter"],
  ],
  outcome: [
    ["", "All"],
    ["SETTLED", "Settled"],
    ["FAILED", "Failed"],
    ["WITHDRAWN", "Withdrawn"],
    ["NON_STARTER", "Non-starter"],
  ],
  priority: [
    ["", "All"],
    ["NORMAL", "Normal"],
    ["URGENT", "Urgent"],
  ],
  category: [["", "All"]],
  active: [
    ["", "All"],
    ["1", "Active"],
    ["0", "Inactive"],
  ],
  documentType: DOCUMENT_TYPE_OPTIONS,
  action: [
    ["", "All"],
    ["INSERT", "Insert"],
    ["UPDATE", "Update"],
    ["DELETE", "Delete"],
  ],
  sessionStatus: [
    ["", "All"],
    ["SCHEDULED", "Scheduled"],
    ["COMPLETED", "Completed"],
    ["ADJOURNED", "Adjourned"],
    ["CANCELLED", "Cancelled"],
  ],
  noticeType: [
    ["", "All"],
    ["FORM_2_INITIAL", "Initial Form II"],
    ["FORM_2_FINAL", "Final Form II"],
  ],
  noticeStatus: [
    ["", "All"],
    ["PREPARED", "Prepared"],
    ["DISPATCHED", "Dispatched"],
    ["SERVED", "Served"],
    ["RETURNED", "Returned"],
  ],
  returnReason: [
    ["", "All"],
    ["ADDRESSEE_LEFT", "Addressee left"],
    ["INSUFFICIENT_ADDRESS", "Insufficient address"],
    ["UNCLAIMED", "Unclaimed"],
    ["REFUSED_BY_ADDRESSEE", "Refused by addressee (postal)"],
    ["OTHER", "Other"],
  ],
  feeStatus: [
    ["", "All"],
    ["PENDING", "Pending"],
    ["PARTIALLY_RECEIVED", "Partially received"],
    ["RECEIVED", "Received"],
  ],
  nonstarterReason: [
    ["", "All"],
    ["FINAL_NOTICE_UNACKNOWLEDGED", "Final notice unacknowledged"],
    ["OP_REFUSED_MEDIATION", "OP refused mediation"],
    ["OP_FAILED_TO_APPEAR_AFTER_TIME", "Failed to appear after time"],
    ["BOTH_PARTIES_NOT_WILLING", "Both parties not willing"],
    ["MEDIATION_FEE_NOT_SUBMITTED", "Mediation fee not submitted"],
  ],
};

function report(
  key: string,
  title: string,
  defaultSort: string,
  defaultDirection: string
): ReportDefinition {
  return {
    key,
    title,
    description: "",
    dateLabel: "Date range",
    filters: [],
    columns: [],
    defaultSort,
    defaultDirection,
  };
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN");
}

function formatValue(
  value: ReportValue,
  type: string,
  row: ReportRow
) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (type === "date") {
    return formatDate(String(value));
  }

  if (type === "currency") {
    return new Intl.NumberFormat("en-IN", {
      maximumFractionDigits: 2,
    }).format(Number(value) || 0);
  }

  if (type === "case") {
    const caseId = row.case_id || row.id;
    return (
      <Link
        href={`/pim/case/${caseId}`}
        className="font-medium text-gray-950 underline-offset-2 hover:underline"
      >
        {String(value)}
      </Link>
    );
  }

  if (type === "documentType") {
    return documentTypeLabel(String(value));
  }

  return String(value);
}

function toQuery(filters: Record<string, string>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }

  return params.toString();
}

export default function PimReportsPage() {
  const searchParams = useSearchParams();
  const initialReport = searchParams.get("report") || "register";
  const initialDefinition =
    fallbackReports.find((item) => item.key === initialReport) ||
    fallbackReports[0];

  const [reports, setReports] = useState(fallbackReports);
  const [activeReport, setActiveReport] =
    useState<ReportDefinition>(initialDefinition);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [totals, setTotals] = useState<ReportRow | null>(null);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mediatorOptions, setMediatorOptions] = useState<[string, string][]>([
    ["", "All"],
  ]);
  const [view, setView] = useState<"register" | "monthly">("register");
  const [monthlyMonth, setMonthlyMonth] = useState(
    new Date().toISOString().slice(0, 7)
  );
  const [monthlyData, setMonthlyData] = useState<MonthlySummary | null>(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyError, setMonthlyError] = useState("");
  const [filters, setFilters] = useState({
    report: initialReport,
    search: searchParams.get("search") || "",
    dateFrom: searchParams.get("dateFrom") || "",
    dateTo: searchParams.get("dateTo") || "",
    status: searchParams.get("status") || "",
    outcome: searchParams.get("outcome") || "",
    priority: searchParams.get("priority") || "",
    category: searchParams.get("category") || "",
    active: searchParams.get("active") || "",
    documentType: searchParams.get("documentType") || "",
    action: searchParams.get("action") || "",
    sessionStatus: searchParams.get("sessionStatus") || "",
    mediatorId: searchParams.get("mediatorId") || "",
    noticeType: searchParams.get("noticeType") || "",
    noticeStatus: searchParams.get("noticeStatus") || "",
    returnReason: searchParams.get("returnReason") || "",
    feeStatus: searchParams.get("feeStatus") || "",
    nonstarterReason: searchParams.get("nonstarterReason") || "",
    sort: searchParams.get("sort") || initialDefinition.defaultSort,
    direction:
      searchParams.get("direction") ||
      initialDefinition.defaultDirection,
    page: searchParams.get("page") || "1",
  });

  const query = useMemo(() => toQuery(filters), [filters]);

  useEffect(() => {
    fetch(`/api/pim/mediators?pageSize=100`, { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) return;
        const options: [string, string][] = [
          ["", "All"],
          ...json.data.rows.map(
            (mediator: { id: number; name: string }) =>
              [String(mediator.id), mediator.name] as [string, string]
          ),
        ];
        setMediatorOptions(options);
      })
      .catch(() => {
        /* mediator dropdown stays at default "All" on failure */
      });
  }, []);

  useEffect(() => {
    if (view !== "register") return;

    fetch(`/api/pim/reports?${query}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(
            json.message || "Unable to load report."
          );
        }

        return json.data;
      })
      .then((data) => {
        setReports(data.reports);
        setActiveReport(data.report);
        setRows(data.rows);
        setTotals(data.totals || null);
        setPagination(data.pagination);
      })
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load report."
        );
      })
      .finally(() => setLoading(false));
  }, [query, view]);

  useEffect(() => {
    if (view !== "monthly") return;

    setMonthlyLoading(true);
    setMonthlyError("");

    fetch(`/api/pim/reports/monthly?month=${monthlyMonth}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(
            json.message || "Unable to load monthly summary."
          );
        }

        return json.data as MonthlySummary;
      })
      .then((data) => setMonthlyData(data))
      .catch((err) => {
        setMonthlyError(
          err instanceof Error
            ? err.message
            : "Unable to load monthly summary."
        );
      })
      .finally(() => setMonthlyLoading(false));
  }, [view, monthlyMonth]);

  function updateFilter(key: string, value: string) {
    setLoading(true);
    setError("");
    setFilters((current) => ({
      ...current,
      [key]: value,
      page: "1",
    }));
  }

  function changeReport(nextReport: ReportDefinition) {
    setView("register");
    setLoading(true);
    setError("");
    setFilters((current) => ({
      ...current,
      report: nextReport.key,
      sort: nextReport.defaultSort,
      direction: nextReport.defaultDirection,
      page: "1",
    }));
  }

  function showTodaysMediation() {
    const today = new Date().toISOString().slice(0, 10);
    const sessionsReport =
      reports.find((item) => item.key === "sessions") || reports[0];

    setView("register");
    setLoading(true);
    setError("");
    setFilters((current) => ({
      ...current,
      report: "sessions",
      dateFrom: today,
      dateTo: today,
      sort: sessionsReport.defaultSort,
      direction: sessionsReport.defaultDirection,
      page: "1",
    }));
  }

  function exportCsv() {
    window.location.href = `/api/pim/reports?${query}&format=csv`;
  }

  function printReport() {
    window.print();
  }

  function setPage(page: number) {
    setLoading(true);
    setError("");
    setFilters((current) => ({
      ...current,
      page: String(page),
    }));
  }

  function sortBy(column: ReportColumn) {
    if (!column.sortable) return;

    setLoading(true);
    setError("");
    setFilters((current) => ({
      ...current,
      sort: column.field,
      direction:
        current.sort === column.field && current.direction === "asc"
          ? "desc"
          : "asc",
      page: "1",
    }));
  }

  const generatedAt = new Date().toLocaleString("en-IN");

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="hidden print:block">
          <p className="text-sm font-semibold">
            District Legal Services Authority, Nilgiris
          </p>
          <p className="text-sm">Pre-Institution Mediation</p>
          <p className="mt-1 text-base font-bold">
            {view === "monthly"
              ? "Monthly PIM Summary"
              : activeReport.title}
          </p>
          <p className="text-xs text-gray-600">
            {view === "monthly"
              ? `Period: ${monthlyMonth}`
              : `Period: ${filters.dateFrom || "All"} to ${filters.dateTo || "All"}`}
          </p>
          <p className="text-xs text-gray-600">
            Generated: {generatedAt}
          </p>
          <hr className="my-2" />
        </div>

        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end print:hidden">
          <div>
            <h1 className="text-2xl font-bold">
              Reports
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Search, filter, sort, and page through PIM registers.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                setView((current) =>
                  current === "monthly" ? "register" : "monthly"
                )
              }
              className={`rounded border px-4 py-2 text-sm font-medium ${
                view === "monthly" ? "bg-black text-white" : ""
              }`}
            >
              Monthly Summary
            </button>
            <button
              type="button"
              onClick={showTodaysMediation}
              className="rounded border px-4 py-2 text-sm font-medium"
            >
              Today&apos;s Mediation
            </button>
            <button
              type="button"
              onClick={printReport}
              className="rounded border px-4 py-2 text-sm font-medium"
            >
              Print
            </button>
            {view === "register" && (
              <button
                type="button"
                onClick={exportCsv}
                className="rounded border px-4 py-2 text-sm font-medium"
              >
                Export CSV
              </button>
            )}
            <Link
              href="/pim"
              className="rounded border px-4 py-2 text-sm font-medium"
            >
              Dashboard
            </Link>
          </div>
        </div>

        {view === "monthly" ? (
          <MonthlySummaryView
            month={monthlyMonth}
            onMonthChange={setMonthlyMonth}
            data={monthlyData}
            loading={monthlyLoading}
            error={monthlyError}
          />
        ) : (
          <>
        <section className="rounded-lg border bg-white p-3 shadow-sm print:hidden">
          <div className="flex gap-2 overflow-x-auto">
            {reports.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => changeReport(item)}
                className={`shrink-0 rounded px-3 py-2 text-sm font-medium ${
                  activeReport.key === item.key
                    ? "bg-black text-white"
                    : "border text-gray-700 hover:bg-gray-50"
                }`}
              >
                {item.title}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm print:hidden">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">
              {activeReport.title}
            </h2>
            {activeReport.description && (
              <p className="mt-1 text-sm text-gray-500">
                {activeReport.description}
              </p>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
            <Input
              label="Search"
              value={filters.search}
              onChange={(value) =>
                updateFilter("search", value)
              }
            />
            <Input
              type="date"
              label={`${activeReport.dateLabel} from`}
              value={filters.dateFrom}
              onChange={(value) =>
                updateFilter("dateFrom", value)
              }
            />
            <Input
              type="date"
              label={`${activeReport.dateLabel} to`}
              value={filters.dateTo}
              onChange={(value) =>
                updateFilter("dateTo", value)
              }
            />
            {activeReport.filters.map((filterName) => {
              const options =
                filterName === "mediatorId"
                  ? mediatorOptions
                  : filterOptions[filterName];
              const value =
                filters[filterName as keyof typeof filters];

              return options && options.length > 1 ? (
                <Select
                  key={filterName}
                  label={filterLabels[filterName] || filterName}
                  value={value}
                  onChange={(nextValue) =>
                    updateFilter(filterName, nextValue)
                  }
                  options={options}
                />
              ) : (
                <Input
                  key={filterName}
                  label={filterLabels[filterName] || filterName}
                  value={value}
                  onChange={(nextValue) =>
                    updateFilter(filterName, nextValue)
                  }
                />
              );
            })}
          </div>
        </section>

        {activeReport.key === "sessions" && totals && (
          <SessionTotals totals={totals} />
        )}

        {activeReport.key === "outcomes" && rows.length > 0 && (
          <OutcomeRates rows={rows} />
        )}

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
                  {activeReport.columns.map((column) => (
                    <th
                      key={column.field}
                      className="whitespace-nowrap px-4 py-3 font-semibold"
                    >
                      <button
                        type="button"
                        onClick={() => sortBy(column)}
                        disabled={!column.sortable}
                        className={`text-left ${
                          column.sortable
                            ? "hover:text-gray-950"
                            : "cursor-default"
                        }`}
                      >
                        {column.label}
                        {filters.sort === column.field && (
                          <span className="ml-1">
                            {filters.direction === "asc" ? "Asc" : "Desc"}
                          </span>
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td
                      className="p-4"
                      colSpan={Math.max(1, activeReport.columns.length)}
                    >
                      Loading report...
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      className="p-4"
                      colSpan={Math.max(1, activeReport.columns.length)}
                    >
                      No records found.
                    </td>
                  </tr>
                ) : (
                  rows.map((row, index) => (
                    <tr key={row.id || index}>
                      {activeReport.columns.map((column) => (
                        <td
                          key={column.field}
                          className="whitespace-nowrap px-4 py-3"
                        >
                          {formatValue(
                            row[column.field],
                            column.type,
                            row
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <div className="print:hidden">
          <Pagination
            page={pagination.page}
            totalPages={pagination.totalPages}
            total={pagination.total}
            pageSize={pagination.pageSize}
            onPage={setPage}
          />
        </div>
          </>
        )}
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

function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-lg border bg-white p-4 text-sm md:flex-row md:items-center">
      <div>
        {total} records / {pageSize} per page
      </div>
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

function SessionTotals({ totals }: { totals: ReportRow }) {
  const totalSittings = Number(totals.total_sittings || 0);
  const effective = Number(totals.effective_sittings || 0);
  const ineffective = Number(totals.ineffective_sittings || 0);
  const minutes = Number(
    totals.cumulative_effective_duration_minutes || 0
  );
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return (
    <div className="grid gap-3 rounded-lg border bg-white p-4 shadow-sm sm:grid-cols-4">
      <Stat label="Total sittings" value={String(totalSittings)} />
      <Stat label="Effective" value={String(effective)} />
      <Stat label="Ineffective" value={String(ineffective)} />
      <Stat
        label="Cumulative effective duration"
        value={`${hours}h ${String(remainder).padStart(2, "0")}m`}
      />
    </div>
  );
}

function OutcomeRates({ rows }: { rows: ReportRow[] }) {
  const closedTypes = new Set(["SETTLED", "FAILED", "NON_STARTER", "WITHDRAWN"]);
  const closedRows = rows.filter((row) =>
    closedTypes.has(String(row.outcome_type || ""))
  );
  const denominator = closedRows.reduce(
    (sum, row) => sum + Number(row.case_count || 0),
    0
  );

  function rateFor(outcomeType: string) {
    if (!denominator) return "-";
    const row = closedRows.find((r) => r.outcome_type === outcomeType);
    const count = Number(row?.case_count || 0);
    return `${((count / denominator) * 100).toFixed(1)}%`;
  }

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <p className="mb-3 text-xs text-gray-500">
        Percentages are of the {denominator} case(s) closed with an
        outcome in the selected period. Open/active cases are not part
        of this denominator.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Settlement rate" value={rateFor("SETTLED")} />
        <Stat label="Failure rate" value={rateFor("FAILED")} />
        <Stat label="Non-starter rate" value={rateFor("NON_STARTER")} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase text-gray-500">
        {label}
      </div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function MonthlySummaryView({
  month,
  onMonthChange,
  data,
  loading,
  error,
}: {
  month: string;
  onMonthChange: (month: string) => void;
  data: MonthlySummary | null;
  loading: boolean;
  error: string;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-lg border bg-white p-4 shadow-sm print:hidden">
        <label className="block max-w-xs">
          <span className="text-xs font-medium uppercase text-gray-500">
            Month
          </span>
          <input
            type="month"
            value={month}
            onChange={(event) => onMonthChange(event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
          />
        </label>
      </section>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
          {error}
        </div>
      )}

      {loading || !data ? (
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          Loading monthly summary...
        </div>
      ) : (
        <>
          <section className="rounded-lg border bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-lg font-semibold">
              Opening / Closing Balance
            </h2>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat
                label="Opening balance"
                value={String(data.openingBalance)}
              />
              <Stat label="New cases" value={String(data.newCases)} />
              <Stat label="Disposals" value={String(data.disposals)} />
              <Stat
                label="Closing balance"
                value={String(data.closingBalance)}
              />
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Opening ({data.openingBalance}) + New ({data.newCases}) -
              Disposals ({data.disposals}) = Closing ({data.closingBalance})
            </p>
          </section>

          <section
            className={`rounded-lg border p-4 shadow-sm ${
              data.reconciliation.matches
                ? "bg-white"
                : "border-amber-300 bg-amber-50"
            }`}
          >
            <h2 className="mb-3 text-lg font-semibold">
              Reconciliation
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat
                label="Expected closing (opening + new - disposals)"
                value={String(data.reconciliation.expectedClosing)}
              />
              <Stat
                label="Actual open-case count at month end"
                value={String(data.reconciliation.actualClosing)}
              />
            </div>
            {!data.reconciliation.matches && (
              <p className="mt-3 text-sm font-medium text-amber-800">
                Mismatch detected: expected and actual closing balances
                differ. This may indicate a data-integrity issue (e.g. a
                closure date before a registration date). No automatic
                correction has been made.
              </p>
            )}
          </section>

          <section className="rounded-lg border bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-lg font-semibold">
              Disposals by Outcome
            </h2>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat
                label="Settled"
                value={String(data.disposalBreakdown.settled)}
              />
              <Stat
                label="Failed"
                value={String(data.disposalBreakdown.failed)}
              />
              <Stat
                label="Non-starter"
                value={String(data.disposalBreakdown.nonStarter)}
              />
              <Stat
                label="Withdrawn"
                value={String(data.disposalBreakdown.withdrawn)}
              />
            </div>
          </section>

          <section className="rounded-lg border bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-lg font-semibold">
              Workflow Activity
            </h2>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat
                label="Initial notices issued"
                value={String(data.initialNoticesIssued)}
              />
              <Stat
                label="Final notices issued"
                value={String(data.finalNoticesIssued)}
              />
              <Stat
                label="Fee-paid cases"
                value={String(data.feePaidCases)}
              />
              <Stat
                label="Mediations commenced"
                value={String(data.mediationsCommenced)}
              />
              <Stat
                label="Sittings held"
                value={String(data.sittingsHeld)}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
