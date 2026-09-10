"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import { usePimAuth } from "../../../lib/use-pim-auth";

export default function ChangePasswordPage() {
  const router = useRouter();
  const {
    authenticated,
    loading,
    refreshAuth,
    user,
  } = usePimAuth();
  const redirected = useRef(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (loading || authenticated || redirected.current) return;

    redirected.current = true;
    router.replace("/pim/login?next=%2Fpim%2Fchange-password");
  }, [authenticated, loading, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/pim/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        const details = json.details
          ? ` ${Object.values(json.details).join(" ")}`
          : "";
        throw new Error(
          `${json.message || "Unable to change password."}${details}`
        );
      }

      setNotice("Password changed. Redirecting...");
      await refreshAuth();
      router.replace("/pim");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to change password."
      );
    } finally {
      setSaving(false);
    }
  }

  const firstLogin = Boolean(user?.must_change_password);

  if (loading || !authenticated) {
    return (
      <main className="p-6">
        <div className="rounded-lg border bg-white p-6">
          {loading ? "Loading password form..." : "Redirecting to login..."}
        </div>
      </main>
    );
  }

  return (
    <main className="p-4 md:p-6">
      <form
        onSubmit={submit}
        className="mx-auto max-w-lg rounded-lg border bg-white p-6 shadow-sm"
      >
        <h1 className="text-2xl font-bold text-gray-950">
          Change Password
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {firstLogin
            ? "Set a new password before continuing."
            : "Update your account password."}
        </p>

        {error && (
          <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}
        {notice && (
          <div className="mt-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            {notice}
          </div>
        )}

        {!firstLogin && (
          <label className="mt-5 block">
            <span className="text-sm font-medium text-gray-700">
              Current password
            </span>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              className="mt-2 w-full rounded border p-3 text-sm"
            />
          </label>
        )}

        <label className="mt-5 block">
          <span className="text-sm font-medium text-gray-700">
            New password
          </span>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-gray-700">
            Confirm new password
          </span>
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </label>

        <button
          type="submit"
          disabled={saving}
          className="mt-6 w-full rounded bg-black px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving..." : "Change Password"}
        </button>
      </form>
    </main>
  );
}
