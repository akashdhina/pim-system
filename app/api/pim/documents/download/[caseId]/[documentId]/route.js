const fs = require("fs");
const path = require("path");
const db = require("../../../../../../../lib/db");
const {
  requirePermission,
} = require("../../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../../lib/api-response");

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
