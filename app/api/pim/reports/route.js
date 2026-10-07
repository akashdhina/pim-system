/* eslint-disable @typescript-eslint/no-require-imports */

/*
 * PostgreSQL-authoritative (production-completion sprint, 2026-10-07).
 * See lib/pim-data/reports.js. Replaces the SQLite db.prepare(...).all()
 * calls - no SQLite read remains here.
 */

const {
  requirePermission,
} = require("../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../lib/api-response");
const {
  runReportPg,
  exportReportPg,
  normalizedReportList,
} = require("../../../../lib/pim-data/reports");

const EXPORT_ROW_CAP = 5000;

function toCsvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(columns, rows) {
  const header = columns.map((column) => toCsvValue(column.label)).join(",");
  const lines = rows.map((row) => columns.map((column) => toCsvValue(row[column.field])).join(","));
  return [header, ...lines].join("\r\n");
}

export async function GET(request) {
  try {
    requirePermission(request, "READ_CASE");

    const url = new URL(request.url);
    const reportKey = String(url.searchParams.get("report") || "register").trim();
    const format = String(url.searchParams.get("format") || "json").trim();

    if (format === "csv") {
      const exportRows = await exportReportPg(reportKey, url.searchParams, EXPORT_ROW_CAP);
      const { report } = await runReportPg(reportKey, url.searchParams);
      const columns = report.columns.map(([field, label, type]) => ({
        field, label, type, sortable: Boolean(report.sortColumns[field]),
      }));
      const csv = buildCsv(columns, exportRows);
      const filename = `pim-${reportKey}-${new Date().toISOString().slice(0, 10)}.csv`;

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const { report, page, pageSize, count, rows, totals } = await runReportPg(reportKey, url.searchParams);

    const columns = report.columns.map(([field, label, type]) => ({
      field, label, type, sortable: Boolean(report.sortColumns[field]),
    }));

    return Response.json({
      success: true,
      data: {
        report: {
          key: reportKey,
          title: report.title,
          description: report.description,
          dateLabel: report.dateLabel,
          filters: report.filters || [],
          columns,
          defaultSort: report.defaultSort,
          defaultDirection: report.defaultDirection,
        },
        reports: normalizedReportList(),
        rows,
        totals,
        pagination: {
          page,
          pageSize,
          total: count,
          totalPages: Math.max(1, Math.ceil(count / pageSize)),
        },
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);

    if (authResponse) {
      return authResponse;
    }

    console.error("PIM reports error:", error);

    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unable to load PIM report.",
      },
      { status: 500 }
    );
  }
}
