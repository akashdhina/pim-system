"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type SearchRow = {
  id: number;
  pim_number: string | null;
  received_number: string | null;
  applicant_name: string | null;
  opposite_party_name: string | null;
  status_name: string;
  pending_task_description: string | null;
  pending_task_due_date: string | null;
  action?: {
    href?: string | null;
    label?: string;
    terminal?: boolean;
    missingPage?: boolean;
  };
};

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN");
}

export default function SearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const q = searchParams.get("q") || "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery(q);

    if (q.trim().length < 2) {
      setRows([]);
      return;
    }

    setLoading(true);
    setError("");
    fetch(`/api/pim/search?q=${encodeURIComponent(q)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Unable to search.");
        }
        return json.data.rows;
      })
      .then(setRows)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to search.")
      )
      .finally(() => setLoading(false));
  }, [searchParams]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      setError("Enter at least 2 characters.");
      setRows([]);
      return;
    }
    router.replace(`/pim/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">
              Search Cases
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Search by case number, party, advocate, mediator, or contact.
            </p>
          </div>
          <Link
            href="/pim"
            className="rounded border px-4 py-2 text-sm font-medium"
          >
            Dashboard
          </Link>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-lg border bg-white p-4 shadow-sm md:flex-row"
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search PIM number, party, advocate, mediator, mobile"
            className="min-w-0 flex-1 rounded border px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? "Searching..." : "Search"}
          </button>
        </form>

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
                  <Th>PIM number</Th>
                  <Th>Received number</Th>
                  <Th>Applicant</Th>
                  <Th>Opposite party</Th>
                  <Th>Status</Th>
                  <Th>Next pending task</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td className="p-4" colSpan={7}>
                      Searching...
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="p-4" colSpan={7}>
                      No cases found.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id}>
                      <Td>{row.pim_number || "-"}</Td>
                      <Td>{row.received_number || "-"}</Td>
                      <Td>{row.applicant_name || "-"}</Td>
                      <Td>{row.opposite_party_name || "-"}</Td>
                      <Td>{row.status_name}</Td>
                      <Td>
                        <div>
                          {row.action?.terminal
                            ? "No further workflow action"
                            : row.pending_task_description || "-"}
                        </div>
                        <div className="text-xs text-gray-500">
                          Due {formatDate(row.pending_task_due_date)}
                        </div>
                      </Td>
                      <Td>
                        <div className="flex gap-2">
                          <Link
                            href={`/pim/case/${row.id}`}
                            className="rounded border px-3 py-2 text-xs font-medium"
                          >
                            View Case
                          </Link>
                          {row.action?.href && !row.action.terminal && (
                            <Link
                              href={row.action.href}
                              className="rounded bg-black px-3 py-2 text-xs font-medium text-white"
                            >
                              {row.action.label || "Continue Workflow"}
                            </Link>
                          )}
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

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-4 py-3 font-semibold">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="whitespace-nowrap px-4 py-3">{children}</td>;
}
