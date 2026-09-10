/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const packageJson = require("../package.json");
const { getSetting } = require("./pim-settings");

const BACKUP_ROOT = path.join(process.cwd(), "backups", "sqlite");
const SOURCE_DATABASE = path.join(process.cwd(), "database", "pim.db");

function ensureBackupRoot() {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
}

function backupIdFor(datePart, timestamp) {
  return `${datePart}--${timestamp}`;
}

function validateBackupId(backupId) {
  const text = String(backupId || "").trim().replace(/\\/g, "/");
  const match =
    /^(\d{4}-\d{2}-\d{2})--([A-Za-z0-9_.-]+)$/.exec(text) ||
    /^(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_.-]+)$/.exec(text);

  if (!match) {
    const error = new Error("Invalid backup ID.");
    error.status = 400;
    throw error;
  }

  return {
    id: backupIdFor(match[1], match[2]),
    datePart: match[1],
    timestamp: match[2],
  };
}

function backupDirectoryFromId(backupId) {
  const valid = validateBackupId(backupId);
  const directory = path.resolve(BACKUP_ROOT, valid.datePart, valid.timestamp);
  const root = path.resolve(BACKUP_ROOT);

  if (directory !== root && !directory.startsWith(root + path.sep)) {
    const error = new Error("Backup path is outside controlled storage.");
    error.status = 400;
    throw error;
  }

  return {
    ...valid,
    directory,
    databasePath: path.join(directory, "pim.db"),
    metadataPath: path.join(directory, "backup.json"),
  };
}

function runChecks(databasePath) {
  const backupDb = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    return {
      integrity_result: backupDb.prepare("PRAGMA integrity_check").all(),
      foreign_key_result: backupDb.prepare("PRAGMA foreign_key_check").all(),
    };
  } finally {
    backupDb.close();
  }
}

function isCheckOk(checks) {
  const integrityOk = checks.integrity_result.every((row) => {
    const value = Object.values(row)[0];
    return value === "ok";
  });

  return integrityOk && checks.foreign_key_result.length === 0;
}

async function createBackup({ createdBy = null } = {}) {
  ensureBackupRoot();

  if (!fs.existsSync(SOURCE_DATABASE)) {
    const error = new Error("Active database was not found.");
    error.status = 409;
    throw error;
  }

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const backupId = backupIdFor(datePart, timestamp);
  const target = backupDirectoryFromId(backupId);

  if (fs.existsSync(target.directory)) {
    const error = new Error("Backup target already exists.");
    error.status = 409;
    throw error;
  }

  fs.mkdirSync(target.directory, { recursive: true });

  const source = new Database(SOURCE_DATABASE, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    await source.backup(target.databasePath);
  } finally {
    source.close();
  }

  const checks = runChecks(target.databasePath);
  const metadata = {
    id: backupId,
    created_at: now.toISOString(),
    created_by: createdBy,
    source_database: "database/pim.db",
    backup_file: "pim.db",
    file_size: fs.statSync(target.databasePath).size,
    integrity_result: checks.integrity_result,
    foreign_key_result: checks.foreign_key_result,
    status: isCheckOk(checks) ? "SUCCESS" : "FAILED",
    application_version: packageJson.version || null,
  };

  fs.writeFileSync(
    target.metadataPath,
    JSON.stringify(metadata, null, 2)
  );

  if (metadata.status !== "SUCCESS") {
    const error = new Error("Backup verification failed.");
    error.status = 409;
    error.metadata = metadata;
    throw error;
  }

  return metadata;
}

function readMetadata(target) {
  if (!fs.existsSync(target.metadataPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(target.metadataPath, "utf8"));
}

function listBackups() {
  ensureBackupRoot();

  const backups = [];
  for (const datePart of fs.readdirSync(BACKUP_ROOT)) {
    const datePath = path.join(BACKUP_ROOT, datePart);
    if (!fs.statSync(datePath).isDirectory()) continue;

    for (const timestamp of fs.readdirSync(datePath)) {
      const id = backupIdFor(datePart, timestamp);
      let target;

      try {
        target = backupDirectoryFromId(id);
      } catch {
        continue;
      }

      if (!fs.existsSync(target.databasePath)) continue;

      const metadata =
        readMetadata(target) || {
          id,
          created_at: timestamp.replace(/-/g, ":"),
          created_by: null,
          source_database: "database/pim.db",
          backup_file: "pim.db",
          file_size: fs.statSync(target.databasePath).size,
          integrity_result: [],
          foreign_key_result: [],
          status: "UNKNOWN",
          application_version: null,
        };

      backups.push({
        ...metadata,
        id,
        file_size: fs.statSync(target.databasePath).size,
      });
    }
  }

  return backups.sort((a, b) =>
    String(b.created_at || b.id).localeCompare(String(a.created_at || a.id))
  );
}

function getBackup(backupId) {
  const target = backupDirectoryFromId(backupId);

  if (!fs.existsSync(target.databasePath)) {
    const error = new Error("Backup not found.");
    error.status = 404;
    throw error;
  }

  return {
    target,
    metadata:
      readMetadata(target) || {
        id: target.id,
        status: "UNKNOWN",
        file_size: fs.statSync(target.databasePath).size,
      },
  };
}

function verifyBackup(backupId) {
  const { target, metadata } = getBackup(backupId);
  const checks = runChecks(target.databasePath);
  const verified = {
    ...metadata,
    integrity_result: checks.integrity_result,
    foreign_key_result: checks.foreign_key_result,
    status: isCheckOk(checks) ? "SUCCESS" : "FAILED",
    verified_at: new Date().toISOString(),
    file_size: fs.statSync(target.databasePath).size,
  };

  fs.writeFileSync(target.metadataPath, JSON.stringify(verified, null, 2));

  return verified;
}

function deleteBackup(backupId) {
  const backups = listBackups().filter((backup) => backup.status === "SUCCESS");
  const newest = backups[0];

  if (newest && newest.id === backupId) {
    const error = new Error("Cannot delete the newest valid backup.");
    error.status = 409;
    throw error;
  }

  if (backups.length <= 1) {
    const error = new Error("Cannot delete the only valid backup.");
    error.status = 409;
    throw error;
  }

  const { target } = getBackup(backupId);
  fs.rmSync(target.directory, { recursive: true, force: false });

  return { id: backupId, deleted: true };
}

function enforceRetention() {
  const retentionCount = Math.max(
    1,
    Number(getSetting("backup_retention_count") || 30)
  );
  const retentionDays = Math.max(
    0,
    Number(getSetting("backup_retention_days") || 0)
  );
  const successful = listBackups().filter((backup) => backup.status === "SUCCESS");
  const deleted = [];

  if (successful.length <= 1) {
    return {
      kept: successful.length,
      deleted,
      retentionCount,
      retentionDays,
    };
  }

  const newest = successful[0];
  const cutoff = retentionDays
    ? Date.now() - retentionDays * 24 * 60 * 60 * 1000
    : null;

  for (const backup of successful.slice(1)) {
    const olderThanCutoff =
      cutoff && new Date(backup.created_at).getTime() < cutoff;
    const beyondCount =
      successful.indexOf(backup) >= retentionCount;

    if ((olderThanCutoff || beyondCount) && backup.id !== newest.id) {
      const { target } = getBackup(backup.id);
      fs.rmSync(target.directory, { recursive: true, force: false });
      deleted.push(backup.id);
    }
  }

  return {
    kept: listBackups().filter((backup) => backup.status === "SUCCESS").length,
    deleted,
    retentionCount,
    retentionDays,
  };
}

function databaseStatus() {
  const checks = runChecks(SOURCE_DATABASE);

  return {
    database_size: fs.existsSync(SOURCE_DATABASE)
      ? fs.statSync(SOURCE_DATABASE).size
      : 0,
    integrity_result: checks.integrity_result,
    foreign_key_result: checks.foreign_key_result,
    status: isCheckOk(checks) ? "ok" : "failed",
  };
}

module.exports = {
  BACKUP_ROOT,
  SOURCE_DATABASE,
  createBackup,
  databaseStatus,
  deleteBackup,
  enforceRetention,
  getBackup,
  listBackups,
  validateBackupId,
  verifyBackup,
};
