# Excel Autograder

A local web app for teaching with spreadsheets. Teachers create classes, add students and post
assignments. Students upload their Excel workbooks, and the app grades them cell by cell against the
teacher's finished workbook (the answer key). Assignments without an answer key are graded by hand,
with the student's workbook viewable right in the browser.

Built with React and Mantine UI on the front end, and Express with SQLite on the back end. Everything
runs on your own computer: no accounts in the cloud, no data leaves the machine.

## Features

**For teachers**

- **Classes and rosters.** Create classes, then add students by pasting a list of names and emails.
  New students get a one-time temporary password; the first time they sign in, the app asks them to
  choose their own before they can continue. Students can also register themselves and join with the
  class's 6-character join code. You can reset the password of a student you added, or of a student who
  is only in your classes (a student who is also in another teacher's class changes it on their Account
  page), or remove a student from a class; their submissions are kept.
- **Autograded assignments.** Upload the finished workbook as the answer key, plus an optional starter
  file for students to download. Before saving, a preview shows exactly which cells will be checked.
  Choose what to check (every filled cell, only formula cells, or specific ranges), the numeric
  tolerance, whether text is case-sensitive, and whether hard-coded answers count.
- **Manual grading.** No answer key? Choose Manual grading (if you try to save an autograded assignment
  without a key, the form offers a one-click switch) and grade each submission yourself. Open any
  student workbook in the in-browser viewer, with formulas, formatting and merged cells, or download the
  original file. Viewing is there when you want it, never required.
- **Overrides and feedback.** Override any autograded score (up to double the points for extra credit)
  and leave written feedback.
- **Late work.** Submissions are always accepted, but anything turned in after the due date carries a
  clear LATE flag everywhere you view or grade it, and the grading page shows how late it was.
- **Gradebook.** Every student and assignment in one table, with CSV export for your school's system.
- **Re-grading.** Change the answer key, starter file, settings or points and every submission is
  re-graded at once.

**For students**

- See every assignment across your classes with its due date and status: not submitted, missing,
  submitted, or graded.
- Download the starter file, upload your workbook, and get your score immediately on autograded work,
  with a cell-by-cell report when the teacher allows it.
- Re-submit as often as you like before (or after) the due date; the latest attempt counts.

## Requirements

- **Node.js 22.13 or newer** (the app uses Node's built-in SQLite module, which needs no flag from 22.13
  on). Developed and tested on Node 24. Get the LTS version from [nodejs.org](https://nodejs.org).
- **Git**, so the app can download itself and pull updates from GitHub.

The install scripts check both and, where possible, offer to install them for you (Homebrew on macOS,
winget on Windows).

## Install

The installer downloads the app from GitHub, installs its dependencies, builds the web app, asks whether
to load demo data, and starts it. When it finishes, open **http://localhost:3001**.

**Windows**: open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/Marquette-Catholic-High-School/ExcelAutoGrader/main/install.ps1 | iex
```

**macOS or Linux**: open Terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Marquette-Catholic-High-School/ExcelAutoGrader/main/install.sh | bash
```

The app goes into an `ExcelAutoGrader` folder in your home folder. To use a different folder, set
`EXCEL_AUTOGRADER_DIR` first (PowerShell: `$env:EXCEL_AUTOGRADER_DIR = 'D:\ExcelAutoGrader'`; macOS/Linux:
`export EXCEL_AUTOGRADER_DIR=/opt/excel-autograder`).

Already cloned the repository yourself, or downloaded it from GitHub as a ZIP file (extract it first)?
Run the installer inside the folder instead: double-click `install.cmd` on Windows, or run `./install.sh`
on macOS/Linux. A ZIP download is connected to GitHub by the installer, so it can update itself like a
normal install. The installer can be run again at any time; it keeps your data and settings (a running
app is stopped while its files are replaced and started again at the end).

Installer options (add them after `./install.sh`, after `install.cmd` in a terminal, or after
`bash -s --` when piping from curl). `irm ... | iex` cannot pass options; in PowerShell use this form instead:
`& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Marquette-Catholic-High-School/ExcelAutoGrader/main/install.ps1))) --demo --port 8080`

| Option | What it does |
|---|---|
| `--demo` | Load the demo teacher, students and assignments (asks before replacing existing data) |
| `--no-demo` | Start with an empty database; open the app and choose "Create an account" to make a teacher account |
| `--port <n>` | Port to use (default 3001) |
| `--host 0.0.0.0` | Let other computers on your network open the app (default: this computer only) |
| `--start` | Start the app at the end without asking |
| `--no-start` | Don't start the app at the end |
| `--yes` | Use the defaults without asking any questions |
| `--help` | Show the options (nothing is downloaded) |

## Running the installed app

Run these in the install folder. On Windows, double-click the `.cmd` files or run them in a terminal
(`.\start-app.cmd`); plain `npm start` in PowerShell fails on most Windows computers because PowerShell
blocks npm's own script there (use `npm.cmd start` if you prefer npm).

| macOS/Linux | Windows | What it does |
|---|---|---|
| `npm start` | `start-app.cmd` | Starts the app in the background and prints its address |
| `npm stop` | `stop-app.cmd` | Stops it |
| `npm restart` | `restart-app.cmd` | Restarts it (needed after editing `config.env`) |
| `npm run status` | `status-app.cmd` | Shows whether it is running (exit code 0: running, 3: not running) |
| `npm run serve` | `npm.cmd run serve` | Runs it in the terminal window instead (Ctrl+C stops it) |

The server's output goes to `logs/server.log`. The app does not start by itself when the computer
restarts; start it again (or add the start command to your computer's startup tasks). If the port is
already used by another program, the start command says so; change `PORT` in `config.env`.

### Settings (`config.env`)

The installer creates `config.env` in the install folder. Edit it, then restart the app (`npm restart`;
Windows: `restart-app.cmd`):

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | The app's address is http://localhost:PORT |
| `HOST` | `127.0.0.1` | `127.0.0.1`: only this computer can open the app. `0.0.0.0`: other computers on the network can too, at http://this-computer's-name-or-IP:PORT. Anyone who can reach it can create an account, so only open it on a network you trust. |
| `DATA_DIR` | `server/data` | Folder for the database and uploaded workbooks. A relative path is relative to the install folder; `~` means your home folder. |

`config.env`, `logs/` and the data folder are not part of the repository, so updates never touch them.

## Updating

When a new version is pushed to GitHub, update an installed copy with:

- **Windows**: double-click `update.cmd` in the install folder (or, in PowerShell there:
  `powershell -ExecutionPolicy Bypass -File .\update.ps1`).
- **macOS/Linux**: run `./update.sh` in the install folder (or `npm run update`).

The update script:

1. Checks GitHub for a new version. If there is none, it stops there.
2. Downloads it, reinstalls dependencies if they changed (the app is stopped for that), and builds the new
   web app next to the current one while the app keeps running.
3. Stops the app, backs up the database to `<data folder>/backups/` (the newest 10 backups are kept),
   switches to the new web app and starts the new version, if the app was running.

If any step fails, it puts the previous version back and starts it again. If the new version had already
started (and so may have changed the database), the database is put back from the backup made in step 3.
`config.env` and the data folder are never part of an update: an update that would overwrite them is
refused. Only one install or update runs at a time; a second one stops with a message (so do the start and
stop commands while an update runs).

| Option | What it does |
|---|---|
| `--check` | Only report whether a new version is available (exit code 0: up to date, 100: a new version is available) |
| `--force` | Reinstall, rebuild and restart even when already up to date |
| `--no-restart` | Leave the running app alone; restart it yourself soon (ignored when dependencies change) |
| `--discard-changes` | Move edits made to the app's own files in the install folder (and files in the way of new ones) into `logs/discarded-<time>/`; the update refuses to run while there are any |
| `--reset-to-github` | Switch to GitHub's version even though this copy has commits GitHub doesn't have, for example after GitHub's history was rewritten |
| `--yes` | Don't ask questions (needed with `--discard-changes` and `--reset-to-github` when there is no terminal) |

**Updating automatically.** The update script does nothing when there is no new version, so it is safe
to run on a schedule.

- macOS/Linux, every night at 2 AM: run `crontab -e` and add (with your install folder; cron has a
  minimal PATH, so include the folder that contains `node`, `npm` and `git`):

  ```
  0 2 * * * PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin /home/you/ExcelAutoGrader/update.sh --yes >> /home/you/ExcelAutoGrader/logs/update.log 2>&1
  ```

- Windows: in Task Scheduler, create a daily task whose action is
  `cmd.exe /c ""C:\Users\you\ExcelAutoGrader\update.cmd" --yes >> "C:\Users\you\ExcelAutoGrader\logs\update.log" 2>&1"`,
  run as the same user who installed the app. (Always pass an option such as `--yes`: without one,
  `update.cmd` waits for a key press at the end, as it does when double-clicked.)

Run the update as the account that installed the app, never with `sudo`; it refuses otherwise.

## Backups and restoring

- Every update backs up the database to `<data folder>/backups/app-<date>-<time>.db` before it switches to
  the new version.
- `npm run backup` (Windows: `npm.cmd run backup`) copies the database **and** the uploaded workbooks into
  `<data folder>/backups/full-<date>-<time>/`. `npm run backup -- D:\Backups` puts the copy somewhere
  else, such as a USB drive or a synced folder. It is safe while the app is running.
- Loading demo data over existing data (installer `--demo`, `npm run seed`) makes such a full backup first.

To put a backup back, use the restore command (never copy a backup over `app.db` by hand: the database's
`app.db-wal` file would no longer match, which corrupts it):

```bash
npm run restore              # lists the backups, newest first
npm run restore -- 3         # restores number 3 from the list (or: latest, or a file/folder path)
```

It asks first, stops the app if it is running, moves the current database (and, for a full backup, the
uploads) into `<data folder>/backups/before-restore-<date>-<time>/`, puts the backup in place, checks
it, and starts the app again. To undo a restore, restore that `before-restore-...` folder.

## Development

For working on the code (hot reload, separate API and web servers):

```bash
npm install
npm run seed     # creates demo data (and resets anything already there)
npm run dev      # starts the API and the web app
```

Then open **http://localhost:5173** and sign in with one of the demo accounts below.

`npm run dev` starts two processes: the web app (Vite, port 5173) and the API (Express, port 3001, on
127.0.0.1 only). The web app forwards every `/api` request to the API, so you only ever open port 5173.
Don't run `npm run dev` and `npm start` at the same time with the same port.

Node prints `ExperimentalWarning: SQLite is an experimental feature` when the dev server starts. That is
expected and harmless.

## Demo accounts

`npm run seed` (or the installer's `--demo` option) creates these accounts. Every password is `password123`,
except Finn's.

| Role | Name | Email | What's there |
|---|---|---|---|
| Teacher | Ms. Rivera | `teacher@demo.test` | Owns both demo classes |
| Student | Ava Thompson | `ava@demo.test` | Perfect Monthly Budget; Sales Report waiting to be graded; also in Spreadsheet Skills |
| Student | Ben Carter | `ben@demo.test` | Monthly Budget with mistakes and teacher feedback; Sales Report graded 42/50 |
| Student | Chloe Nguyen | `chloe@demo.test` | Monthly Budget with typed-in totals (formulas required) |
| Student | Diego Ramirez | `diego@demo.test` | Two Monthly Budget attempts: a weak one on time, a better one a day **late** |
| Student | Emma Wilson | `emma@demo.test` | Missed the Monthly Budget; finished the warm-up in Spreadsheet Skills |
| Student | Finn Murphy | `finn@demo.test` | Added by the teacher with a temporary password (printed by `npm run seed`); must choose a new password at first sign-in (the app keeps him on the Account page until he does) |

The demo classes:

- **Business Computing 101** (6 students)
  - *Monthly Budget*: autograded with an answer key and starter file, 20 points, due 3 days ago.
  - *Quarterly Sales Report*: graded manually (no answer key), 50 points, due in 5 days.
  - *Grade Calculator*: autograded, 10 points, due in 10 days, no submissions yet.
- **Spreadsheet Skills** (Ava and Emma)
  - *Cell References Warm-up*: autograded (formula cells only, expected answers shown to students).

The seed prints each class's join code. To try joining, register a new student account and enter it.

The [`samples/`](samples/) folder has workbooks for trying uploads by hand: answer keys, starter files,
and student files that score perfectly, have mistakes, or have typed-in totals. Its README lists what
each one scores.

## How autograding works

When a teacher creates an autograded assignment, the app requires the finished workbook: the answer key.
Each student upload is compared against it the moment it arrives.

**Which cells are checked.** The grading scope decides:

- *Every filled cell* (default): every cell in the key that has a value or a formula.
- *Formula cells only*: just the cells that contain a formula in the key.
- *Specific ranges*: only cells inside ranges such as `B2:D10` or `'Q3 Sales'!E5:E8` (a range without a
  sheet name means the first sheet).

**Starter file exclusion.** When a starter file is attached, cells that are identical in the key and the
starter are skipped (the same value, and the same formula if there is one). Students only earn credit
for the work they add, not for labels and numbers they were given. With the sample Monthly Budget this
turns 61 filled cells into the 23 formula cells students actually write. The assignment form previews
the exact cells, and refuses a key that leaves nothing to check.

**Sheet matching.** Each key sheet is paired with a student sheet by exact name, then by name ignoring
case and surrounding spaces. A key sheet still without a partner then takes the first student sheet that
is not paired yet, in order, and the report warns about it. Key sheets with nothing to grade are ignored
when pairing, so a one-sheet CSV is compared with the first graded sheet. If no sheet matches, its cells
are marked "missing sheet".

**Comparing values.**

- Numbers match within the numeric tolerance (default 0.01, so rounding differences in cents don't
  matter). The tolerance follows how the key cell is displayed: for percentages it is in percentage
  points (0.01 means ±0.01%, so 13.5% does not match 12.9%), and time cells must match to the second.
  A tolerance of 0 means exactly equal. Numeric text such as `$1,234.50`, `25%` or `(1,200)` compares
  as the number it shows.
- Text ignores case and extra spaces by default; both can be turned on.
- TRUE/FALSE match their text, error values (`#DIV/0!`) compare by their text, and dates compare as the
  dates they are (workbooks saved in the 1904 date system are converted).

**Formulas required.** When a key cell contains a formula, the student's cell must contain a formula too
(the default). The formula doesn't have to match the key's: `=B5+B6` and `=SUM(B5:B6)` are both right if
the result is right. A correct number typed in by hand fails as "formula required". A formula that just
types the number (`=3770` or `=3200+520`) counts as hard-coded too; where the key's own formula is like
that, typed values are accepted. Results filled by array or spill formulas (such as `=B2:B4*C2:C4`)
count as formulas. Teachers can turn this off to accept typed values. CSV files cannot hold formulas, so
the report warns when a CSV submission loses points this way.

**Date and random formulas.** Cells whose key formula uses TODAY(), NOW() or RAND() (or RANDBETWEEN() or
RANDARRAY()) can't be compared by value, because the saved result depends on when the file was
calculated. They count as correct when the student's formula uses the same function; the preview and
the report warn about them.

**Score.** The score is `points × correct ÷ checked`, rounded to 2 decimals. The full cell-by-cell report
(expected and actual values and formulas) is always available to the teacher. Students see it when the
teacher allows it, and see the expected answers only if the teacher turns that on (off by default).

**Recalculation.** Files saved by Excel store each formula's result, and the grader uses those results.
Some other tools save formulas without results; the grader then calculates them itself (with
HyperFormula). It also recalculates files that store only zeros and ask Excel to recalculate on open,
as pandas and XlsxWriter do. A function it can't calculate shows up as an error with a warning to
re-save the file in Excel.

**Re-grading.** Changing the answer key, starter file, grading settings, mode or points re-grades every
submission right away; a Regrade action is also available. Teacher overrides and feedback are kept.

**Files.** `.xlsx`, `.xlsm`, `.xls`, `.ods` and `.csv`, up to 25 MB. Every upload is checked first, and
files that aren't readable spreadsheets (renamed PDFs, corrupt or password-protected files) are rejected
with an explanation. Workbooks with more than about 2,000,000 filled cells are rejected as too large.
CSV files saved with semicolons (European Excel) are read with decimal commas. If grading a readable
file fails for any other reason, the submission is still saved and waits for the teacher to grade it by
hand.

## Late policy

- Students can always upload, before or after the due date. Nothing is ever blocked.
- A submission is **late** when it arrives after the assignment's due date. Lateness is worked out from
  the current due date, so extending a deadline clears the flag on work that is now on time (and moving
  it earlier adds it).
- Late work carries a LATE badge on the student's own page, the teacher's submission list, the grading
  page and the gradebook, and the grading page says how late it was. The CSV export writes `18.26 LATE`
  (or `Ungraded LATE` when the work has no score yet).
- Each upload is a new attempt and the latest one counts, so a late re-submission makes the assignment
  late. Earlier attempts stay viewable.
- There is no automatic penalty. Teachers decide, and can override the score.

## Manual grading

Choose **Manual grading** when creating an assignment. If you try to save an autograded assignment
without an answer key, the form asks for one and offers a one-click switch to manual grading. Students
submit the same way. On the assignment page each submission shows as *Needs grading*. Open it to view
the workbook in the browser (optional: you can also download the original), then enter a score and
feedback. Scores can go from 0 up to double the assignment's points for extra credit.

An autograded assignment can be switched to manual at any time. The answer key is kept, so switching
back re-grades everything.

## Project structure

```
Excel Autograder/
├── client/                React + Mantine web app (Vite)
│   └── src/
│       ├── api/           Typed API client for every endpoint
│       ├── auth/          Sign-in state
│       ├── components/    Layout, spreadsheet viewer, grade report, upload dropzone, status badges
│       └── pages/         Teacher, student, sign-in and account pages
├── server/                Express API (TypeScript, run with tsx)
│   ├── data/              Database and uploaded files (created on first run; not in version control)
│   └── src/
│       ├── routes/        HTTP endpoints: auth, classes, assignments, submissions, gradebook
│       ├── services/      Business logic shared by the routes
│       ├── grader/        The spreadsheet engine: reading, recalculation, cell selection, comparison
│       ├── demo/          Demo data and workbooks used by the seed
│       ├── db.ts          SQLite schema and helpers
│       └── seed.ts        npm run seed
├── shared/types.ts        Request and response types shared by client and server
├── docs/API.md            The HTTP API contract
├── samples/               Example workbooks to upload by hand
├── scripts/               Install, update, start/stop, backup and restore logic (plain Node, same on every OS)
├── install.sh / .ps1 / .cmd   Installers for macOS/Linux and Windows
├── update.sh / .ps1 / .cmd    Updaters for macOS/Linux and Windows
└── start-app.cmd, stop-app.cmd, restart-app.cmd, status-app.cmd   Windows shortcuts for npm start/stop/...
```

## Scripts

Run these from the project folder:

| Command | What it does |
|---|---|
| `npm run dev` | Development: starts the API (port 3001) and the web app (http://localhost:5173), reloading on changes |
| `npm run setup` | What the installer runs after downloading: dependencies, `config.env`, build, optional demo data, start |
| `npm start` / `npm stop` / `npm restart` / `npm run status` | Run the installed app in the background (see above) |
| `npm run serve` | Run the installed app in this terminal |
| `npm run update` | Update from GitHub (same as `update.sh` / `update.cmd`) |
| `npm run backup` / `npm run restore` | Back up the database and uploads / put a backup back (see above) |
| `npm run seed` | Deletes all data and creates the demo data (asks first when there are real accounts; in an installed copy it backs everything up first). Add `-- --samples` to also rewrite `samples/` |
| `npm test` | Runs the server test suite (Node's built-in test runner) |
| `npm run typecheck` | Type-checks the server and the client |
| `npm run build` | Builds the web app into `client/dist` |

## Data and resetting

Everything is stored in `server/data/` (or `DATA_DIR` from `config.env`):

- `app.db`: the SQLite database (accounts, classes, assignments, submissions and grades).
- `uploads/`: every uploaded workbook (answer keys, starter files, submissions).
- `backups/`: database copies made by the update script and by `npm run backup` (see
  [Backups and restoring](#backups-and-restoring)).

To start over with demo data, run `npm run seed`. It refuses to run when `NODE_ENV=production`, and asks
before deleting accounts that are not demo accounts (`--yes` skips the question). It empties the database
and the uploads folder, then creates the demo data, and works whether or not the app is running (if it
is, just sign in again). For a completely empty app with no demo data, stop the app and rename the
`server/data` folder (keep it until you are sure you don't need it); a new one is created on the next start.

Development settings, through environment variables (the installed app uses `config.env` instead):

| Variable | Default | Used for |
|---|---|---|
| `DATA_DIR` | `server/data` | Where the database and uploads live (a relative path is relative to the project folder) |
| `API_PORT` | `3001` | API port for `npm run dev` (also change the proxy in `client/vite.config.ts`) |

By default the app only listens on 127.0.0.1 (this computer). Passwords are stored as salted scrypt
hashes, and sign-in sessions last 30 days.
