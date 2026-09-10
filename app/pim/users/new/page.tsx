"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function NewUserPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    username: "",
    display_name: "",
    designation: "",
    role_code: "aa",
    active: true,
    temporary_password: "",
    confirm_password: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function update(key: string, value: string | boolean) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError("");

    try {
      const response = await fetch("/api/pim/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        const details = json.details
          ? ` ${Object.values(json.details).join(" ")}`
          : "";
        throw new Error(
          `${json.message || "Unable to create user."}${details}`
        );
      }

      router.replace(`/pim/users/${json.data.user.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to create user."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="p-4 md:p-6">
      <form
        onSubmit={submit}
        className="mx-auto max-w-2xl space-y-5 rounded-lg border bg-white p-6 shadow-sm"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">
              New User
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Create an account with a temporary password.
            </p>
          </div>
          <Link
            href="/pim/users"
            className="rounded border px-4 py-2 text-sm font-medium"
          >
            Users
          </Link>
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <Field label="Username">
          <input
            value={form.username}
            onChange={(event) => update("username", event.target.value)}
            autoComplete="off"
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </Field>
        <Field label="Display name">
          <input
            value={form.display_name}
            onChange={(event) => update("display_name", event.target.value)}
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </Field>
        <Field label="Designation">
          <input
            value={form.designation}
            onChange={(event) => update("designation", event.target.value)}
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </Field>
        <Field label="Role">
          <select
            value={form.role_code}
            onChange={(event) => update("role_code", event.target.value)}
            className="mt-2 w-full rounded border p-3 text-sm"
          >
            <option value="aa">AA</option>
            <option value="secretary">Secretary</option>
            <option value="chairman">Chairman</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(event) => update("active", event.target.checked)}
          />
          Active
        </label>
        <Field label="Temporary password">
          <input
            type="password"
            value={form.temporary_password}
            onChange={(event) =>
              update("temporary_password", event.target.value)
            }
            autoComplete="new-password"
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </Field>
        <Field label="Confirm temporary password">
          <input
            type="password"
            value={form.confirm_password}
            onChange={(event) =>
              update("confirm_password", event.target.value)
            }
            autoComplete="new-password"
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </Field>

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded bg-black px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Creating..." : "Create User"}
        </button>
      </form>
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}
