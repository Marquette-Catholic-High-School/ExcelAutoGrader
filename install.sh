#!/usr/bin/env bash
# Excel Autograder installer for macOS and Linux.
#
#   New computer (downloads the app into ~/ExcelAutoGrader):
#     curl -fsSL https://raw.githubusercontent.com/Marquette-Catholic-High-School/ExcelAutoGrader/main/install.sh | bash
#   Pass options after "bash -s --", e.g. ... | bash -s -- --demo --port 8080
#
#   Already downloaded (run inside the folder):
#     ./install.sh [--demo] [--no-demo] [--port <n>] [--host 0.0.0.0] [--start] [--no-start] [--yes]
#
#   Environment overrides: EXCEL_AUTOGRADER_DIR (install folder), EXCEL_AUTOGRADER_REPO, EXCEL_AUTOGRADER_BRANCH
set -euo pipefail

REPO_URL="${EXCEL_AUTOGRADER_REPO:-https://github.com/Marquette-Catholic-High-School/ExcelAutoGrader.git}"
BRANCH="${EXCEL_AUTOGRADER_BRANCH:-main}"
DEFAULT_DIR="${HOME:-}/ExcelAutoGrader"
NODE_MAJOR=22
NODE_MINOR=13

# Colors only on a terminal (not in log files) and not when NO_COLOR is set.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then BOLD=$'\033[1m' PLAIN=$'\033[0m'; else BOLD='' PLAIN=''; fi
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then RED=$'\033[31m' PLAIN2=$'\033[0m'; else RED='' PLAIN2=''; fi
say() { printf '%s==> %s%s\n' "$BOLD" "$*" "$PLAIN"; }
die() { printf '%sError:%s %s\n' "$RED" "$PLAIN2" "$*" >&2; exit 1; }

usage() {
  cat << 'USAGE'
Excel Autograder installer for macOS and Linux.

  New computer:  curl -fsSL https://raw.githubusercontent.com/Marquette-Catholic-High-School/ExcelAutoGrader/main/install.sh | bash
                 (options go after "bash -s --", e.g. ... | bash -s -- --demo --port 8080)
  Downloaded:    ./install.sh [options]   (inside the app folder; safe to run again, keeps data and settings)

Options:
  --demo           load the demo teacher, students and assignments (asks before replacing existing data)
  --no-demo        start with an empty database
  --port <n>       port to use (default 3001, saved in config.env)
  --host <ip>      127.0.0.1 (this computer only, default) or 0.0.0.0 (other computers on the network too)
  --start          start the app at the end without asking
  --no-start       don't start the app at the end
  --yes            use the defaults without asking any questions
  --help           show this help

Environment variables:
  EXCEL_AUTOGRADER_DIR     folder to install into (default: ~/ExcelAutoGrader)
  EXCEL_AUTOGRADER_REPO    git repository to download from
  EXCEL_AUTOGRADER_BRANCH  branch to download (default: main)
USAGE
}

# Rejects mistyped options before anything is downloaded (install.mjs checks the values).
check_options() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h | --help) usage; exit 0 ;;
      --demo | --no-demo | --start | --no-start | --yes | -y) ;;
      --port | --host)
        [ $# -ge 2 ] || die "$1 needs a value."
        shift
        ;;
      *) die "Unknown option \"$1\". Run with --help to see the options." ;;
    esac
    shift
  done
}

is_checkout() {
  [ -f "$1/package.json" ] && [ -f "$1/scripts/install.mjs" ] && grep -q '"name": "excel-autograder"' "$1/package.json"
}

# Asks a yes/no question on the terminal (works even when this script is piped from curl).
ask_yes() {
  local answer=""
  if [ -r /dev/tty ] && (: < /dev/tty) 2> /dev/null; then
    printf '%s [Y/n] ' "$1" > /dev/tty
    read -r answer < /dev/tty || answer="n"
  else
    return 1
  fi
  case "$answer" in "" | [Yy]*) return 0 ;; *) return 1 ;; esac
}

node_ok() {
  command -v node > /dev/null 2>&1 || return 1
  local version major minor
  version="$(node -p 'process.versions.node' 2> /dev/null)" || return 1
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  [ "$major" -gt "$NODE_MAJOR" ] || { [ "$major" -eq "$NODE_MAJOR" ] && [ "$minor" -ge "$NODE_MINOR" ]; }
}

check_prerequisites() {
  # Run git rather than look for it: on macOS /usr/bin/git always exists, but without the Command Line Tools it
  # only fails (and opens a window offering to install them).
  if ! git --version > /dev/null 2>&1; then
    if [ "$(uname)" = "Darwin" ]; then
      die "Git is not installed. Install the Command Line Tools (accept the window that may have just opened, or run: xcode-select --install), then run this installer again."
    fi
    die "Git is not installed. Install it with your package manager (e.g. sudo apt install git), then run this again."
  fi

  if ! node_ok; then
    local found=""
    command -v node > /dev/null 2>&1 && found=" (found $(node -v 2> /dev/null || echo 'a version that does not run'))"
    if command -v brew > /dev/null 2>&1 && ask_yes "Node.js $NODE_MAJOR.$NODE_MINOR or newer is needed$found. Install it now with Homebrew?"; then
      brew install node
      hash -r
    fi
    node_ok || die "Node.js $NODE_MAJOR.$NODE_MINOR or newer is needed$found. Install the LTS version from https://nodejs.org (or: brew install node), then run this again."
  fi
  command -v npm > /dev/null 2>&1 || die "npm is missing. Reinstall Node.js from https://nodejs.org, then run this again."
}

# Prints the folder to use, downloading the app into it first when needed.
find_or_download() {
  local dir="$1"
  if is_checkout "$dir"; then
    say "Excel Autograder is already downloaded in $dir (use ./update.sh there to get new versions)" >&2
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2> /dev/null)" ]; then
    die "$dir already exists and is not empty. Set EXCEL_AUTOGRADER_DIR to install somewhere else."
  else
    say "Downloading Excel Autograder into $dir" >&2
    GIT_TERMINAL_PROMPT=0 git clone --branch "$BRANCH" "$REPO_URL" "$dir" >&2 ||
      die "Downloading from $REPO_URL failed. Check the internet connection and try again."
  fi
  printf '%s\n' "$dir"
}

main() {
  check_options "$@"
  check_prerequisites

  local root="" script_dir="" caller_dir="$PWD"
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  fi

  if [ -n "${EXCEL_AUTOGRADER_DIR:-}" ]; then
    # An explicit folder always wins, even when this script was started from another copy.
    if [ -n "$script_dir" ] && is_checkout "$script_dir" &&
      [ "$(cd "$EXCEL_AUTOGRADER_DIR" 2> /dev/null && pwd -P)" != "$script_dir" ]; then
      say "Installing into EXCEL_AUTOGRADER_DIR ($EXCEL_AUTOGRADER_DIR), not into this script's folder ($script_dir)"
    fi
    root="$(find_or_download "$EXCEL_AUTOGRADER_DIR")"
  elif [ -n "$script_dir" ] && is_checkout "$script_dir"; then
    root="$script_dir"
  else
    [ -n "${HOME:-}" ] || die "HOME is not set. Set EXCEL_AUTOGRADER_DIR to the folder to install into."
    root="$(find_or_download "$DEFAULT_DIR")"
  fi

  cd "$root"
  local node_args=(--disable-warning=ExperimentalWarning scripts/install.mjs "$@")
  export EXCEL_AUTOGRADER_CALLER_CWD="$caller_dir"
  # When piped from curl, stdin is this script; give the setup questions the terminal instead.
  if [ ! -t 0 ] && [ -r /dev/tty ] && (: < /dev/tty) 2> /dev/null; then
    node "${node_args[@]}" < /dev/tty
  else
    node "${node_args[@]}"
  fi
}

# Everything runs from main, so a partially downloaded script never runs half-way; "exit" on the same line stops
# bash from reading this file again after main returns (the setup may have replaced it in the meantime).
main "$@"; exit $?
