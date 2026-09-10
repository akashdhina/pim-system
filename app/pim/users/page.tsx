"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePimAuth } from "../../../lib/use-pim-auth";

type UserRow = {
  id: number;
  username: string;
  display_name: string;
  designation: string;
  role_code: string;
  active: boolean;
  failed_login_count: number;
  locked_until: string | null;
  must_change_password: boolean;
  active_sessions: number;
};

type UserData = {
  data: UserRow[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export default function UsersPage() {
  const { hasPermission } = usePimAuth();
  const [data, setData] = useState<UserData | null>(null);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [active, setActive] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const canManage = hasPermission("MANAGE_USERS");

  useEffect(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "25",
    });
    if (search) params.set("search", search);
    if (role) params.set("role", role);
    if (active) params.set("active", active);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/pim/users?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Unable to load users.");
        }
        return json.data;
      })
      .then(setData)
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Unable to load users."
        );
      })
      .finally(() => setLoading(false));
  }, [active, page, role, search]);

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">
              Users
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Manage PIM roles, account status, and sessions.
            </p>
          </div>
          {canManage && (
            <Link
              href="/pim/users/new"
              className="rounded bg-black px-4 py-2 text-sm font-medium text-white"
            >
              New User
            </Link>
          )}
        </div>

        <section className="grid gap-3 rounded-lg border bg-white p-4 shadow-sm md:grid-cols-4">
          <input
            value={search}
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            placeholder="Search users"
            className="rounded border p-3 text-sm"
          />
          <select
            value={role}
            onChange={(event) => {
              setPage(1);
              setRole(event.target.value);
            }}
            className="rounded border p-3 text-sm"
          >
            <option value="">All roles</option>
            <option value="aa">AA</option>
            <option value="secretary">Secretary</option>
            <option value="chairman">Chairman</option>
            <option value="admin">Admin</option>
          </select>
          <select
            value={active}
            onChange={(event) => {
              setPage(1);
              setActive(event.target.value);
            }}
            className="rounded border p-3 text-sm"
          >
            <option value="">All statuses</option>
            <option value="1">Active</option>
            <option value="0">Inactive</option>
          </select>
          <Link
            href="/pim"
            className="rounded border px-4 py-3 text-center text-sm font-medium"
          >
            Dashboard
          </Link>
        </section>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        <section className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <Th>Username</Th>
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Failed</Th>
                  <Th>Sessions</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td className="p-4" colSpan={7}>
                      Loading users...
                    </td>
                  </tr>
                ) : !data || data.data.length === 0 ? (
                  <tr>
                    <td className="p-4" colSpan={7}>
                      No users found.
                    </td>
                  </tr>
                ) : (
                  data.data.map((user) => (
                    <tr key={user.id}>
                      <Td>{user.username}</Td>
                      <Td>
                        <div className="font-medium">
                          {user.display_name}
                        </div>
                        <div className="text-xs text-gray-500">
                          {user.designation}
                        </div>
                      </Td>
                      <Td>{user.role_code}</Td>
                      <Td>
                        {user.active ? "Active" : "Inactive"}
                        {user.must_change_password
                          ? " / Change required"
                          : ""}
                        {user.locked_until ? " / Locked" : ""}
                      </Td>
                      <Td>{user.failed_login_count}</Td>
                      <Td>{user.active_sessions}</Td>
                      <Td>
                        <Link
                          href={`/pim/users/${user.id}`}
                          className="rounded border px-3 py-2 text-xs font-medium"
                        >
                          Open
                        </Link>
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {data && (
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
              className="rounded border px-3 py-2 disabled:opacity-40"
            >
              Previous
            </button>
            <span>
              Page {data.pagination.page} of {data.pagination.totalPages}
            </span>
            <button
              type="button"
              onClick={() =>
                setPage((current) =>
                  Math.min(data.pagination.totalPages, current + 1)
                )
              }
              disabled={page >= data.pagination.totalPages}
              className="rounded border px-3 py-2 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-4 py-3 font-semibold">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="whitespace-nowrap px-4 py-3">{children}</td>;
}
