# Windows Backup Scheduler

The local pilot should run backups through Windows Task Scheduler, not through an in-process web timer. The task does not depend on the Next.js server being open.

Recommended schedule:

- Daily at 6:30 PM
- Run whether the user is logged in or not
- Retry once after 30 minutes
- Keep the last 30 successful backups

Manual test:

```powershell
powershell.exe -ExecutionPolicy Bypass -File D:\DLSA\pim-system\scripts\run-daily-backup.ps1
```

Suggested Task Scheduler setup:

1. Open Task Scheduler as an administrator.
2. Create a new task named `DLSA PIM Daily SQLite Backup`.
3. Use the same Windows account that owns the PIM working folder.
4. Choose `Run whether user is logged on or not`.
5. Set the trigger to daily at `6:30 PM`.
6. Set the action:

```text
Program/script: powershell.exe
Arguments: -ExecutionPolicy Bypass -File D:\DLSA\pim-system\scripts\run-daily-backup.ps1
Start in: D:\DLSA\pim-system
```

7. In Settings, enable retry on failure after 30 minutes, with one retry.
8. Run the task once manually and confirm a new backup appears in Backup & Recovery.

Logs are written under `backups/logs/`.
