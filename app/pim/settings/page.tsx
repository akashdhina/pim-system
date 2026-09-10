"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePimAuth } from "../../../lib/use-pim-auth";

type Settings = Record<string, string>;

const sections = [
  {
    title: "Authority",
    keys: [
      "authority_name",
      "authority_short_name",
      "authority_address_line_1",
      "authority_address_line_2",
      "district_name",
      "state_name",
      "pin_code",
      "phone",
      "email",
      "default_mediation_venue",
    ],
  },
  {
    title: "Signatories",
    keys: [
      "chairman_name",
      "chairman_designation",
      "secretary_name",
      "secretary_designation",
      "document_footer",
    ],
  },
  {
    title: "Numbering and Backup",
    keys: [
      "pim_number_prefix",
      "received_number_prefix",
      "timezone",
      "backup_retention_days",
      "backup_retention_count",
    ],
  },
];

const labels: Record<string, string> = {
  authority_name: "Authority name",
  authority_short_name: "Short name",
  authority_address_line_1: "Address line 1",
  authority_address_line_2: "Address line 2",
  district_name: "District",
  state_name: "State",
  pin_code: "PIN code",
  phone: "Phone",
  email: "Email",
  default_mediation_venue: "Default mediation venue",
  chairman_name: "Chairman name",
  chairman_designation: "Chairman designation",
  secretary_name: "Secretary name",
  secretary_designation: "Secretary designation",
  document_footer: "Document footer",
  pim_number_prefix: "PIM number prefix",
  received_number_prefix: "Received number prefix",
  timezone: "Timezone",
  backup_retention_days: "Backup retention days",
  backup_retention_count: "Backup retention count",
};

function inputType(key: string) {
  if (key === "email") return "email";
  if (key === "backup_retention_days" || key === "backup_retention_count") {
    return "number";
  }
  return "text";
}

export default function OfficeSettingsPage() {
  const { hasPermission } = usePimAuth();
  const [settings, setSettings] = useState<Settings>({});
  const [draft, setDraft] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canManage = hasPermission("MANAGE_SETTINGS");
  const canViewBackups = hasPermission("VIEW_BACKUP");

  useEffect(() => {
    fetch("/api/pim/settings", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Unable to load settings.");
        }
        return json.data.settings;
      })
      .then((nextSettings) => {
        setSettings(nextSettings);
        setDraft(nextSettings);
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Unable to load settings."
        );
      })
      .finally(() => setLoading(false));
  }, []);

  function update(key: string, value: string) {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function save() {
    if (!canManage || saving) return;
    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/pim/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        const details = json.details
          ? ` ${Object.values(json.details).join(" ")}`
          : "";
        throw new Error(
          `${json.message || "Unable to update settings."}${details}`
        );
      }

      setSettings(json.data.settings);
      setDraft(json.data.settings);
      setNotice(json.message || "Settings updated.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update settings."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          Loading office settings...
        </div>
      </main>
    );
  }

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold">Office Settings</h1>
            <p className="mt-1 text-sm text-gray-500">
              Authority details used for future numbering, documents, and backups.
            </p>
          </div>
          <div className="flex gap-2">
            {canViewBackups && (
              <Link
                href="/pim/settings/backups"
                className="rounded border px-4 py-2 text-sm font-medium"
              >
                Backup & Recovery
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

        {!canManage && (
          <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Settings are read-only for your role.
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

        {sections.map((section) => (
          <section
            key={section.title}
            className="rounded-lg border bg-white p-5 shadow-sm"
          >
            <h2 className="mb-4 text-lg font-semibold">{section.title}</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {section.keys.map((key) => (
                <label key={key} className="block">
                  <span className="text-sm font-medium text-gray-700">
                    {labels[key] || key}
                  </span>
                  <input
                    type={inputType(key)}
                    value={draft[key] || ""}
                    disabled={!canManage}
                    onChange={(event) => update(key, event.target.value)}
                    className="mt-2 w-full rounded border p-3 text-sm disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </label>
              ))}
            </div>
          </section>
        ))}

        {canManage && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={save}
              disabled={saving || JSON.stringify(settings) === JSON.stringify(draft)}
              className="rounded bg-black px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Settings"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
