"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePimAuth } from "../../../../lib/use-pim-auth";

type Backup = {
  id: string;
  created_at?: string;
  created_by?: string | number | null;
  file_size?: number;
  status?: string;
  integrity_result?: Record<string, string>[];
  foreign_key_result?: Record<string, string | number>[];
  application_version?: string | null;
};

type BackupData = {
  backups: Backup[];
  latest: Backup | null;
  database: {
    database_size: number;
    status: string;
    integrity_result: Record<string, string>[];
    foreign_key_result: Record<string, string | number>[];
  };
  retention: {
    kept: number;
    deleted: string[];
    retentionCount: number;
    retentionDays: number;
  };
};

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-IN");
}

function size(value?: number) {
  if (!value) return "-";
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function ageHours(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

export default function BackupRecoveryPage() {
  const { hasPermission, loading: authLoading } = usePimAuth();
  const [data, setData] = useState<BackupData | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const canCreate = hasPermission("CREATE_BACKUP");
  const canDownload = hasPermission("DOWNLOAD_BACKUP");
  const canDelete = hasPermission("DELETE_BACKUP");
  const canView = hasPermission("VIEW_BACKUP");

  async function load() {
    const response = await fetch("/api/pim/backups", {
      cache: "no-store",
    });
    const json = await response.json();

    if (!response.ok || !json.success) {
      throw new Error(json.message || "Unable to load backups.");
    }

    setData(json.data);
  }

  useEffect(() => {
    if (authLoading) return;
    if (!canView) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Unable to load backups."
        );
      });
  }, [authLoading, canView]);

  async function createBackup() {
    if (!canCreate || saving) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/pim/backups", {
        method: "POST",
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to create backup.");
      }

      setNotice(json.message || "Backup created.");
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to create backup."
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteBackup(id: string) {
    if (!canDelete || deleting) return;
    if (!confirm("Delete this backup?")) return;

    setDeleting(id);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/backups/${id}`, {
        method: "DELETE",
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to delete backup.");
      }

      setNotice(json.message || "Backup deleted.");
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to delete backup."
      );
    } finally {
      setDeleting("");
    }
  }

  if (authLoading || (canView && !data && !error)) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          Loading backups...
        </div>
      </main>
    );
  }

  if (!canView) {
    return (
      <main className="p-6">
        <div className="mx-auto max-w-3xl rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
          You do not have permission to view backup records.
        </div>
      </main>
    );
  }

  const latestAge = ageHours(data?.latest?.created_at);
  const stale = latestAge === null || latestAge > 24;

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold">Backup & Recovery</h1>
            <p className="mt-1 text-sm text-gray-500">
              Create and verify controlled SQLite backups for the local pilot.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={createBackup}
              disabled={!canCreate || saving}
              className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {saving ? "Creating..." : "Create Backup"}
            </button>
            <Link
              href="/pim/settings"
              className="rounded border px-4 py-2 text-sm font-medium"
            >
              Office Settings
            </Link>
          </div>
        </div>

        {stale && (
          <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Latest backup is missing or older than 24 hours.
          </div>
        )}
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

        {data && (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Info label="Latest backup" value={formatDate(data.latest?.created_at)} />
            <Info label="Database size" value={size(data.database.database_size)} />
            <Info label="Integrity" value={data.database.status} />
            <Info label="Retention" value={`Keep ${data.retention.retentionCount} / ${data.retention.retentionDays} days`} />
          </section>
        )}

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">Restore Instructions</h2>
          <p className="text-sm text-gray-600">
            Restore remains a manual recovery procedure while the app is stopped.
          </p>
          <Link
            href="/api/pim/backups/restore-instructions"
            className="mt-3 inline-flex rounded border px-4 py-2 text-sm font-medium"
          >
            Restore procedure document
          </Link>
        </section>

        <section className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <Th>Backup</Th>
                  <Th>Created</Th>
                  <Th>Created by</Th>
                  <Th>Size</Th>
                  <Th>Status</Th>
                  <Th>Foreign keys</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {!data || data.backups.length === 0 ? (
                  <tr>
                    <td className="p-4" colSpan={7}>
                      No backups found.
                    </td>
                  </tr>
                ) : (
                  data.backups.map((backup) => (
                    <tr key={backup.id}>
                      <Td>{backup.id}</Td>
                      <Td>{formatDate(backup.created_at)}</Td>
                      <Td>{backup.created_by ?? "-"}</Td>
                      <Td>{size(backup.file_size)}</Td>
                      <Td>{backup.status || "-"}</Td>
                      <Td>
                        {backup.foreign_key_result?.length
                          ? `${backup.foreign_key_result.length} issue(s)`
                          : "ok"}
                      </Td>
                      <Td>
                        <div className="flex gap-2">
                          {canDownload && (
                            <a
                              href={`/api/pim/backups/${backup.id}/download`}
                              className="rounded border px-3 py-2 text-xs font-medium"
                            >
                              Download
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => deleteBackup(backup.id)}
                            disabled={!canDelete || deleting === backup.id}
                            className="rounded border px-3 py-2 text-xs font-medium disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
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
