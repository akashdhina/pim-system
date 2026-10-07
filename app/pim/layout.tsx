"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  FormEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePimAuth } from "../../lib/use-pim-auth";

type NavItem = {
  href: string;
  label: string;
  permission?: string;
  disabled?: boolean;
};

const navItems: NavItem[] = [
  { href: "/pim", label: "Dashboard", permission: "READ_CASE" },
  {
    href: "/pim/new",
    label: "New Application",
    permission: "ENTER_APPLICATION",
  },
  {
    href: "/pim/import",
    label: "Legacy Import",
    permission: "IMPORT_LEGACY_CASE",
  },
  { href: "/pim/cases", label: "Cases", permission: "READ_CASE" },
  { href: "/pim/mediators", label: "Mediators", permission: "READ_MEDIATOR" },
  { href: "/pim/tasks", label: "Pending Tasks", permission: "READ_CASE" },
  {
    href: "/pim/reports",
    label: "Reports",
    permission: "READ_CASE",
  },
  {
    href: "/pim/audit",
    label: "Audit",
    permission: "VIEW_AUDIT",
  },
  {
    href: "/pim/settings",
    label: "Settings",
    permission: "VIEW_SETTINGS",
  },
  {
    href: "/pim/users",
    label: "Users",
    permission: "VIEW_USERS",
  },
  { href: "/pim/help", label: "Help" },
  { href: "/pim/about", label: "About" },
];

export default function PimLayout({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isPublicAuthPage =
    pathname === "/pim/login" ||
    pathname === "/pim/change-password";

  if (isPublicAuthPage) {
    return children;
  }

  return (
    <ProtectedPimLayout pathname={pathname}>
      {children}
    </ProtectedPimLayout>
  );
}

function ProtectedPimLayout({
  children,
  pathname,
}: {
  children: ReactNode;
  pathname: string;
}) {
  const router = useRouter();
  const {
    authenticated,
    loading,
    user,
    hasPermission,
    refreshAuth,
  } = usePimAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [search, setSearch] = useState("");
  const lastRedirectTarget = useRef("");

  useEffect(() => {
    if (loading) return;

    if (!authenticated) {
      const next = encodeURIComponent(pathname || "/pim");
      const target = `/pim/login?next=${next}`;
      if (lastRedirectTarget.current !== target) {
        lastRedirectTarget.current = target;
        router.replace(target);
      }
      return;
    }

    if (
      authenticated &&
      user?.must_change_password
    ) {
      const target = "/pim/change-password";
      if (lastRedirectTarget.current !== target) {
        lastRedirectTarget.current = target;
        router.replace(target);
      }
    }
  }, [
    authenticated,
    loading,
    pathname,
    router,
    user?.must_change_password,
  ]);

  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    await fetch("/api/pim/auth/logout", {
      method: "POST",
    });
    await refreshAuth();
    router.replace("/pim/login");
    router.refresh();
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = search.trim();
    if (query.length < 2) return;
    router.push(`/pim/search?q=${encodeURIComponent(query)}`);
    setSearch("");
  }

  const visibleItems = navItems.filter(
    (item) =>
      !item.permission || hasPermission(item.permission)
  );
  const workflowMatch = pathname.match(
    /^\/pim\/(approval|fee|form2|mediation|mediator|outcome|response|scrutiny|service)\/(\d+)$/
  );
  const workflowCaseId =
    workflowMatch && workflowMatch[1] !== "mediation"
      ? workflowMatch[2]
      : workflowMatch &&
          pathname.startsWith("/pim/mediation/") &&
          !pathname.startsWith("/pim/mediation/session/")
        ? workflowMatch[2]
        : null;

  if (loading || !authenticated) {
    return (
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {loading ? "Loading PIM access..." : "Redirecting to login..."}
        </div>
      </main>
    );
  }

  if (user?.must_change_password) {
    return (
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          Redirecting to password change...
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/95 shadow-sm print:hidden">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between md:px-6">
          <div>
            <Link
              href="/pim"
              className="text-lg font-bold text-slate-950"
            >
              DLSA Nilgiris PIM
            </Link>
            <div className="text-sm text-slate-500">
              Case Management System
            </div>
          </div>

          <form
            onSubmit={submitSearch}
            className="flex min-w-0 flex-1 gap-2 lg:max-w-md"
          >
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search cases"
              className="min-w-0 flex-1 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-cyan-500 focus:bg-white"
            />
            <button
              type="submit"
              disabled={search.trim().length < 2}
              className="rounded bg-slate-950 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40"
            >
              Search
            </button>
          </form>

          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 md:text-right">
            <div className="font-semibold text-slate-950">
              {user?.display_name || "-"}
            </div>
            <div className="mb-2">
              {user?.designation || "-"} / {user?.role || "-"}
            </div>
            <button
              type="button"
              onClick={logout}
              disabled={signingOut}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:border-slate-500 disabled:opacity-50"
            >
              {signingOut ? "Signing out..." : "Logout"}
            </button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-7xl gap-2 overflow-x-auto px-4 pb-4 md:px-6">
          {visibleItems.map((item) =>
            item.disabled ? (
              <span
                key={item.href}
                className="whitespace-nowrap rounded border px-3 py-2 text-sm text-gray-400"
                title="Placeholder"
              >
                {item.label}
              </span>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className={`whitespace-nowrap rounded px-3 py-2 text-sm font-medium transition ${
                  pathname === item.href
                    ? "bg-gradient-to-r from-slate-950 to-cyan-700 text-white shadow-sm"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                {item.label}
              </Link>
            )
          )}
        </nav>
      </header>

      {workflowCaseId && (
        <div className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl gap-2 px-4 py-3 text-sm md:px-6">
            <Link
              href={`/pim/case/${workflowCaseId}`}
              className="rounded border border-slate-300 bg-slate-50 px-3 py-2 font-medium hover:border-slate-500"
            >
              Back to Case
            </Link>
            <Link
              href="/pim/tasks"
              className="rounded border border-slate-300 bg-slate-50 px-3 py-2 font-medium hover:border-slate-500"
            >
              Back to Tasks
            </Link>
            <Link
              href="/pim"
              className="rounded border border-slate-300 bg-slate-50 px-3 py-2 font-medium hover:border-slate-500"
            >
              Dashboard
            </Link>
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
