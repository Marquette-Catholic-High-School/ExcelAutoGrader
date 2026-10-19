# Excel Autograder installer for Windows (Windows PowerShell 5.1 or PowerShell 7).
#
#   New computer (downloads the app into %USERPROFILE%\ExcelAutoGrader), in PowerShell:
#     irm https://raw.githubusercontent.com/Marquette-Catholic-High-School/ExcelAutoGrader/main/install.ps1 | iex
#   With options (irm | iex can't pass any):
#     & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Marquette-Catholic-High-School/ExcelAutoGrader/main/install.ps1))) --demo --port 8080
#
#   Already downloaded: double-click install.cmd, or in the folder run
#     powershell -ExecutionPolicy Bypass -File .\install.ps1 [--demo] [--no-demo] [--port <n>] [--host <ip>] [--start] [--no-start] [--yes]
#
#   Environment overrides: EXCEL_AUTOGRADER_DIR (install folder), EXCEL_AUTOGRADER_REPO, EXCEL_AUTOGRADER_BRANCH
#   (Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 files without a BOM.)

function Install-ExcelAutograder {
    param([string[]]$SetupArgs)

    $ErrorActionPreference = 'Stop'
    $repoUrl = 'https://github.com/Marquette-Catholic-High-School/ExcelAutoGrader.git'
    if ($env:EXCEL_AUTOGRADER_REPO) { $repoUrl = $env:EXCEL_AUTOGRADER_REPO }
    $branch = 'main'
    if ($env:EXCEL_AUTOGRADER_BRANCH) { $branch = $env:EXCEL_AUTOGRADER_BRANCH }
    $installDir = $env:EXCEL_AUTOGRADER_DIR
    if (-not $installDir) {
        $homeDir = $env:USERPROFILE
        if (-not $homeDir) { $homeDir = $HOME }
        $installDir = Join-Path $homeDir 'ExcelAutoGrader'
    }

    function Write-Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }
    function Write-Problem([string]$message) { Write-Host "Error: $message" -ForegroundColor Red }
    function Test-Command([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

    function Show-Usage {
        Write-Host 'Excel Autograder installer for Windows.'
        Write-Host ''
        Write-Host '  New computer:  irm https://raw.githubusercontent.com/Marquette-Catholic-High-School/ExcelAutoGrader/main/install.ps1 | iex'
        Write-Host '  Downloaded:    double-click install.cmd, or run .\install.cmd [options] in the app folder'
        Write-Host ''
        Write-Host 'Options:'
        Write-Host '  --demo           load the demo teacher, students and assignments (asks before replacing existing data)'
        Write-Host '  --no-demo        start with an empty database'
        Write-Host '  --port <n>       port to use (default 80, saved in config.env)'
        Write-Host '  --host <ip>      0.0.0.0 (other computers on the network too, default) or 127.0.0.1 (this computer only)'
        Write-Host '  --start          start the app at the end without asking'
        Write-Host '  --no-start       do not start the app at the end'
        Write-Host '  --yes            use the defaults without asking any questions'
        Write-Host ''
        Write-Host 'Environment variables:'
        Write-Host '  EXCEL_AUTOGRADER_DIR     folder to install into (default: %USERPROFILE%\ExcelAutoGrader)'
        Write-Host '  EXCEL_AUTOGRADER_REPO    git repository to download from'
        Write-Host '  EXCEL_AUTOGRADER_BRANCH  branch to download (default: main)'
    }

    function Update-SessionPath {
        # Picks up what an installer just added to the machine/user PATH, keeping this session's own entries.
        $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $user = [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path = ((($env:Path, $machine, $user) -join ';') -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';'
    }

    function Install-WithWinget([string]$id, [string]$label) {
        if (-not (Test-Command 'winget')) { return }
        $answer = Read-Host "$label is needed. Install it now with winget? [Y/n]"
        if ($answer -and ($answer -notmatch '^[Yy]')) { return }
        winget install --id $id --exact --source winget --accept-package-agreements --accept-source-agreements
        Update-SessionPath
    }

    function Test-NodeVersion {
        if (-not (Test-Command 'node')) { return $false }
        try {
            $parts = ([string](& node -p 'process.versions.node')).Trim().Split('.')
            $major = [int]$parts[0]
            $minor = [int]$parts[1]
        } catch {
            return $false
        }
        return ($major -gt 22) -or (($major -eq 22) -and ($minor -ge 13))
    }

    function Test-Checkout([string]$dir) {
        if (-not $dir) { return $false }
        $package = Join-Path $dir 'package.json'
        $setup = Join-Path (Join-Path $dir 'scripts') 'install.mjs'
        if (-not (Test-Path -LiteralPath $package) -or -not (Test-Path -LiteralPath $setup)) { return $false }
        return [bool](Select-String -LiteralPath $package -Pattern '"name": "excel-autograder"' -SimpleMatch -Quiet)
    }

    function Test-SameFolder([string]$a, [string]$b) {
        try {
            $fa = [System.IO.Path]::GetFullPath($a).TrimEnd('\', '/')
            $fb = [System.IO.Path]::GetFullPath($b).TrimEnd('\', '/')
            return ($fa -ieq $fb)
        } catch {
            return $false
        }
    }

    # 0. Options: --help, and mistyped options are caught before anything is downloaded.
    $known = @('--demo', '--no-demo', '--start', '--no-start', '--yes', '-y')
    for ($i = 0; $i -lt $SetupArgs.Count; $i++) {
        $arg = $SetupArgs[$i]
        if (($arg -ceq '--help') -or ($arg -ceq '-h')) {
            Show-Usage
            $global:LASTEXITCODE = 0
            return
        }
        if ($known -ccontains $arg) { continue }
        if (($arg -ceq '--port') -or ($arg -ceq '--host')) {
            if ($i + 1 -ge $SetupArgs.Count) {
                Write-Problem "$arg needs a value."
                $global:LASTEXITCODE = 1
                return
            }
            $i++
            continue
        }
        Write-Problem "Unknown option `"$arg`". Run with --help to see the options."
        $global:LASTEXITCODE = 1
        return
    }

    # 1. Prerequisites
    if (-not (Test-Command 'git')) { Install-WithWinget 'Git.Git' 'Git' }
    if (-not (Test-Command 'git')) {
        Write-Problem 'Git is not installed. Get it from https://git-scm.com/download/win (or: winget install Git.Git), then run this again.'
        $global:LASTEXITCODE = 1
        return
    }
    if (-not (Test-NodeVersion)) { Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js 22.13 or newer' }
    if (-not (Test-NodeVersion)) {
        Write-Problem 'Node.js 22.13 or newer is needed. Install the LTS version from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), open a new PowerShell window, and run this again.'
        $global:LASTEXITCODE = 1
        return
    }

    # 2. Find or download the app. An explicit EXCEL_AUTOGRADER_DIR wins over the folder this script is in.
    $callerDir = (Get-Location).ProviderPath
    $scriptIsCheckout = $PSScriptRoot -and (Test-Checkout $PSScriptRoot)
    $root = $null
    if ($scriptIsCheckout -and -not $env:EXCEL_AUTOGRADER_DIR) {
        $root = $PSScriptRoot
    } else {
        if ($scriptIsCheckout -and -not (Test-SameFolder $PSScriptRoot $installDir)) {
            Write-Step "Installing into EXCEL_AUTOGRADER_DIR ($installDir), not into this script's folder ($PSScriptRoot)"
        }
        if (Test-Checkout $installDir) {
            $root = $installDir
            Write-Step "Excel Autograder is already downloaded in $root (use update.cmd there to get new versions)"
        } elseif ((Test-Path -LiteralPath $installDir) -and (Get-ChildItem -LiteralPath $installDir -Force | Select-Object -First 1)) {
            Write-Problem "$installDir already exists and is not empty. Set EXCEL_AUTOGRADER_DIR to install somewhere else."
            $global:LASTEXITCODE = 1
            return
        } else {
            Write-Step "Downloading Excel Autograder into $installDir"
            $savedPrompt = $env:GIT_TERMINAL_PROMPT
            $env:GIT_TERMINAL_PROMPT = '0'
            try {
                & git clone --branch $branch $repoUrl $installDir
            } finally {
                $env:GIT_TERMINAL_PROMPT = $savedPrompt
            }
            if ($LASTEXITCODE -ne 0) {
                Write-Problem "Downloading from $repoUrl failed. Check the internet connection and try again."
                $global:LASTEXITCODE = 1
                return
            }
            $root = $installDir
        }
    }

    # 3. Hand over to the cross-platform setup script. Its exit code stays in $LASTEXITCODE.
    $env:EXCEL_AUTOGRADER_CALLER_CWD = $callerDir
    Push-Location -LiteralPath $root
    try {
        & node --disable-warning=ExperimentalWarning scripts/install.mjs @SetupArgs
    } finally {
        Pop-Location
        Remove-Item -Path Env:EXCEL_AUTOGRADER_CALLER_CWD -ErrorAction SilentlyContinue
    }
}

# A function instead of top-level code: "irm | iex" must not close the window with exit, and a partially
# downloaded script defines nothing that runs. It is called as a plain statement (its output is not captured),
# so node keeps the console and its questions stay visible; the result comes back in $LASTEXITCODE.
# $PSCommandPath is only set when this file itself runs (-File, .\install.ps1, install.cmd), never under iex.
Install-ExcelAutograder -SetupArgs $args
if ($PSCommandPath) { exit $LASTEXITCODE }
