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
  },
  {
    key: "secretary_approval",
    label: "Secretary approval",
    href: "/pim/cases?status=SECRETARY_APPROVAL_PENDING",
  },
  {
    key: "form2_pending",
    label: "Form-2 pending",
    href: "/pim/cases?status=FORM2_PENDING",
  },
  {
    key: "service_pending",
    label: "Service pending",
    href: "/pim/cases?status=SERVICE_PENDING",
  },
  {
    key: "op_response_pending",
    label: "OP response/consent pending",
    href: "/pim/cases?status=OP_CONSENT_PENDING",
  },
  {
    key: "fee_pending",
    label: "Fee pending",
    href: "/pim/cases?status=FEE_PENDING",
  },
  {
    key: "mediator_assignment",
    label: "Mediator assignment",
    href: "/pim/cases?status=MEDIATOR_ASSIGNMENT_PENDING",
  },
  {
    key: "first_mediation",
    label: "First mediation",
    href: "/pim/tasks?status=PENDING&taskType=FIRST_MEDIATION",
  },
  {
    key: "session_recording",
    label: "Session recording",
    href: "/pim/tasks?status=PENDING&taskType=SESSION_RECORD",
  },
  {
    key: "outcome_form",
    label: "Outcome form",
    href: "/pim/tasks?status=PENDING&taskType=OUTCOME_FORM",
  },
  {
    key: "authority_decision",
    label: "Authority decision",
    href: "/pim/tasks?status=PENDING&taskType=NONSTARTER_AUTHORITY",
  },
  {
    key: "closed_settled",
    label: "Closed settled",
    href: "/pim/cases?status=CLOSED_SETTLED",
  },
  {
    key: "closed_failed",
    label: "Closed failed",
    href: "/pim/cases?status=CLOSED_FAILED",
  },
  {
    key: "withdrawn",
    label: "Withdrawn",
    href: "/pim/cases?status=WITHDRAWN",
  },
  {
    key: "closed_non_starter",
    label: "Closed non-starter",
    href: "/pim/cases?status=CLOSED_NON_STARTER",
  },
  {
    key: "overdue_tasks",
    label: "Overdue tasks",
    href: "/pim/tasks?status=PENDING&overdue=1",
    totalKey: "overdueTasks",
  },
  {
    key: "approaching_60_day",
    label: "60-day deadline approaching",
    href: "/pim/cases?deadline=approaching&openClosed=open",
    totalKey: "approaching60Day",
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
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          Loading dashboard...
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
          {error}
        </div>
      </main>
    );
  }

  if (!data) return null;

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <section>
          <h1 className="text-2xl font-bold text-gray-950">
            PIM Dashboard
          </h1>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Summary
              label="Total cases"
              value={data.totals.totalCases}
            />
            <Summary
              label="Open cases"
              value={data.totals.openCases}
            />
            <Summary
              label="Closed cases"
              value={data.totals.closedCases}
            />
            <Summary
              label="Pending tasks"
              value={data.totals.pendingTasks}
            />
            <Summary
              label="Overdue tasks"
              value={data.totals.overdueTasks}
            />
            <Summary
              label="60-day due soon"
              value={data.totals.approaching60Day}
            />
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
          <section className="rounded-lg border bg-white p-5 shadow-sm">
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
                className="mt-4 inline-flex rounded border px-3 py-2 text-sm font-medium"
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
              className="rounded-lg border bg-white p-4 shadow-sm hover:border-gray-400"
            >
              <div className="text-sm font-medium text-gray-600">
                {card.label}
              </div>
              <div className="mt-3 text-3xl font-bold text-gray-950">
                {card.totalKey
                  ? data.totals[card.totalKey] || 0
                  : data.cardCounts[card.key] || 0}
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
      <div>
        <h2 className="text-lg font-semibold text-gray-950">
          Quick Actions
        </h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {visible.map((action) => (
          <Link
            key={action.title}
            href={action.href}
            className="rounded-lg border bg-white p-4 shadow-sm hover:border-gray-400"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="font-semibold text-gray-950">
                {action.title}
              </div>
              {typeof action.count === "number" && (
                <div className="rounded border bg-gray-50 px-2 py-1 text-xs font-semibold text-gray-700">
                  {action.count}
                </div>
              )}
            </div>
            <p className="mt-2 text-sm text-gray-500">
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
    <section className="rounded-lg border bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-950">{title}</h2>
      <div className="mt-4 space-y-3">
        {rows.length === 0 ? (
          <Empty text={empty} />
        ) : (
          rows.map((row) => (
            <div key={`${mode}-${row.id}`} className="rounded border p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">
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
                    className="rounded border px-3 py-2 text-xs font-medium"
                  >
                    Case
                  </Link>
                )}
                {row.action?.href && !row.action.terminal && (
                  <Link
                    href={row.action.href}
                    className="rounded bg-black px-3 py-2 text-xs font-medium text-white"
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
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase text-gray-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold">
        {value || 0}
      </div>
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
    <section className="rounded-lg border bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold">
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
    <div className="flex items-center justify-between gap-4 rounded border p-3">
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-sm text-gray-500">
          {subtitle}
        </div>
      </div>
      <Link
        href={href}
        className="shrink-0 rounded border px-3 py-2 text-sm font-medium"
      >
        {action}
      </Link>
    </div>
  );
}

function Empty({ text = "No records found." }: { text?: string }) {
  return (
    <div className="rounded border bg-gray-50 p-4 text-sm text-gray-500">
      {text}
    </div>
  );
}
