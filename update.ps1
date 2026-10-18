# Updates Excel Autograder to the latest version on GitHub (Windows). Double-click update.cmd, or in the folder run
#
#   powershell -ExecutionPolicy Bypass -File .\update.ps1            update (backs up the database, restarts the app)
#   powershell -ExecutionPolicy Bypass -File .\update.ps1 --check    only report whether a new version is available
#                                                                    (exit code 100 if there is one)
#   powershell -ExecutionPolicy Bypass -File .\update.ps1 --help     all options
#
# Safe to run from Task Scheduler: it does nothing when there is no new version.
# (Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 files without a BOM.)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command 'node' -ErrorAction SilentlyContinue)) {
    Write-Host 'Error: Node.js is not installed (or not on PATH). Install it from https://nodejs.org' -ForegroundColor Red
    exit 1
}
$parts = ([string](& node -p 'process.versions.node')).Trim().Split('.')
if (([int]$parts[0] -lt 22) -or (([int]$parts[0] -eq 22) -and ([int]$parts[1] -lt 13))) {
    Write-Host "Error: Node.js $($parts -join '.') is too old; 22.13 or newer is needed. Install it from https://nodejs.org" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command 'git' -ErrorAction SilentlyContinue)) {
    Write-Host 'Error: Git is not installed (or not on PATH). Install it from https://git-scm.com/download/win (or: winget install Git.Git), then run this again.' -ForegroundColor Red
    exit 1
}
[void][System.IO.Directory]::CreateDirectory((Join-Path $PSScriptRoot 'logs'))

& node --disable-warning=ExperimentalWarning scripts/update.mjs @args
exit $LASTEXITCODE
