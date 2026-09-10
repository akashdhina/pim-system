"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

type UserDetail = {
  id: number;
  username: string;
  display_name: string;
  designation: string;
  role_code: string;
  active: boolean;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  password_changed_at: string | null;
  must_change_password: boolean;
  active_sessions: number;
};

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-IN");
}

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [user, setUser] = useState<UserDetail | null>(null);
  const [form, setForm] = useState({
    display_name: "",
    designation: "",
    role_code: "aa",
    active: true,
    must_change_password: false,
    reset_lock: false,
  });
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const response = await fetch(`/api/pim/users/${id}`, {
      cache: "no-store",
    });
    const json = await response.json();

    if (!response.ok || !json.success) {
      throw new Error(json.message || "Unable to load user.");
    }

    const nextUser = json.data.user;
    setUser(nextUser);
    setForm({
      display_name: nextUser.display_name,
      designation: nextUser.designation,
      role_code: nextUser.role_code,
      active: nextUser.active,
      must_change_password: nextUser.must_change_password,
      reset_lock: false,
    });
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : "Unable to load user."
        )
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(key: string, value: string | boolean) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/users/${id}`, {
        method: "PATCH",
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
          `${json.message || "Unable to update user."}${details}`
        );
      }

      setNotice("User updated.");
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update user."
      );
    } finally {
      setSaving(false);
    }
  }

  async function resetPassword() {
    if (resetting) return;

    setResetting(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/users/${id}/reset-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          temporary_password: temporaryPassword,
          confirm_password: confirmPassword,
        }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        const details = json.details
          ? ` ${Object.values(json.details).join(" ")}`
          : "";
        throw new Error(
          `${json.message || "Unable to reset password."}${details}`
        );
      }

      setTemporaryPassword("");
      setConfirmPassword("");
      setNotice("Temporary password issued.");
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to reset password."
      );
    } finally {
      setResetting(false);
    }
  }

  async function revokeSessions() {
    if (revoking) return;

    setRevoking(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/pim/users/${id}/revoke-sessions`, {
        method: "POST",
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || "Unable to revoke sessions.");
      }

      setNotice(`Revoked ${json.data.revokedSessions} session(s).`);
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to revoke sessions."
      );
    } finally {
      setRevoking(false);
    }
  }

  if (loading) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">Loading user...</div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
          {error || "User not found."}
        </div>
      </main>
    );
  }

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">
              {user.username}
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Last login: {formatDate(user.last_login_at)}
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
        {notice && (
          <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            {notice}
          </div>
        )}

        <form
          onSubmit={save}
          className="space-y-4 rounded-lg border bg-white p-5 shadow-sm"
        >
          <h2 className="text-lg font-semibold">Profile and Role</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Display name">
              <input
                value={form.display_name}
                onChange={(event) =>
                  update("display_name", event.target.value)
                }
                className="mt-2 w-full rounded border p-3 text-sm"
              />
            </Field>
            <Field label="Designation">
              <input
                value={form.designation}
                onChange={(event) =>
                  update("designation", event.target.value)
                }
                className="mt-2 w-full rounded border p-3 text-sm"
              />
            </Field>
            <Field label="Role">
              <select
                value={form.role_code}
                onChange={(event) =>
                  update("role_code", event.target.value)
                }
                className="mt-2 w-full rounded border p-3 text-sm"
              >
                <option value="aa">AA</option>
                <option value="secretary">Secretary</option>
                <option value="chairman">Chairman</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <div className="grid content-end gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(event) =>
                    update("active", event.target.checked)
                  }
                />
                Active
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.must_change_password}
                  onChange={(event) =>
                    update("must_change_password", event.target.checked)
                  }
                />
                Force password change
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.reset_lock}
                  onChange={(event) =>
                    update("reset_lock", event.target.checked)
                  }
                />
                Reset failed login lock
              </label>
            </div>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save User"}
          </button>
        </form>

        <section className="grid gap-3 md:grid-cols-4">
          <Info label="Failed logins" value={String(user.failed_login_count)} />
          <Info label="Locked until" value={formatDate(user.locked_until)} />
          <Info label="Password changed" value={formatDate(user.password_changed_at)} />
          <Info label="Active sessions" value={String(user.active_sessions)} />
        </section>

        <section className="grid gap-5 md:grid-cols-2">
          <div className="space-y-4 rounded-lg border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Reset Password</h2>
            <Field label="Temporary password">
              <input
                type="password"
                value={temporaryPassword}
                onChange={(event) =>
                  setTemporaryPassword(event.target.value)
                }
                autoComplete="new-password"
                className="mt-2 w-full rounded border p-3 text-sm"
              />
            </Field>
            <Field label="Confirm temporary password">
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) =>
                  setConfirmPassword(event.target.value)
                }
                autoComplete="new-password"
                className="mt-2 w-full rounded border p-3 text-sm"
              />
            </Field>
            <button
              type="button"
              onClick={resetPassword}
              disabled={resetting}
              className="rounded border px-5 py-2 text-sm font-medium disabled:opacity-50"
            >
              {resetting ? "Issuing..." : "Issue Temporary Password"}
            </button>
          </div>

          <div className="space-y-4 rounded-lg border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Sessions</h2>
            <p className="text-sm text-gray-600">
              Revoke active sessions for this user after a device or password concern.
            </p>
            <button
              type="button"
              onClick={revokeSessions}
              disabled={revoking}
              className="rounded border px-5 py-2 text-sm font-medium disabled:opacity-50"
            >
              {revoking ? "Revoking..." : "Revoke Sessions"}
            </button>
          </div>
        </section>
      </div>
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
