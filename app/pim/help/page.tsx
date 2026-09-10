import Link from "next/link";

const sections = [
  ["Login and Password Change", "Sign in at /pim/login. If a temporary password is issued, complete /pim/change-password before using case workflows."],
  ["New Filing", "Use New Application to enter Form-1 filing details, parties, addresses, advocates, and received/application dates."],
  ["Scrutiny", "Open Pending Tasks or the case file, then use Complete Scrutiny to record fee, vakalat, address, commercial dispute, and jurisdiction checks."],
  ["Secretary Approval", "Secretary users approve registration from Secretary Approval tasks after scrutiny is complete."],
  ["Form-2 Generation and Issue", "Use Prepare Form-2 to create and issue notices for opposite parties."],
  ["Service Recording", "Use Record Service to capture dispatch mode, postal receipt, tracking, delivery, return, and endorsement details."],
  ["Response and Consent", "Use Record OP Response to capture appearance, consent, refusal, or time request details."],
  ["Fee", "Use Record Fee when mediation fee collection is pending."],
  ["Mediator Assignment", "Use Assign Mediator to appoint an active panel mediator and set the first mediation date."],
  ["Mediation Sitting", "Use Fix First Mediation or Record Sitting from the task list. Session recording opens the real mediation session record."],
  ["Outcome", "Use Record Outcome for settlement, failed mediation, withdrawal, or non-starter outcome forms."],
  ["Documents", "Open the case file to view generated Form-2, Form-3, Form-4, Form-5, withdrawal, and outcome documents that exist for that case."],
  ["Reports", "Use Reports for registers, monitoring, outcome statistics, document register, and audit-style operational reports."],
  ["Backup", "Authorized users can open Backup from the dashboard to create, verify, download, or review restore instructions for SQLite backups."],
  ["Common Error Messages", "Authentication required means sign in again. Permission denied means your role cannot perform that action. Page pending means the workflow task exists but its final UI is not yet available."],
];

export default function HelpPage() {
  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-950">Help</h1>
            <p className="mt-1 text-sm text-gray-500">
              Short operating guide for DLSA Nilgiris PIM staff.
            </p>
          </div>
          <Link href="/pim" className="rounded border px-4 py-2 text-sm font-medium">
            Dashboard
          </Link>
        </div>

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2">
            {sections.map(([title, body]) => (
              <div key={title} className="rounded border p-4">
                <h2 className="font-semibold text-gray-950">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-gray-600">{body}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
