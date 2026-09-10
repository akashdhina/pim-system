"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import { usePimAuth } from "../../../lib/use-pim-auth";

function safeNextPath() {
  if (typeof window === "undefined") return "/pim";

  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/pim") || next.startsWith("//")) {
    return "/pim";
  }

  if (next === "/pim/login") return "/pim";
  return next;
}

export default function PimLoginPage() {
  const router = useRouter();
  const { authenticated, loading, refreshAuth, user } = usePimAuth();
  const redirected = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (loading || !authenticated) return;
    if (redirected.current) return;
    redirected.current = true;

    if (user?.must_change_password) {
      router.replace("/pim/change-password");
      return;
    }

    router.replace("/pim");
  }, [authenticated, loading, router, user?.must_change_password]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setError("");
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/pim/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username,
          password,
        }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(
          response.status === 401
            ? "Invalid username or password."
            : json.message || "Unable to sign in."
        );
      }

      await refreshAuth();

      if (json.must_change_password) {
        router.replace("/pim/change-password");
      } else {
        router.replace(safeNextPath());
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to sign in."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-100 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border bg-white p-6 shadow-sm"
      >
        <h1 className="text-2xl font-bold text-gray-950">PIM Login</h1>
        <p className="mt-1 text-sm text-gray-500">
          Sign in to continue to DLSA Nilgiris PIM.
        </p>

        {error && (
          <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <label className="mt-5 block">
          <span className="text-sm font-medium text-gray-700">
            Username
          </span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-gray-700">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className="mt-2 w-full rounded border p-3 text-sm"
          />
        </label>

        <button
          type="submit"
          disabled={submitting}
          className="mt-6 w-full rounded bg-black px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </main>
  );
}
