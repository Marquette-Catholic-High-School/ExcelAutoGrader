#!/usr/bin/env bash
# Updates Excel Autograder to the latest version on GitHub (macOS and Linux). Run it inside the install folder:
#
#   ./update.sh               update, back up the database first, restart the app if it was running
#   ./update.sh --check       only report whether a new version is available (exit code 100 if there is one)
#   ./update.sh --help        all options
#
# Safe to run on a schedule (e.g. cron): it does nothing when there is no new version.
set -euo pipefail

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then RED=$'\033[31m' PLAIN=$'\033[0m'; else RED='' PLAIN=''; fi
die() { printf '%sError:%s %s\n' "$RED" "$PLAIN" "$*" >&2; exit 1; }

# Find the install folder, also when started through a symlink (e.g. ~/bin/excel-autograder-update).
script="${BASH_SOURCE[0]}"
while [ -L "$script" ]; do
  link="$(readlink "$script")"
  case "$link" in
    /*) script="$link" ;;
    *) script="$(dirname "$script")/$link" ;;
  esac
done
cd "$(dirname "$script")" || die "Could not open the folder of $script."
[ -f scripts/update.mjs ] || die "$PWD is not an Excel Autograder folder (scripts/update.mjs is missing)."
mkdir -p logs 2> /dev/null || true

if ! command -v node > /dev/null 2>&1; then
  die "Node.js is not installed (or not on PATH). Install it from https://nodejs.org"
fi
version="$(node -p 'process.versions.node')"
major="${version%%.*}"
minor="${version#*.}"
minor="${minor%%.*}"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
  die "Node.js $version is too old; 22.13 or newer is needed. Install it from https://nodejs.org"
fi
if ! git --version > /dev/null 2>&1; then
  die "Git is not installed (or not on PATH). Install it (macOS: xcode-select --install), then run this again."
fi

exec node --disable-warning=ExperimentalWarning scripts/update.mjs "$@"
