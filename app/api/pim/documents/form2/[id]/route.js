const db = require("../../../../../../lib/db");
const {
  generateForm2Document,
} = require("../../../../../../lib/pim-document");
const {
  requirePermission,
} = require("../../../../../../lib/pim-auth");
const {
  authErrorResponse,
} = require("../../../../../../lib/api-response");
const {
  generateForm2DocumentPg,
} = require("../../../../../../lib/pim-data/form2");

export const runtime = "nodejs";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function hasStoredFile(document) {
  return Boolean(
    document &&
      document.file_path &&
      String(document.file_path).trim()
  );
}

/*
 * Scoped by notice_id, not case_id: a case can now have more
 * than one FORM-2 notice (Initial, Fresh Initial, Final), each
 * with its own independent document version lineage. Generating
 * or regenerating one notice's document must never flip another
 * notice's current document.
 */
function getCurrentForm2Document(noticeId) {
  return db.prepare(`
    SELECT *
    FROM pim_documents
    WHERE notice_id = ?
      AND document_type IN ('FORM_2', 'FORM2')
      AND is_current = 1
    ORDER BY
      CASE
        WHEN file_path IS NOT NULL
          AND file_path <> ''
        THEN 0
        ELSE 1
      END,
      version_no DESC,
      id DESC
    LIMIT 1
  `).get(noticeId);
}

function getLinkedDocument(notice) {
  if (!notice.document_id) {
    return null;
  }

  return db.prepare(`
    SELECT *
    FROM pim_documents
    WHERE id = ?
      AND case_id = ?
      AND document_type IN ('FORM_2', 'FORM2')
  `).get(
    notice.document_id,
    notice.case_id
  ) || null;
}

function getNextVersion(noticeId) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
    FROM pim_documents
    WHERE notice_id = ?
      AND document_type IN ('FORM_2', 'FORM2')
  `).get(noticeId);

  return row.next_version || 1;
}

/*
 * The ORIGINAL SQLite POST body, kept unused as an instant rollback and
 * as the authentic SQLite baseline for scripts/test-pim-form2-postgres.js.
 * Not called by POST.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function generateForm2Sqlite(noticeId, { regenerate }, userId) {
  return db.transaction(() => {
    const notice = db.prepare(`
      SELECT * FROM pim_notices WHERE id = ? AND form_no = 'FORM-2'
    `).get(noticeId);

    if (!notice) {
      throw new Error("Form-2 notice record was not found.");
    }

    const linkedDocument = getLinkedDocument(notice);

    if (!regenerate && hasStoredFile(linkedDocument)) {
      return { reused: true, caseId: notice.case_id, noticeId, document: linkedDocument };
    }

    const versionNo = getNextVersion(noticeId);
    const generated = generateForm2Document({ noticeId, versionNo });
    const currentDocument = getCurrentForm2Document(noticeId);

    if (currentDocument) {
      db.prepare(`
        UPDATE pim_documents SET is_current = 0
        WHERE notice_id = ? AND document_type IN ('FORM_2', 'FORM2') AND is_current = 1
      `).run(noticeId);
    }

    const document = db.prepare(`
      INSERT INTO pim_documents
        (case_id, notice_id, document_type, document_title, document_date, file_path,
         generated_by_system, version_no, is_current, remarks, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      notice.case_id, noticeId, "FORM_2", generated.documentTitle, notice.notice_date || today(),
      generated.filePath, 1, versionNo, 1,
      linkedDocument && !linkedDocument.file_path
        ? "Generated Form-2 file for existing empty-path notice document."
        : regenerate ? "Regenerated official Form-2 notice." : "Generated official Form-2 notice.",
      userId
    );

    const documentId = document.lastInsertRowid;
    db.prepare(`UPDATE pim_notices SET document_id = ? WHERE id = ?`).run(documentId, noticeId);
    const nextDocument = db.prepare(`SELECT * FROM pim_documents WHERE id = ?`).get(documentId);

    return { reused: false, caseId: notice.case_id, noticeId, document: nextDocument };
  })();
}

export async function POST(
  request,
  { params }
) {
  try {
    const user = requirePermission(
      request,
      "GENERATE_DOCUMENT"
    );

    const { id } = await params;
    const noticeId = Number(id);

    if (
      !Number.isInteger(noticeId) ||
      noticeId <= 0
    ) {
      return Response.json(
        {
          success: false,
          message: "Invalid notice ID.",
        },
        { status: 400 }
      );
    }

    const body = await request.json().catch(
      () => ({})
    );

    const regenerate =
      body.regenerate === true;

    // Batch 5I (Phase 6): migrated to PostgreSQL via lib/pim-data/form2.js.
    // No-Storage model: file_path is always null for the returned
    // document; the DOCX is never written to disk here.
    const result = await generateForm2DocumentPg(noticeId, { regenerate }, user.id);

    return Response.json({
      success: true,
      message: result.reused
        ? "Current Form-2 document reused."
        : "Official Form-2 document generated successfully.",
      data: {
        caseId: result.caseId,
        noticeId: result.noticeId,
        document: {
          id: result.document.id,
          case_id: result.document.case_id,
          document_type:
            result.document.document_type,
          document_title:
            result.document.document_title,
          document_date:
            result.document.document_date,
          file_path:
            result.document.file_path,
          version_no:
            result.document.version_no,
          is_current:
            result.document.is_current,
          created_at:
            result.document.created_at,
        },
        reused: result.reused,
      },
    });
  } catch (error) {
    console.error(
      "Form-2 document generation error:",
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
            : "Unable to generate Form-2 document.",
      },
      { status: 400 }
    );
  }
}
