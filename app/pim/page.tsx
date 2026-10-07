"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePimAuth } from "../../lib/use-pim-auth";

type DashboardData = {
  totals: Record<string, number>;
  cardCounts: Record<string, number>;
  statusCounts: Record<string, unknown>[];
  taskTypeCounts: TaskTypeCount[];
  recentCases: DashboardRow[];
  recentClosedCases: DashboardRow[];
  pendingTasks: DashboardRow[];
  dueToday: DashboardRow[];
  overdueTasks: DashboardRow[];
  approachingCases: DashboardRow[];
  sittingsToday: DashboardRow[];
  expiringMediators: DashboardRow[];
  recentActivity: DashboardRow[];
  latestBackup: {
    id: string;
    created_at?: string;
    status?: string;
  } | null;
};

type TaskTypeCount = {
  code: string;
  name: string;
  count: number;
};

type DashboardRow = {
  id: number;
  case_id?: number;
  pim_number?: string | null;
  received_number?: string | null;
  applicant_name?: string | null;
  status_name?: string | null;
  description?: string | null;
  due_date?: string | null;
  internal_60_day_date?: string | null;
  action?: {
    href?: string | null;
    label?: string;
    terminal?: boolean;
    missingPage?: boolean;
  };
  table_name?: string;
  record_id?: number;
  reason?: string | null;
  changed_at?: string | null;
  user_name?: string | null;
  name?: string | null;
  category?: string | null;
  mediator_name?: string | null;
  panel_valid_until?: string | null;
  session_status?: string | null;
  sitting_number?: number;
};

const cards = [
  {
    key: "pending_scrutiny",
    label: "Pending scrutiny",
    href: "/pim/cases?status=SCRUTINY_PENDING",
    tone: "from-sky-500 to-cyan-500",
    accent: "bg-sky-100 text-sky-800",
  },
  {
    key: "pim_number_pending",
    label: "PIM number pending",
    href: "/pim/cases?status=PIM_NUMBER_PENDING",
    tone: "from-indigo-500 to-violet-500",
    accent: "bg-indigo-100 text-indigo-800",
  },
  {
    key: "form2_pending",
    label: "Form-2 pending",
    href: "/pim/cases?status=FORM2_PENDING",
    tone: "from-amber-500 to-orange-500",
    accent: "bg-amber-100 text-amber-800",
  },
  {
    key: "service_pending",
    label: "Service pending",
    href: "/pim/cases?status=SERVICE_PENDING",
    tone: "from-rose-500 to-pink-500",
    accent: "bg-rose-100 text-rose-800",
  },
  {
    key: "op_response_pending",
    label: "OP response/consent pending",
    href: "/pim/cases?status=OP_CONSENT_PENDING",
    tone: "from-teal-500 to-emerald-500",
    accent: "bg-teal-100 text-teal-800",
  },
  {
    key: "fee_pending",
    label: "Fee pending",
    href: "/pim/cases?status=FEE_PENDING",
    tone: "from-lime-500 to-green-500",
    accent: "bg-lime-100 text-lime-800",
  },
  {
    key: "mediator_assignment",
    label: "Mediator assignment",
    href: "/pim/cases?status=MEDIATOR_ASSIGNMENT_PENDING",
    tone: "from-fuchsia-500 to-purple-500",
    accent: "bg-fuchsia-100 text-fuchsia-800",
  },
  {
    key: "first_mediation",
    label: "First mediation",
    href: "/pim/tasks?status=PENDING&taskType=FIRST_MEDIATION",
    tone: "from-blue-500 to-indigo-500",
    accent: "bg-blue-100 text-blue-800",
  },
  {
    key: "session_recording",
    label: "Session recording",
    href: "/pim/tasks?status=PENDING&taskType=SESSION_RECORD",
    tone: "from-cyan-500 to-blue-500",
    accent: "bg-cyan-100 text-cyan-800",
  },
  {
    key: "outcome_form",
    label: "Outcome form",
    href: "/pim/tasks?status=PENDING&taskType=OUTCOME_FORM",
    tone: "from-emerald-500 to-teal-500",
    accent: "bg-emerald-100 text-emerald-800",
  },
  {
    key: "authority_decision",
    label: "Authority decision",
    href: "/pim/tasks?status=PENDING&taskType=NONSTARTER_AUTHORITY",
    tone: "from-slate-700 to-gray-600",
    accent: "bg-slate-100 text-slate-800",
  },
  {
    key: "closed_settled",
    label: "Closed settled",
    href: "/pim/cases?status=CLOSED_SETTLED",
    tone: "from-green-500 to-emerald-500",
    accent: "bg-green-100 text-green-800",
  },
  {
    key: "closed_failed",
    label: "Closed failed",
    href: "/pim/cases?status=CLOSED_FAILED",
    tone: "from-red-500 to-rose-500",
    accent: "bg-red-100 text-red-800",
  },
  {
    key: "withdrawn",
    label: "Withdrawn",
    href: "/pim/cases?status=WITHDRAWN",
    tone: "from-zinc-500 to-stone-500",
    accent: "bg-zinc-100 text-zinc-800",
  },
  {
    key: "closed_non_starter",
    label: "Closed non-starter",
    href: "/pim/cases?status=CLOSED_NON_STARTER",
    tone: "from-orange-500 to-red-500",
    accent: "bg-orange-100 text-orange-800",
  },
  {
    key: "overdue_tasks",
    label: "Overdue tasks",
    href: "/pim/tasks?status=PENDING&overdue=1",
    totalKey: "overdueTasks",
    tone: "from-red-600 to-orange-500",
    accent: "bg-red-100 text-red-800",
  },
  {
    key: "approaching_60_day",
    label: "60-day deadline approaching",
    href: "/pim/cases?deadline=approaching&openClosed=open",
    totalKey: "approaching60Day",
    tone: "from-yellow-500 to-amber-500",
    accent: "bg-yellow-100 text-yellow-800",
  },
];

const summaryCards = [
  {
    key: "totalCases",
    label: "Total cases",
    tone: "from-blue-600 to-cyan-500",
    note: "All registered records",
  },
  {
    key: "openCases",
    label: "Open cases",
    tone: "from-emerald-600 to-teal-500",
    note: "Active workflow",
  },
  {
    key: "closedCases",
    label: "Closed cases",
    tone: "from-violet-600 to-fuchsia-500",
    note: "Disposed matters",
  },
  {
    key: "pendingTasks",
    label: "Pending tasks",
    tone: "from-amber-500 to-orange-500",
    note: "Needs action",
  },
  {
    key: "overdueTasks",
    label: "Overdue tasks",
    tone: "from-red-600 to-rose-500",
    note: "Priority queue",
  },
  {
    key: "approaching60Day",
    label: "60-day due soon",
    tone: "from-indigo-600 to-blue-500",
    note: "Deadline watch",
  },
];

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN");
}

function taskCount(data: DashboardData, code: string) {
  return (
    data.taskTypeCounts.find((item) => item.code === code)
      ?.count || 0
  );
}

function backupAgeLabel(value?: string) {
  if (!value) return "No backup";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const hours = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60));
  return hours < 1 ? "Fresh" : `${hours}h old`;
}

function statusBadge(status?: string | null) {
  const text = String(status || "");
  if (text.includes("CLOSED") || text === "SUCCESS") {
    return "bg-green-100 text-green-800 border-green-200";
  }
  if (text.includes("OVERDUE") || text === "FAILED") {
    return "bg-red-100 text-red-800 border-red-200";
  }
  if (text.includes("PENDING") || text.includes("ONGOING")) {
    return "bg-amber-100 text-amber-800 border-amber-200";
  }
  return "bg-gray-100 text-gray-800 border-gray-200";
}

export default function PimDashboardPage() {
  const { hasPermission } = usePimAuth();
  const [data, setData] =
    useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/pim/dashboard", {
      cache: "no-store",
    })
      .then(async (response) => {
        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(
            json.message ||
              "Unable to load PIM dashboard."
          );
        }

        return json.data;
      })
      .then(setData)
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load dashboard."
        );
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-7xl rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          Loading dashboard...
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-7xl rounded-lg border border-red-200 bg-red-50 p-6 text-red-800 shadow-sm">
          {error}
        </div>
      </main>
    );
  }

  if (!data) return null;

  return (
    <main className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="bg-gradient-to-r from-slate-950 via-indigo-950 to-cyan-900 px-5 py-6 text-white md:px-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">
                  DLSA Nilgiris
                </div>
                <h1 className="mt-2 text-3xl font-bold">
                  PIM Command Centre
                </h1>
                <p className="mt-2 max-w-3xl text-sm text-slate-200">
                  Live case intake, scrutiny, notice, mediation, outcome, and backup monitoring in one workspace.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                <MetricPill
                  label="Open"
                  value={data.totals.openCases}
                />
                <MetricPill
                  label="Pending"
                  value={data.totals.pendingTasks}
                />
                <MetricPill
                  label="Overdue"
                  value={data.totals.overdueTasks}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-6">
            {summaryCards.map((card) => (
              <Summary
                key={card.key}
                label={card.label}
                value={data.totals[card.key] || 0}
                tone={card.tone}
                note={card.note}
              />
            ))}
          </div>
        </section>

        <QuickActions
          data={data}
          hasPermission={hasPermission}
        />

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <OperationalList
            title="Due Today"
            rows={data.dueToday}
            empty="No tasks due today."
            mode="task"
          />
          <OperationalList
            title="Overdue Tasks"
            rows={data.overdueTasks}
            empty="No overdue pending tasks."
            mode="task"
          />
          <OperationalList
            title="Approaching 60-Day Date"
            rows={data.approachingCases}
            empty="No open cases approaching the internal date."
            mode="case"
          />
          <OperationalList
            title="Mediation Sittings Today"
            rows={data.sittingsToday}
            empty="No sittings listed for today."
            mode="sitting"
          />
          <OperationalList
            title="Mediator Panels Expiring"
            rows={data.expiringMediators}
            empty="No panels expire within 30 days."
            mode="mediator"
          />
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-950">
              Latest Backup
            </h2>
            <div className="mt-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {backupAgeLabel(data.latestBackup?.created_at)}
                </div>
                <div className="text-xs text-gray-500">
                  {formatDate(data.latestBackup?.created_at || null)}
                </div>
              </div>
              <span
                className={`rounded-full border px-2 py-1 text-xs font-medium ${statusBadge(
                  data.latestBackup?.status || "not found"
                )}`}
              >
                {data.latestBackup?.status || "not found"}
              </span>
            </div>
            {hasPermission("VIEW_BACKUP") && (
              <Link
                href="/pim/settings/backups"
                className="mt-4 inline-flex rounded bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Backup
              </Link>
            )}
          </section>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {cards.map((card) => (
            <Link
              key={card.key}
              href={card.href}
              className="group overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
            >
              <div className={`h-1.5 bg-gradient-to-r ${card.tone}`} />
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-700">
                    {card.label}
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${card.accent}`}>
                    Open
                  </span>
                </div>
                <div className="mt-3 text-3xl font-bold text-slate-950">
                  {card.totalKey
                    ? data.totals[card.totalKey] || 0
                    : data.cardCounts[card.key] || 0}
                </div>
              </div>
            </Link>
          ))}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <List title="Pending Tasks">
            {data.pendingTasks.length === 0 ? (
              <Empty />
            ) : (
              data.pendingTasks.map((task) => (
                <Row
                  key={task.id}
                  title={
                    task.pim_number ||
                    task.received_number ||
                    "-"
                  }
                  subtitle={`${task.description} / Due ${formatDate(
                    task.due_date || null
                  )}`}
                  href={
                    task.action?.href ||
                    `/pim/case/${task.case_id}`
                  }
                  action={task.action?.label || "View Case"}
                />
              ))
            )}
          </List>

          <List title="Recent Cases">
            {data.recentCases.length === 0 ? (
              <Empty />
            ) : (
              data.recentCases.map((item) => (
                <Row
                  key={item.id}
                  title={
                    item.pim_number ||
                    item.received_number ||
                    "-"
                  }
                  subtitle={`${item.applicant_name || "-"} / ${
                    item.status_name
                  }`}
                  href={`/pim/case/${item.id}`}
                  action="Case"
                />
              ))
            )}
          </List>

          <List title="Recent Activity">
            {data.recentActivity.length === 0 ? (
              <Empty />
            ) : (
              data.recentActivity.map((item) => (
                <Row
                  key={item.id}
                  title={`${item.action || "-"} / ${
                    item.table_name || "-"
                  }`}
                  subtitle={`${item.user_name || "System"} / ${
                    item.reason || "No summary"
                  }`}
                  href={
                    item.pim_number
                      ? `/pim/cases?pimNumber=${encodeURIComponent(
                          item.pim_number
                        )}`
                      : "/pim/audit"
                  }
                  action="Audit"
                />
              ))
            )}
          </List>
        </div>
      </div>
    </main>
  );
}

function QuickActions({
  data,
  hasPermission,
}: {
  data: DashboardData;
  hasPermission: (permission: string) => boolean;
}) {
  const actions = [
    {
      title: "New PIM Filing",
      description: "Enter a fresh pre-institution mediation application.",
      href: "/pim/new",
      permission: "ENTER_APPLICATION",
    },
    {
      title: "Import Legacy Case",
      description: "Reconstruct a PIM workflow from a physical file.",
      href: "/pim/import",
      permission: "IMPORT_LEGACY_CASE",
    },
    {
      title: "Search Cases",
      description: "Find registered and received PIM matters.",
      href: "/pim/search",
      permission: "READ_CASE",
      count: data.totals.totalCases,
    },
    {
      title: "Pending Tasks",
      description: "Open the current work queue.",
      href: "/pim/tasks?status=PENDING",
      permission: "READ_CASE",
      count: data.totals.pendingTasks,
    },
    {
      title: "Form-2 Pending",
      description: "Prepare Form-2 notices awaiting action.",
      href: "/pim/tasks?status=PENDING&taskType=FORM2",
      permission: "READ_CASE",
      count:
        taskCount(data, "FORM2") +
        taskCount(data, "FORM_2"),
    },
    {
      title: "Assign Mediator",
      description: "Pick up mediator assignment tasks.",
      href: "/pim/tasks?status=PENDING&taskType=MEDIATOR_ASSIGNMENT",
      permission: "READ_CASE",
      count: taskCount(data, "MEDIATOR_ASSIGNMENT"),
    },
    {
      title: "Record Mediation Sitting",
      description: "Record scheduled mediation sessions.",
      href: "/pim/tasks?status=PENDING&taskType=SESSION_RECORD",
      permission: "READ_CASE",
      count: taskCount(data, "SESSION_RECORD"),
    },
    {
      title: "Record Outcome",
      description: "Complete pending outcome forms.",
      href: "/pim/tasks?status=PENDING&taskType=OUTCOME_FORM",
      permission: "READ_CASE",
      count: taskCount(data, "OUTCOME_FORM"),
    },
    {
      title: "Mediator Register",
      description: "View panel status and mediator workload.",
      href: "/pim/mediators",
      permission: "READ_MEDIATOR",
      count: data.totals.activeMediators,
    },
    {
      title: "Reports",
      description: "Open registers, monitoring, and statistics.",
      href: "/pim/reports",
      permission: "READ_CASE",
    },
    {
      title: "Settings",
      description: "Review office settings and numbering.",
      href: "/pim/settings",
      permission: "VIEW_SETTINGS",
    },
    {
      title: "Users",
      description: "Manage accounts, roles, and sessions.",
      href: "/pim/users",
      permission: "VIEW_USERS",
    },
    {
      title: "Backup",
      description: `Latest: ${backupAgeLabel(data.latestBackup?.created_at)} / ${data.latestBackup?.status || "not found"}`,
      href: "/pim/settings/backups",
      permission: hasPermission("CREATE_BACKUP")
        ? "CREATE_BACKUP"
        : "VIEW_BACKUP",
    },
  ];
  const visible = actions.filter((action) =>
    hasPermission(action.permission)
  );

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Workbench
          </div>
          <h2 className="mt-1 text-xl font-bold text-slate-950">
          Quick Actions
          </h2>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {visible.map((action, index) => (
          <Link
            key={action.title}
            href={action.href}
            className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-cyan-300 hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`grid h-9 w-9 place-items-center rounded-lg text-sm font-bold text-white ${actionTone(index)}`}>
                  {action.title.slice(0, 1)}
                </div>
                <div className="font-semibold text-slate-950">
                  {action.title}
                </div>
              </div>
              {typeof action.count === "number" && (
                <div className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700">
                  {action.count}
                </div>
              )}
            </div>
            <p className="mt-3 text-sm leading-5 text-slate-500">
              {action.description}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

function OperationalList({
  title,
  rows,
  empty,
  mode,
}: {
  title: string;
  rows: DashboardRow[];
  empty: string;
  mode: "task" | "case" | "sitting" | "mediator";
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
      <div className="mt-4 space-y-3">
        {rows.length === 0 ? (
          <Empty text={empty} />
        ) : (
          rows.map((row) => (
            <div key={`${mode}-${row.id}`} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">
                    {mode === "mediator"
                      ? row.name || row.mediator_name || "-"
                      : row.pim_number || row.received_number || "-"}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {mode === "task"
                      ? `${row.description || "-"} / Due ${formatDate(
                          row.due_date || null
                        )}`
                      : mode === "case"
                        ? `${row.applicant_name || "-"} / ${formatDate(
                            row.internal_60_day_date || null
                          )}`
                        : mode === "sitting"
                          ? `${row.applicant_name || "-"} / Sitting ${
                              row.sitting_number || "-"
                            } / ${row.mediator_name || "-"}`
                          : `${row.category || "-"} / Valid until ${formatDate(
                              row.panel_valid_until || null
                            )}`}
                  </div>
                </div>
                {row.status_name || row.session_status ? (
                  <span
                    className={`rounded-full border px-2 py-1 text-xs font-medium ${statusBadge(
                      row.status_name || row.session_status
                    )}`}
                  >
                    {row.status_name || row.session_status}
                  </span>
                ) : null}
              </div>
              <div className="mt-3 flex gap-2">
                {mode !== "mediator" && (
                  <Link
                    href={`/pim/case/${row.case_id || row.id}`}
                    className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:border-slate-500"
                  >
                    Case
                  </Link>
                )}
                {row.action?.href && !row.action.terminal && (
                  <Link
                    href={row.action.href}
                    className="rounded bg-slate-950 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    {row.action.label || "Continue Workflow"}
                  </Link>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function Summary({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: number;
  tone: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className={`mb-3 h-1.5 rounded-full bg-gradient-to-r ${tone}`} />
      <div className="text-xs font-semibold uppercase text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-3xl font-bold text-slate-950">
        {value || 0}
      </div>
      <div className="mt-1 text-xs text-slate-500">{note}</div>
    </div>
  );
}

function List({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold text-slate-950">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({
  title,
  subtitle,
  href,
  action,
}: {
  title: string;
  subtitle: string;
  href: string;
  action: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div>
        <div className="font-semibold text-slate-900">{title}</div>
        <div className="text-sm text-slate-500">
          {subtitle}
        </div>
      </div>
      <Link
        href={href}
        className="shrink-0 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-500"
      >
        {action}
      </Link>
    </div>
  );
}

function Empty({ text = "No records found." }: { text?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
      {text}
    </div>
  );
}

function MetricPill({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-lg border border-white/15 bg-white/10 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase text-cyan-100">
        {label}
      </div>
      <div className="mt-1 text-xl font-bold text-white">
        {value || 0}
      </div>
    </div>
  );
}

function actionTone(index: number) {
  const tones = [
    "bg-cyan-600",
    "bg-indigo-600",
    "bg-emerald-600",
    "bg-amber-600",
    "bg-rose-600",
    "bg-violet-600",
  ];
  return tones[index % tones.length];
}
