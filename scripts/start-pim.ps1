$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDirectory = Join-Path $ProjectRoot "logs"
$PidFile = Join-Path $ProjectRoot "pim-server.pid"
$LogFile = Join-Path $LogDirectory "pim-server.log"
$ErrorLogFile = Join-Path $LogDirectory "pim-server-error.log"

New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

if (Test-Path $PidFile) {
    $ExistingPid = Get-Content $PidFile -ErrorAction SilentlyContinue

    if ($ExistingPid) {
        $ExistingProcess = Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue

        if ($ExistingProcess) {
            Stop-Process -Id $ExistingPid -Force
            Start-Sleep -Seconds 1
        }
    }

    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

$NodePath = (Get-Command node).Source
$NextPath = Join-Path $ProjectRoot "node_modules\next\dist\bin\next"

$Process = Start-Process `
    -FilePath $NodePath `
    -ArgumentList "`"$NextPath`" start -p 3000" `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrorLogFile `
    -PassThru

Set-Content -Path $PidFile -Value $Process.Id

$Ready = $false

for ($Attempt = 1; $Attempt -le 30; $Attempt++) {
    Start-Sleep -Seconds 1

    try {
        $Response = Invoke-WebRequest `
            -Uri "http://localhost:3000/api/pim/health" `
            -UseBasicParsing `
            -TimeoutSec 2

        if ($Response.StatusCode -eq 200) {
            $Ready = $true
            break
        }
    }
    catch {
        # Server is still starting.
    }
}

if (-not $Ready) {
    throw "PIM server did not become ready. Check logs\pim-server-error.log."
}

Start-Process "http://localhost:3000/pim/login"
