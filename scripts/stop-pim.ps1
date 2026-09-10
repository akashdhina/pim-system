$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot "pim-server.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "PIM server PID file was not found."
    exit 0
}

$PidValue = Get-Content $PidFile -ErrorAction SilentlyContinue

if ($PidValue) {
    $Process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue

    if ($Process) {
        Stop-Process -Id $PidValue -Force
        Write-Host "PIM server stopped."
    }
}

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue