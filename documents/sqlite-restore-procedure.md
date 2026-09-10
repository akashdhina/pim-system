# SQLite Restore Procedure

Use this procedure only after confirming the selected backup is the intended restore point.

1. Stop all running Next.js/PIM server processes.
2. Create a pre-restore safety backup:

```powershell
node scripts\backup-sqlite.js
```

3. Locate the selected backup in Backup & Recovery and copy its backup ID.
4. Run an integrity check against the backup:

```powershell
node -e "const {verifyBackup}=require('./lib/pim-backup'); console.log(verifyBackup('<backup-id>'));"
```

5. Preserve the current production database before replacing it:

```powershell
Copy-Item database\pim.db database\pim.db.before-restore
```

6. Restore by guarded script:

```powershell
node scripts\restore-sqlite.js --backup-id <backup-id> --confirm-restore
```

7. Run integrity and foreign-key checks on the restored database:

```powershell
node -e "const db=require('./lib/db'); console.log(db.prepare('PRAGMA integrity_check').all()); console.log(db.prepare('PRAGMA foreign_key_check').all());"
```

8. Run production audit:

```powershell
node scripts\audit-production-readiness.js
```

9. Start the app.

Do not overwrite `database/pim.db.before-restore` until the restored database has been verified.
Preserve the rollback copy until office staff confirm the restored data is correct.
