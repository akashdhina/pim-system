"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import Link from "next/link";
import { useEffect, useState } from "react";

type SystemInfo = Record<string, any>;

function formatSize(value: number) {
  if (!value) return "0 MB";
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-IN");
}

export default function AboutPage() {
  const [data, setData] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/pim/system-info", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Unable to load system information.");
        }
        return json.data;
      })
      .then(setData)
      .catch((err) =>
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load system information."
        )
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">
              About / System Health
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Application status for office operation checks.
            </p>
          </div>
          <Link href="/pim" className="rounded border px-4 py-2 text-sm font-medium">
            Dashboard
          </Link>
        </div>

        {loading ? (
          <div className="rounded-lg border bg-white p-6">Loading system status...</div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
            {error}
          </div>
        ) : data ? (
          <>
            <section className="grid gap-3 md:grid-cols-3">
              <Info label="Application" value={data.applicationName} />
              <Info label="Version" value={data.version || "-"} />
              <Info label="Environment" value={data.environment} />
              <Info label="Database" value={data.databaseReachable ? "Reachable" : "Unavailable"} />
              <Info label="SQLite integrity" value={data.sqliteIntegrity?.[0]?.integrity_check || "-"} />
              <Info label="Foreign key issues" value={String(data.foreignKeyIssues)} />
              <Info label="Database size" value={formatSize(data.databaseFileSize)} />
              <Info label="Document storage" value={formatSize(data.documentStorageSize)} />
              <Info label="Total cases" value={String(data.totalCases)} />
              <Info label="Latest backup" value={formatDate(data.latestBackup?.created_at || null)} />
              <Info label="Backup status" value={data.latestBackup?.status || "not found"} />
              <Info label="Timezone" value={data.timezone} />
            </section>

            <section className="rounded-lg border bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Current User</h2>
              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <Info label="Name" value={data.currentUser.display_name} />
                <Info label="Username" value={data.currentUser.username} />
                <Info label="Designation" value={data.currentUser.designation} />
                <Info label="Role" value={data.currentUser.role} />
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase text-gray-500">
        {label}
      </div>
      <div className="mt-2 text-sm font-semibold text-gray-950">
        {value}
      </div>
    </div>
  );
}
