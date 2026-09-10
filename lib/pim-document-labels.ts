/*
 * Friendly display labels for pim_documents.document_type.
 * Stored values (verified against app/api/pim/documents/**, lib/pim-document.js,
 * and production rows) are FORM2, FORM_3, FORM_4, FORM_5, WITHDRAWAL_RECORD.
 * Labels here are presentation-only - they never rename the stored value.
 */

export const DOCUMENT_TYPE_OPTIONS: [string, string][] = [
  ["", "All"],
  ["FORM2", "Form II"],
  ["FORM_3", "Form III"],
  ["FORM_4", "Form IV"],
  ["FORM_5", "Form V"],
  ["WITHDRAWAL_RECORD", "Withdrawal record"],
];

const LABELS: Record<string, string> = {
  FORM2: "Form II",
  FORM_2: "Form II",
  FORM_3: "Form III",
  FORM_4: "Form IV",
  FORM_5: "Form V",
  WITHDRAWAL_RECORD: "Withdrawal record",
};

export function documentTypeLabel(type: string | null | undefined): string {
  if (!type) return "-";
  return LABELS[type] || type;
}
