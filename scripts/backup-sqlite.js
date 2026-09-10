/* eslint-disable @typescript-eslint/no-require-imports */

const {
  createBackup,
  enforceRetention,
} = require("../lib/pim-backup");

async function main() {
  const metadata = await createBackup({
    createdBy: "script",
  });
  const retention = enforceRetention();

  console.log("SQLite backup complete.");
  console.log(`Backup ID: ${metadata.id}`);
  console.log(`Size: ${metadata.file_size} bytes`);
  console.log(`Integrity: ${metadata.status}`);
  console.log(`Retention deleted: ${retention.deleted.length}`);
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Backup failed."
  );
  process.exitCode = 1;
});
