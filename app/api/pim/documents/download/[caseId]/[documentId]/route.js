const fs = require("fs");
const path = require("path");
const db = require("../../../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../../lib/api-response");
const {
  downloadForm2DocumentPg,
} = require("../../../../../../../lib/pim-data/form2");
const {
  downloadOutcomeDocumentPg,
} = require("../../../../../../../lib/pim-data/outcome-documents");
const {
  downloadForm3DocumentPg,
} = require("../../../../../../../lib/pim-data/form3-documents");

export const runtime = "nodejs";

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (ext === ".pdf") {
    return "application/pdf";
  }

  return "application/octet-stream";
}

export async function GET(
  request,
  { params }
) {
  try {
    requirePermission(
      request,
      "DOWNLOAD_DOCUMENT"
    );

    const {
      caseId: caseIdParam,
      documentId: documentIdParam,
    } = await params;

    const caseId = Number(caseIdParam);
    const documentId = Number(documentIdParam);

    if (
      !Number.isInteger(caseId) ||
      caseId <= 0 ||
      !Number.isInteger(documentId) ||
      documentId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Invalid case or document ID.",
        },
        { status: 400 }
      );
    }

    /*
     * Batch 5I (Phase 6): the PostgreSQL no-Storage Form-2 path, tried
     * first. Renders on demand from the document's frozen render_data
     * snapshot - never file_path, never a filesystem read. Returns null
     * (not a throw) for any id this path doesn't own - a Form-3/4/5
     * document, a SQLite-only document, or a genuinely missing one - so
     * the original SQLite/local-file logic below still handles every
     * document type this batch does not touch, unchanged.
     */
    const pgResult =
      (await downloadForm2DocumentPg(caseId, documentId)) ||
      (await downloadOutcomeDocumentPg(caseId, documentId)) ||
      (await downloadForm3DocumentPg(caseId, documentId));

    if (pgResult) {
      if (!pgResult.buffer) {
        return Response.json(
          {
            success: false,
            message: "Document does not have stored render data.",
          },
          { status: 404 }
        );
      }

      return new Response(pgResult.buffer, {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition":
            `attachment; filename="${pgResult.fileName}"`,
          "Content-Length": String(pgResult.buffer.length),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const document = db.prepare(`
      SELECT *
      FROM pim_documents
      WHERE id = ?
        AND case_id = ?
    `).get(documentId, caseId);

    if (!document) {
      return Response.json(
        {
          success: false,
          message:
            "Document was not found for this PIM case.",
        },
        { status: 404 }
      );
    }

    if (!document.file_path) {
      return Response.json(
        {
          success: false,
          message:
            "Document does not have a stored file.",
        },
        { status: 404 }
      );
    }

    const storageRoot = path.resolve(
      process.cwd(),
      "storage",
      "pim"
    );

    const resolvedPath = path.resolve(
      document.file_path
    );

    if (
      resolvedPath !== storageRoot &&
      !resolvedPath.startsWith(
        storageRoot + path.sep
      )
    ) {
      return Response.json(
        {
          success: false,
          message:
            "Document path is outside controlled storage.",
        },
        { status: 403 }
      );
    }

    if (!fs.existsSync(resolvedPath)) {
      return Response.json(
        {
          success: false,
          message:
            "Stored document file was not found.",
        },
        { status: 404 }
      );
    }

    const file = fs.readFileSync(
      resolvedPath
    );

    const filename = path.basename(
      resolvedPath
    );

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type":
          contentTypeFor(resolvedPath),
        "Content-Disposition":
          `attachment; filename="${filename}"`,
        "Content-Length": String(file.length),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error(
      "Document download error:",
      error
    );

    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to download document.",
      },
      { status: 500 }
    );
  }
}
