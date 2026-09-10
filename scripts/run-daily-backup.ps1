$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogRoot = Join-Path $ProjectRoot "backups\logs"
$Timestamp = Get-Date -Format "yyyy-MM-dd-HH-mm-ss"
$LogFile = Join-Path $LogRoot "$Timestamp-daily-backup.log"

New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null

Push-Location $ProjectRoot
try {
  "Daily backup started: $(Get-Date -Format o)" | Tee-Object -FilePath $LogFile
  node scripts\backup-sqlite.js 2>&1 | Tee-Object -FilePath $LogFile -Append

  if ($LASTEXITCODE -ne 0) {
    "Daily backup failed with exit code $LASTEXITCODE" | Tee-Object -FilePath $LogFile -Append
    exit $LASTEXITCODE
  }

  "Daily backup completed: $(Get-Date -Format o)" | Tee-Object -FilePath $LogFile -Append
  exit 0
} catch {
  "Daily backup failed: $($_.Exception.Message)" | Tee-Object -FilePath $LogFile -Append
  exit 1
} finally {
  Pop-Location
}
