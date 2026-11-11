# Excel Autograder

A local web app for teaching with spreadsheets. Teachers create classes, add students by email and post
assignments. Students upload their Excel workbooks, and the app grades them cell by cell against the
teacher's finished workbook (the answer key). Assignments without an answer key are graded by hand,
with the student's workbook viewable right in the browser.

Built with React and Mantine UI on the front end, and Express with SQLite on the back end. Everything
runs on your own computer: no accounts in the cloud. Nothing leaves the machine except email, if you turn
it on (it is sent through Cloudflare; see [Email notifications](#email-notifications)).

## Features

**For teachers**

- **Classes and rosters.** Create classes, then add students by email: paste a list of names and
  emails, or upload a roster file (CSV, Excel or OpenDocument, such as an export from Google Classroom or
  your student information system). The app shows what it found in the file before anything is added.
  Students don't need an account first: when a student signs up with the email you added (and the
  class code), the app matches them automatically, and they find their classes, and any work you uploaded for them, right
  away. Students can also register themselves and join with the class's 6-character join code. You can
  give a student a temporary password instead (or reset the password of a student you added, or of one
  who is only in your classes; a student who is also in another teacher's class changes it on their
  Account page), or remove a student from a class; their submissions are kept. See
  [Adding students](#adding-students).
- **Submitting for students.** Upload a workbook on a student's behalf (handed in on a USB stick or by
  email), even if they haven't signed up yet. It is graded and flagged late like any other submission,
  and the student sees it as soon as they sign up.
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
- **PDF reports.** Export a report for an assignment (summary, score distribution, every student's result,
  most-missed cells), for one student (every assignment with scores and your feedback), for every student
  of a class at once, or the whole gradebook. See [Reports (PDF)](#reports-pdf).
- **Email notifications.** Students get a receipt when work is submitted and reminders when an assignment
  is overdue; you choose per class whether, when and how often. You get a daily report about your
  classes. Sent through Cloudflare Email Service; see [Email notifications](#email-notifications).
- **Re-grading.** Change the answer key, starter file, settings or points and every submission is
  re-graded at once.

**For students**

- See every assignment across your classes with its due date and status: not submitted, missing,
  submitted, or graded.
- Download the starter file, upload your workbook, and get your score immediately on autograded work,
  with a cell-by-cell report when the teacher allows it.
- Re-submit as often as you like before (or after) the due date; the latest attempt counts.
- When the school has turned email on: a receipt for every submission and a reminder about overdue work
  (each student can turn these off on their Account page).

## Requirements

- **Node.js 22.13 or newer** (the app uses Node's built-in SQLite module, which needs no flag from 22.13
  on). Developed and tested on Node 24. Get the LTS version from [nodejs.org](https://nodejs.org).
- **Git**, so the app can download itself and pull updates from GitHub.

The install scripts check both and, where possible, offer to install them for you (Homebrew on macOS,
winget on Windows).

## Install

The installer downloads the app from GitHub, installs its dependencies, builds the web app, asks whether
to load demo data, asks for the Cloudflare API token that turns on email (press Enter to skip; see
[Email notifications](#email-notifications)), and starts it.

- **Windows and Linux**: the app is hosted on **port 80** for your network. Open **http://localhost** on that
  computer. From other computers use **http://computer-name** if your network knows the name, or the
  computer's IP address (the installer prints both). The installer takes care of what port 80 needs on
  each system (see [Port 80 and network access](#port-80-and-network-access)).
- **macOS**: the app stays private to that computer at **http://localhost:3001**.

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
| `--port <n>` | Port to use (default: 80 on Windows and Linux, 3001 on macOS) |
| `--host <ip>` | `0.0.0.0`: other computers on your network can open the app (default on Windows and Linux). `127.0.0.1`: only this computer (default on macOS) |
| `--start` | Start the app at the end without asking |
| `--no-start` | Don't start the app at the end |
| `--no-email-setup` | Don't ask for the Cloudflare API token; email stays off until you run `npm run email-setup` (Windows: `email-setup.cmd`) |
| `--yes` | Use the defaults without asking any questions. Email stays off, unless the token is in the `CLOUDFLARE_API_TOKEN` environment variable (see [Setting up email](#setting-up-email-cloudflare)) |
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
| `npm run email-setup` | `email-setup.cmd` | Turns email on (asks for the Cloudflare API token), or changes, tests or removes the token; restarts the app if it is running |

The server's output goes to `logs/server.log`. The app does not start by itself when the computer
restarts; start it again (or add the start command to your computer's startup tasks). If the port is
already used by another program, the start command says so; change `PORT` in `config.env`.

### Settings (`config.env`)

The installer creates `config.env` in the install folder. Edit it, then restart the app (`npm restart`;
Windows: `restart-app.cmd`):

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `80` (Windows, Linux), `3001` (macOS) | The app's address is http://localhost:PORT (just http://localhost on port 80) |
| `HOST` | `0.0.0.0` (Windows, Linux), `127.0.0.1` (macOS) | `127.0.0.1`: only this computer can open the app. `0.0.0.0`: other computers on the network can too, at http://this-computer's-name-or-IP:PORT. Anyone who can reach it can create an account, so only open it on a network you trust. |
| `DATA_DIR` | `server/data` | Folder for the database and uploaded workbooks. A relative path is relative to the install folder; `~` means your home folder. |
| `REQUIRE_CODE_FOR_INVITES` | `1` | `1`: a student you added by email signs up with that email **and** the class code (see [Adding students](#adding-students)). `0`: the email alone is enough. |
| `CLOUDFLARE_API_TOKEN` | empty | The Cloudflare API token that sends email (needs the "Email Sending: Edit" permission). Empty: the app sends no email. Set it with `npm run email-setup` rather than by hand. **Keep `config.env` private** while it holds a token. |
| `EMAIL_FROM_NAME` | `Podner's Excel` | Sender name on every email (no quotes needed) |
| `EMAIL_FROM_ADDRESS` | `noreply@mchstech.org` | Sender address. Its domain must be onboarded for Email Sending in Cloudflare. |
| `SMTP_HOST` | `smtp.mx.cloudflare.net` | Cloudflare's mail server |
| `SMTP_PORT` | `465` | Cloudflare only accepts port 465 (TLS from the start; 587/STARTTLS is not supported) |
| `SMTP_USER` | `api_token` | The user name, literally `api_token`; the token is the password |
| `APP_URL` | empty | The address students use to open the app, for the links in emails, e.g. `http://grading-pc` or `https://grader.mchstech.org`. Empty: a guess from this computer's name. |
| `TIME_ZONE` | empty | Time zone for the daily report time and reminders, e.g. `America/Chicago`. Empty: this computer's time zone (Linux servers are often set to UTC; check with `timedatectl`). |
| `EMAIL_DAILY_LIMIT` | empty (2000) | Most emails the app sends in 24 hours. A guard against floods (see [Limits and unsubscribing](#limits-and-unsubscribing)). |
| `PDF_FALLBACK_FONTS` | empty | Not in `config.env` by default; add it if needed. Font files (separated by `:`, on Windows `;`) for names in scripts the PDF font lacks, see [Reports (PDF)](#reports-pdf). |

`config.env`, `logs/` and the data folder are not part of the repository, so updates never replace them.
The installer and the update add settings that are new in a version to an existing `config.env` (with
their explanations), without changing the values already there. On macOS and Linux they also make the
file readable by its owner only (`chmod 600`), because it can hold the API token.

### Port 80 and network access

On Windows and Linux the installer sets `PORT=80` and `HOST=0.0.0.0`, so people open the app by the
computer's name alone, e.g. **http://grading-pc**, with no port number. During installation it also:

- **Windows**: offers to add a Windows Defender Firewall rule for the port, so other computers can connect
  (Windows asks for administrator permission once). It also removes rules that block Node.js, which an
  earlier "Windows Defender Firewall has blocked some features" pop-up may have created. The rule covers
  **domain and private networks**; if Windows treats your network as **Public**, the installer says so and
  shows how to switch it to Private (Settings > Network & internet > the network > Network profile type).
  Port 80 needs no other permission on Windows. If the installer says port 80 is already used, another web
  server has it, usually IIS or another service built on Windows' HTTP.sys (`netsh http show servicestate`
  lists them). Stop that service, or use another port.
- **Linux**: ports below 1024 are normally for administrators only. The installer offers to give Node.js
  just that one permission (`sudo setcap cap_net_bind_service=+ep <path to node>`), so the app still runs
  as a normal user. The permission belongs to that Node.js program, for every user of the computer, so on a
  shared server prefer a Node.js installed just for the app's account (e.g. with nvm). Upgrading Node.js
  removes the permission: run the installer again afterwards (until then, restart and update refuse to
  stop the running app, so it keeps working). If the server's firewall is on, allow the port:
  `sudo ufw allow 80/tcp` (Ubuntu/Debian) or
  `sudo firewall-cmd --permanent --add-port=80/tcp && sudo firewall-cmd --reload` (RHEL/Fedora). Don't start
  the app with `sudo`; the scripts refuse to run as a different user than the one who installed it.
- **macOS**: keeps port 3001 for this computer only. Port 80 also works on a Mac, but only together with
  `HOST=0.0.0.0`.

**Copies installed before port 80 became the default** keep their port, because updates never change the
values in `config.env`. To switch one, run its installer again with `--port 80 --host 0.0.0.0` (on
Windows, in a terminal in the install folder: `install.cmd --port 80 --host 0.0.0.0`), which also sets up
the firewall or permission. Or edit `config.env` yourself and restart the app.

To keep the app private to one computer instead, install with `--host 127.0.0.1` (and any port), or set
`HOST=127.0.0.1` in `config.env`. Anyone who can reach the app can create an account, so only open it on a
network you trust.

## Updating

When a new version is pushed to GitHub, update an installed copy with:

- **Windows**: double-click `update.cmd` in the install folder (or, in PowerShell there:
  `powershell -ExecutionPolicy Bypass -File .\update.ps1`).
- **macOS/Linux**: run `./update.sh` in the install folder (or `npm run update`).

The update script:

1. Checks GitHub for a new version. If there is none, it stops there.
2. Downloads it and adds settings that are new in this version to `config.env` (your values are kept).
   While email is off and you are at the terminal, it asks for the **Cloudflare API token** that turns it
   on: paste it and press Enter (nothing shows while you type or paste; that is on purpose), or just press
   Enter to skip. It then checks the token with Cloudflare, asks for the address students use to open the
   app and the time zone, and offers to send a test email. See [Setting up email](#setting-up-email-cloudflare).
   The app keeps running while the update waits for your answer.
3. Reinstalls dependencies if they changed (the app is stopped for that), and builds the new web app next
   to the current one.
4. Stops the app, backs up the database to `<data folder>/backups/` (the newest 10 backups are kept),
   switches to the new web app and starts the new version with the new settings, if the app was running.

If any step fails, it puts the previous version back and starts it again. If the new version had already
started (and so may have changed the database), the database is put back from the backup made in step 4.
`config.env` and the data folder are never downloaded: an update that would overwrite them is refused.
If an update is cut off halfway (the SSH session or terminal closed, the computer restarted), just run the
update again: it finishes the cut-off update first (installing, building and starting the new version).
Only one install or update runs at a time; a second one stops with a message (so do the start and stop
commands while an update runs).

| Option | What it does |
|---|---|
| `--check` | Only report whether a new version is available (exit code 0: up to date, 100: a new version is available) |
| `--force` | Reinstall, rebuild and restart even when already up to date |
| `--no-restart` | Leave the running app alone; restart it yourself soon (ignored when dependencies change) |
| `--discard-changes` | Move edits made to the app's own files in the install folder (and files in the way of new ones) into `logs/discarded-<time>/`; the update refuses to run while there are any |
| `--reset-to-github` | Switch to GitHub's version even though this copy has commits GitHub doesn't have, for example after GitHub's history was rewritten |
| `--no-email-setup` | Don't ask for the Cloudflare API token (prints "Email is off; run npm run email-setup to turn it on" instead). **The first update from a version without email doesn't know this option yet** and stops with "Unknown option": for that update use `EXCEL_AUTOGRADER_EMAIL_SETUP=skip ./update.sh` (Windows PowerShell: `$env:EXCEL_AUTOGRADER_EMAIL_SETUP='skip'; .\update.ps1`), `--yes`, or just press Enter at the question. From then on the option works. |
| `--yes` | Don't ask questions (needed with `--discard-changes` and `--reset-to-github` when there is no terminal). Email stays as it is, unless email is off and the token is in the `CLOUDFLARE_API_TOKEN` environment variable, which is then saved |

**Updating automatically.** The update script does nothing when there is no new version, so it is safe
to run on a schedule. Scheduled runs never wait for the token question (there is no terminal, and the
examples pass `--yes`).

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
except Finn's and Grace's.

| Role | Name | Email | What's there |
|---|---|---|---|
| Teacher | Ms. Rivera | `teacher@demo.test` | Owns both demo classes |
| Student | Ava Thompson | `ava@demo.test` | Perfect Monthly Budget; Sales Report waiting to be graded; also in Spreadsheet Skills |
| Student | Ben Carter | `ben@demo.test` | Monthly Budget with mistakes and teacher feedback; Sales Report graded 42/50 |
| Student | Chloe Nguyen | `chloe@demo.test` | Monthly Budget with typed-in totals (formulas required) |
| Student | Diego Ramirez | `diego@demo.test` | Two Monthly Budget attempts: a weak one on time, a better one a day **late** |
| Student | Emma Wilson | `emma@demo.test` | Missed the Monthly Budget; finished the warm-up in Spreadsheet Skills |
| Student | Finn Murphy | `finn@demo.test` | Added by email; the teacher then created a temporary password for him (printed by `npm run seed`). He must choose a new password at first sign-in (the app keeps him on the Account page until he does) |
| Student | Grace Lee | `grace@demo.test` | Added by email, hasn't signed up yet: create an account with `grace@demo.test` (as a student, any password) and Business Computing 101's join code (printed by `npm run seed`) when asked, and she lands in that class with the Monthly Budget the teacher uploaded for her, already graded |

The demo classes:

- **Business Computing 101** (7 students)
  - *Monthly Budget*: autograded with an answer key and starter file, 20 points, due 3 days ago.
  - *Quarterly Sales Report*: graded manually (no answer key), 50 points, due in 5 days.
  - *Grade Calculator*: autograded, 10 points, due in 10 days, no submissions yet.
- **Spreadsheet Skills** (Ava and Emma)
  - *Cell References Warm-up*: autograded (formula cells only, expected answers shown to students).

The seed prints each class's join code. To try joining, register a new student account and enter it.
To try a roster upload, upload [`samples/class-roster.csv`](samples/class-roster.csv) to a class.

The [`samples/`](samples/) folder has workbooks for trying uploads by hand: answer keys, starter files,
and student files that score perfectly, have mistakes, or have typed-in totals. Its README lists what
each one scores.

## Adding students

Add students to a class by email, one at a time, by pasting a list, or by uploading a roster file
(`.csv`, `.xlsx`, `.xls` or `.ods`): open the class, then **Students** → **Add students** and pick
**Add one**, **Paste a list** or **Upload a file** (which also offers a blank CSV template). For a file, the
app reads the first sheet and shows each row before anything is added: who will be invited, who already
has an account, who is already in the class, and rows it can't use (a missing or invalid email, or a
teacher's email). Students another teacher already invited but who haven't signed up yet show as invited.

```csv
First Name,Last Name,Email
Ada,Lovelace,ada.lovelace@school.edu
Alan,Turing,alan.turing@school.edu
,,grace.hopper@school.edu
```

Accepted columns (headings are matched loosely, ignoring case):

| Column | Headings it recognizes |
|---|---|
| Email (required) | Any heading with "email", "e-mail" or "mail" in it: `Email`, `Email Address`, `Student Email`, `Email_Addr`, ... Cells like `Jane Doe <jane@school.edu>` work too. Columns for someone else (`Parent Email`, `Guardian Email`, `Contact Email`, ...) are never used, so parents are not invited as students; a file whose only emails are parents' is refused with an explanation. Without a heading, the column that holds email addresses is used. |
| Name (optional) | `Name`, `Full Name`, `Student`, `Student Name`, `LastFirst` (PowerSchool); or `First Name` / `Given Name` together with `Last Name` / `Surname` / `Family Name`. Names written `Last, First` become "First Last". |

Other columns, title rows above the headings, and rows without a name or email are ignored, so exports
from Google Classroom and most student information systems work as they are. A file without a heading
row works too when one column holds the emails. Repeated emails are listed once, and up to 1,000
students are read per file. CSVs saved by Excel's plain "CSV" option (not "CSV UTF-8") keep their
accents and apostrophes ("O’Brien", "Muñoz").

What happens next:

- **A new email** becomes a student who hasn't signed up yet. They appear in the roster, the submissions
  lists and the gradebook (and its CSV export), and you can upload and grade work for them. Without a
  name, a stand-in is made from the email (`jane.doe@...` becomes "Jane Doe") and replaced by the name the
  student signs up with. **Copy sign-up instructions** (on the roster and after adding) gives you a short
  message to send them, with the class code: the app sends no invitations itself. (With
  [email](#email-notifications) on, the receipts and overdue reminders such students get include the
  sign-up steps.)
- **When the student signs up** with that email (as a student; capitals and extra spaces don't matter),
  the sign-up page asks for the class code, the same join code shown on the class page. With the code
  of any class you (or another teacher) added them to, the app matches them to the account: they are in
  all those classes immediately, with everything you uploaded for them. If you change the join code,
  send the new one: instructions with the old code no longer work. Until they sign up, signing in tells
  them to create their account first. A student who can't sign up can get a temporary password from you
  instead.
- **An existing student account** is added to the class right away. Teacher accounts can't be added.
- **Removing** a student who never signed up and has no submissions deletes them completely, so the email
  can be added again from scratch. Deleting a class does the same for such students who were only in that
  class.
- **Good to know:** the app can't check that an email address belongs to the person signing up with it.
  That's why it also asks for the class code: someone who only knows a student's email can't take their
  place. But whoever signs up first with an email you added and the class code (a classmate, say) gets that
  student's place in your classes, the work you uploaded for them and your feedback. Send sign-up
  instructions to the students' own addresses, and check the roster after they sign up. A school that
  prefers sign-up by email alone can set `REQUIRE_CODE_FOR_INVITES=0` in
  [`config.env`](#settings-configenv). If the wrong person took an account, **Reset password** on the roster
  gives you a temporary password to hand to the real student (as long as the student isn't also in
  another teacher's class).

## Reports (PDF)

Teachers can export these PDFs (ready to print or to share at a parent conference; names in any language
print correctly):

| Report | Where | What it contains |
|---|---|---|
| **Assignment report** | An assignment's page: **Export PDF** | Class, teacher, due date, points and grading mode; how many students are enrolled, submitted, on time, late, missing and waiting for grading; average, median, high and low score; a score distribution chart; every enrolled student with status, submission time, how late, attempts and score; for autograded work, the 15 most-missed cells with the expected value or formula. Invited students who haven't signed up are marked. |
| **Student report** | A class's **Students** tab: the **⋯** menu next to a student > **Download report (PDF)**; or **Student report** on the grading page | The student's overall percentage on graded work, completed x of y, late and missing counts, the average on autograded work, then every assignment of the class in due-date order (due, submitted, status, LATE, score, %), followed by your feedback on each. |
| **All student reports** | A class's **Gradebook** tab: **All student reports (PDF)** | The student report for every student of the class in one file, each starting on a new page. |
| **Gradebook** | A class's **Gradebook** tab: **Export PDF** | Students × assignments on landscape pages (final score, LATE, missing), with totals and class averages. |

Reports are made in the background (a big class's report never slows the app down for anyone else). A
teacher can have two reports in progress at a time; when many are being made at once the app asks you to
try again in a minute.

**Names in other scripts.** The PDFs use the Roboto font, which covers Latin (José, Zoë, Łukasz),
Vietnamese (Nguyễn Thị Hương), Greek and Cyrillic. Chinese, Japanese, Korean, Arabic, Hebrew, Thai or
Devanagari names are printed with a font installed on the server: on Ubuntu run
`sudo apt install fonts-noto-cjk fonts-noto-core` and restart the app (Windows and macOS already have
suitable fonts). Without one, those characters print as `?` and the app's log says which font is missing.
To use a specific font file, set `PDF_FALLBACK_FONTS=/path/to/font.ttf` in `config.env`.

## Email notifications

With email turned on (see [Setting up email](#setting-up-email-cloudflare)), the app sends:

- **Submission receipts** to the student, after every upload (by the student, or by you on their behalf):
  assignment, class, attempt number, time, a LATE flag with how late, the autograde score when there is
  one, and a link to the assignment.
- **Overdue reminders** to students who haven't submitted an assignment after its due date. They stop as
  soon as the student submits, and say that late work is still accepted.
- **A daily report** to each teacher: new submissions since the last report (with scores and LATE flags),
  work waiting for grading, assignments due in the next 7 days with how many have submitted, and overdue
  assignments with the names of the students still missing.

Invited students who haven't signed up yet get the sign-up steps in their emails (with the class code when
`REQUIRE_CODE_FOR_INVITES` is on). Every email comes from `"Podner's Excel" <noreply@mchstech.org>`
(`EMAIL_FROM_NAME` / `EMAIL_FROM_ADDRESS` in `config.env`) and says why it was sent.

**Per class** (open the class, **Settings** tab, **Email notifications**), the teacher chooses:

| Setting | Default |
|---|---|
| Send submission receipts | On |
| Remind students about overdue work | On |
| First reminder: hours after the due date (0–168) | 12 |
| Then every: days between reminders (1–14) | 2 |
| At most: reminders per student, per assignment (1–10) | 3 |
| Include students who haven't signed up | On |

Receipts and reminders are on for every class by default once email is on; turn them off per class if you
don't want them. Reminders are only sent for assignments due after this version was installed (or after
the class was created, reminders were last turned back on, or email was turned on after running without a
token), so students are never reminded about long-past work. The **Email log** on the same tab lists every email for the class with its status
(queued, sent or failed, with the mail server's message).

**Daily report** (your **Account** page): on by default at 07:00, in the server's time zone (`TIME_ZONE`);
choose the time, or skip days with nothing new. **Send me a test email** and **Send today's report now**
are on the same page. Students can turn their own emails off on their Account page.

Emails are sent in the background: a submission never waits for email. Temporary problems (the mail
server busy, the network down) are retried a few times; the Email log shows what failed.

#### Limits and unsubscribing

The app can't check that an email address belongs to the person who typed it (anyone who can open the app
can create an account, also a teacher account, and teachers add students by email). So that nobody can use
the app to flood people from your domain:

- Every email except the test email has an **unsubscribe link** (and the `List-Unsubscribe` header, so mail
  apps show their own Unsubscribe button). It works without signing in, also for invited students who never
  signed up, and stops every email to that address; students can turn emails back on on their Account page.
- In 24 hours, one address gets at most **50** emails (`ana+1@…` and, for Gmail, `a.na@…` count as the same
  address); one teacher's classes send at most **1000**, of them at most **300** to invited students who
  haven't signed up; and the whole app sends at most **2000** (`EMAIL_DAILY_LIMIT` in `config.env`).
  Emails over a limit are not sent, and the app's log says so.
- **Send me a test email** and **Send today's report now** work 5 times in 10 minutes, one at a time.

If students on your network could create teacher accounts you don't want, keep `HOST=127.0.0.1` or limit
who can reach the app (see [Port 80 and network access](#port-80-and-network-access)).

### Setting up email (Cloudflare)

The app sends through **Cloudflare Email Service** over SMTP: `smtp.mx.cloudflare.net`, port 465 with TLS,
user name `api_token`, and a Cloudflare API token as the password.

1. In the Cloudflare dashboard, **onboard `mchstech.org` for Email Sending** (the domain of the sender
   address; Cloudflare adds the DNS records it needs). Without this every email is refused.
2. **Create an API token** (dashboard > My Profile > API Tokens > Create Token) with the
   **Email Sending: Edit** permission. Copy it; Cloudflare shows it only once.
3. On the computer running the app, in the install folder, run **`./update.sh`** (it asks while email is
   off) or **`npm run email-setup`** (Windows: double-click `email-setup.cmd`). Paste the token and press
   Enter; nothing appears while you paste, on purpose. The script checks the token with Cloudflare, asks
   for the address students use to open the app (saved as `APP_URL`, for the links in emails) and the time
   zone (`TIME_ZONE`), offers to send a test email, and restarts the app if it is running.

The installer asks the same question (Enter skips; `--no-email-setup` skips it without asking). For an
unattended install or update, put the token in the `CLOUDFLARE_API_TOKEN` environment variable instead,
without typing it into the command line (so it stays out of the shell history):

```bash
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # paste the token, press Enter
./install.sh --yes                                            # or ./update.sh --yes
```

**Where the token is kept.** In `config.env` in the install folder (`CLOUDFLARE_API_TOKEN=...`). That file
is never part of the repository, of updates or of backups, and on macOS and Linux it is readable only by
the account that runs the app (`chmod 600`). On Windows, keep the install folder inside that account's own
user folder (the default). Anyone with the token can send email as `mchstech.org`, so don't share
`config.env` or paste the token into chats or tickets. The scripts never print it. To replace it (for
example after revoking it in Cloudflare), run `npm run email-setup` and choose **change**; **remove** turns
email off again.

**Troubleshooting.** `npm run email-setup` (choose **test**) and the Account page's **Send me a test email**
show the mail server's answer. What the usual ones mean:

| Message | What to do |
|---|---|
| `535 5.7.8` / "did not accept the token" | The token is wrong, incomplete, expired or revoked, or lacks the **Email Sending: Edit** permission. Create a new one and run `npm run email-setup`. |
| `550 5.7.1` / "refused the sender" | `mchstech.org` (the domain of `EMAIL_FROM_ADDRESS`) is not onboarded for Email Sending in Cloudflare, or the address is mistyped. |
| "Could not reach smtp.mx.cloudflare.net on port 465" (timeout, refused) | This computer can't connect out to port 465: a firewall or the school's network blocks it. Check with `nc -vz smtp.mx.cloudflare.net 465` and ask the network administrator to allow it. Port 587 does not work with Cloudflare. |
| `421`, `451`, `452` | Temporary (Cloudflare busy or limiting). The app retries by itself; the test can simply be repeated later. |
| `554` | Refused by Cloudflare's sending policy: check the Email Sending page of the dashboard (limits, account status). |
| "Could not set up a secure connection" | `SMTP_PORT` must be 465. A network filter that inspects encrypted traffic can cause it too. |
| Links in emails point to the wrong address | Set `APP_URL` in `config.env` (or run `npm run email-setup` again), then restart the app. |
| The daily report comes at the wrong hour | Set `TIME_ZONE` (e.g. `America/Chicago`) in `config.env`, then restart the app. |
| Nothing is sent at all | Is a token saved (`npm run email-setup` says so), and was the app restarted since? Are receipts and reminders on in the class's Settings tab, and has the student not turned emails off? |

After editing `config.env` by hand, restart the app (`npm restart`; Windows: `restart-app.cmd`).

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
│       ├── routes/        HTTP endpoints: auth, classes, assignments, submissions, gradebook, reports, email
│       ├── services/      Business logic shared by the routes (including email/ and the PDF reports/)
│       ├── grader/        The spreadsheet engine: reading, recalculation, cell selection, comparison
│       ├── demo/          Demo data and workbooks used by the seed
│       ├── db.ts          SQLite schema and helpers
│       └── seed.ts        npm run seed
├── shared/types.ts        Request and response types shared by client and server
├── docs/API.md            The HTTP API contract
├── samples/               Example workbooks to upload by hand
├── scripts/               Install, update, start/stop, email setup, backup and restore logic (plain Node, same on every OS)
├── install.sh / .ps1 / .cmd   Installers for macOS/Linux and Windows
├── update.sh / .ps1 / .cmd    Updaters for macOS/Linux and Windows
└── start-app.cmd, stop-app.cmd, restart-app.cmd, status-app.cmd, email-setup.cmd   Windows shortcuts for npm start/stop/...
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
| `npm run email-setup` | Turn email on, or change, test or remove the Cloudflare API token (Windows: `email-setup.cmd`) |
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
| `EMAIL_TRANSPORT` | `smtp` | `log`: write emails to the server's output instead of sending them; `memory`: keep them in memory (tests). Both still need some value in `CLOUDFLARE_API_TOKEN` to count as configured. |
| `CLOUDFLARE_API_TOKEN`, `EMAIL_FROM_NAME`, ... | see [Settings](#settings-configenv) | The email settings, with the same names as in `config.env` |

By default the app only listens on 127.0.0.1 (this computer). Passwords are stored as salted scrypt
hashes, and sign-in sessions last 30 days.
