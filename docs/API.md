# Excel Autograder — HTTP API contract

Types referenced below live in [`shared/types.ts`](../shared/types.ts). Both the server and the client
must follow this document exactly. Base URL in dev: the client calls relative `/api/...` (Vite proxies to
`http://localhost:3001`).

General rules

- JSON bodies unless marked **multipart**. Successful responses are `200` with the documented body
  (`201` is also fine for creates). Errors are `4xx/5xx` with `ApiError` `{ error, fields? }`.
- Client faults caught by middleware are `4xx`, never `500`: JSON body over 1 MB → `413 { error: "The request is too large." }`;
  malformed JSON, a body that doesn't decode with its `Content-Encoding` (e.g. "gzip" over plain text), or an
  incomplete/malformed multipart upload → `400`; an unsupported charset or `Content-Encoding` → `415`.
  Any error object carrying a numeric 4xx `status`/`statusCode` keeps that status. Only unexpected failures are `500`.
- Auth: `Authorization: Bearer <token>` on every endpoint except register/login/health. `401` when missing or
  expired, `403` when signed in but not allowed, `404` when the resource does not exist. 401 messages: no token →
  "Please sign in."; an unknown or signed-out token → "Please sign in again."; a session that existed but expired →
  "Your session has expired. Please sign in again."
- Accounts with `mustChangePassword` keep working on every endpoint (the server does not block them); the
  client sends them to `/account` until they change the password.
- "Teacher" below always means *the teacher who owns the class*; "student" means *a student enrolled in the
  class*. Use the helpers in `server/src/access.ts`.
- Uploaded files: field names are given per endpoint; allowed extensions `.xlsx .xlsm .xls .csv .ods`, max 25 MB
  (see `server/src/uploads.ts`). Every uploaded spreadsheet must be validated with
  `assertReadableWorkbook` before it is stored; unreadable files → `400 { error: "<reason>" }` and the
  temp upload is discarded.
- Downloads respond with the original file as an attachment (`res.download`), auth via the Bearer header.
  They must work wherever `DATA_DIR` lives, including paths with dot-directories (e.g. `~/.excel-autograder`).
  A stored file that is missing on disk → `404 { error: "File is missing from storage." }`.

## Auth — `server/src/routes/auth.ts`

| Method & path | Who | Body | Response |
|---|---|---|---|
| `POST /api/auth/register` | anyone | `RegisterRequest` | `AuthResponse` |
| `POST /api/auth/login` | anyone | `LoginRequest` | `AuthResponse` |
| `POST /api/auth/logout` | signed in | – | `OkResponse` (deletes the session) |
| `GET /api/auth/me` | signed in | – | `{ user: User }` |
| `POST /api/auth/change-password` | signed in | `ChangePasswordRequest` | `{ user: User }` (clears `mustChangePassword`) |

- Register validation: name 1–100 chars, valid email, password ≥ 8 chars, role `teacher|student`. Duplicate
  email → `409 { error, fields: { email } }`. Emails are normalized the same way everywhere (register, login, Add
  students, import-preview): Unicode NFKC, invisible format characters (e.g. zero-width spaces) removed, trimmed,
  lower-cased.
- Login failure → `401 { error: "Incorrect email or password." }` (never reveal which). Exception: the email
  belongs to a **pending** student (added by a teacher, not signed up yet) → `401 { error: "Your teacher added this
  email, but you haven't created your account yet. Choose “Create an account” and sign up with this email.",
  code: "needs_signup", fields: { email } }` (no password check is possible: the account has none).
- Register with the email of a **pending** student account and `role: "student"` → the sign-up takes over that
  account instead of failing as a duplicate: set the password hash, `pending = 0`, `must_change_password = 0`;
  replace the name with the one entered only if the teacher's was a placeholder (`placeholder_name = 1`), then
  `placeholder_name = 0`; clear `created_by_teacher_id` (the student chose the password, so the inviting teacher no
  longer counts as the account's creator for reset-password). Its enrollments and any submissions the teacher
  uploaded stay attached. Respond like a normal register, plus `claimedClasses` (names of the classes the student
  is in). With `role: "teacher"` →
  `409 { error: "A teacher added this email as a student. Sign up as a student to join your classes.",
  fields: { email } }`. A *non-pending* existing account → `409` duplicate as before.
- change-password: wrong current password → `400 { fields: { currentPassword } }`; new password ≥ 8 chars.

## Classes & students — `server/src/routes/classes.ts`

| Method & path | Who | Body | Response |
|---|---|---|---|
| `GET /api/classes` | teacher: owned · student: enrolled | – | `ClassSummary[]` (newest first) |
| `POST /api/classes` | teacher | `CreateClassRequest` | `ClassSummary` |
| `GET /api/classes/:classId` | teacher or student | – | `ClassSummary` |
| `PATCH /api/classes/:classId` | teacher | `UpdateClassRequest` | `ClassSummary` |
| `DELETE /api/classes/:classId` | teacher | – | `OkResponse` (cascades; also delete stored files of its assignments/submissions) |
| `POST /api/classes/:classId/regenerate-code` | teacher | – | `ClassSummary` |
| `POST /api/classes/join` | student | `JoinClassRequest` | `ClassSummary` (idempotent; unknown code → `404`) |
| `GET /api/classes/:classId/students` | teacher | – | `StudentInfo[]` (sorted by name; each with `canResetPassword`) |
| `POST /api/classes/:classId/students` | teacher | `AddStudentsRequest` | `AddStudentsResponse` |
| `POST /api/classes/:classId/students/import-preview` | teacher | **multipart**: `file` (.csv .xlsx .xls .ods) | `RosterPreview` (nothing is saved) |
| `DELETE /api/classes/:classId/students/:studentId` | teacher | – | `OkResponse` (un-enrolls; submissions are kept) |
| `POST /api/classes/:classId/students/:studentId/reset-password` | teacher | – | `ResetPasswordResponse` |

- `joinCode`: 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, unique. Only included in `ClassSummary` for the owner.
- Add students (invite by email): for each `{ name, email }`: if no account exists → create a **pending** student
  account (`users.pending = 1`, empty `password_hash`, so nobody can sign in to it), record the calling teacher as
  its creator (`users.created_by_teacher_id`) and enroll it; return `created: true, pending: true`. No temporary
  password is made. A blank `name` gets a placeholder made from the email (`jane.doe@...` → "Jane Doe",
  `users.placeholder_name = 1`). If a *student* account (pending or not) exists → enroll it (`created: false`,
  `alreadyEnrolled` tells whether it was already there). A non-blank `name` for a pending account that still has a
  placeholder replaces the placeholder only when the calling teacher created that account; other teachers never
  rename an existing account. If the email belongs to a *teacher* or is invalid → goes into `errors`. Max 1000 rows
  per request. Each `added[].student` includes `canResetPassword` and `pending`.
- Pending students behave like any enrolled student for the teacher: they appear in the roster, submissions
  tables and gradebook (`StudentInfo.pending = true`), and teachers can upload submissions for them and grade
  them. They cannot sign in until they sign up (see Auth) or the teacher gives them a temporary password.
- import-preview: reads the first sheet of an uploaded CSV/Excel/OpenDocument roster (temp upload discarded) and
  returns what Add students would do with each row, without changing anything. Finds the header row and columns:
  an email column (header containing "email"/"e-mail"/"mail", or else the column whose cells look like email
  addresses) and a name from a "name"/"full name"/"student"/"LastFirst" column, or "first"/"given" +
  "last"/"surname"/"family" columns, or a single "Last, First" column (→ "First Last"). Cells like
  `Jane Doe <jane@school.edu>` count as the address (and give the name when there is no name column). Columns headed
  as someone else's (parent, guardian, mother, father, teacher, instructor, contact, emergency) are never used for
  emails; when they are the only columns with addresses → `400 { error, fields: { file } }` saying so. Files without
  a header row work when one column holds emails. Text files that are not UTF-8 are read as Windows-1252 (or Mac
  Roman when that reads clearly better). Blank rows are skipped; repeated emails are merged into the first row
  (warning); more than 1000 data rows → only the first 1000 are read (warning). No email column →
  `400 { error, fields: { file } }`. Unreadable file → `400 { fields: { file } }`. `status` per row: `invite` (no
  account, or a pending account another teacher invited), `add` (existing student account that has signed up, not
  in the class), `already` (in the class), `error` (invalid email, teacher account, ...).
- Removing a pending student from a class, or deleting a class, also deletes each pending account it leaves with
  no class and no submissions (nothing to keep; the email is free again, also for a teacher sign-up). Accounts
  that have signed up are always kept.
- There is no email verification: the first person to sign up as a student with an invited email takes over that
  account, with its classes, the work the teacher uploaded and its feedback. A teacher who sees a wrong account
  can use reset-password (allowed while the student is in no other teacher's class) and give the temporary
  password to the real student.
- reset-password: only for students enrolled in that class (else `404`), **and** only when the calling teacher
  may manage that account: the teacher created it through Add students, **or** the student is not enrolled in
  any class owned by a different teacher. (A student who claimed an invited account by signing up has no creator:
  only the second rule applies.) Otherwise `403 { error: "This student is also enrolled in another
  teacher's class, so their password can't be reset here. Ask the student to change it on their Account page." }`
  and nothing changes. When allowed: sets a new temp password with `must_change_password = 1` and deletes that
  student's sessions. `StudentInfo.canResetPassword` reports the same rule for roster rows. For a **pending**
  student this is "create a temporary password": the account stops being pending (`pending = 0`) and the student
  signs in with the temporary password instead of signing up.

## Assignments — `server/src/routes/assignments.ts`

| Method & path | Who | Body | Response |
|---|---|---|---|
| `GET /api/classes/:classId/assignments` | teacher or student | – | `AssignmentSummary[]` sorted by `dueAt` ascending (teacher gets `counts`, student gets `mine`) |
| `GET /api/me/assignments` | signed in | – | `AssignmentSummary[]` across all of the user's classes, sorted by `dueAt` ascending |
| `POST /api/classes/:classId/assignments` | teacher | **multipart** (see `AssignmentFormFields` docs) | `AssignmentDetail` |
| `GET /api/assignments/:assignmentId` | teacher or student | – | `AssignmentDetail` |
| `PATCH /api/assignments/:assignmentId` | teacher | **multipart**, all fields optional | `AssignmentDetail` |
| `DELETE /api/assignments/:assignmentId` | teacher | – | `OkResponse` (also deletes stored files) |
| `POST /api/assignments/:assignmentId/regrade` | teacher | – | `RegradeResponse` (re-runs autograder on **every** submission) |
| `GET /api/assignments/:assignmentId/template/download` | teacher or student | – | file (404 if none) |
| `GET /api/assignments/:assignmentId/key/download` | teacher | – | file (404 if none) |
| `GET /api/assignments/:assignmentId/key/workbook` | teacher | – | `WorkbookData` of the answer key |
| `POST /api/grader/preview` | teacher | **multipart**: `keyFile`, `templateFile` (optional), `gradingConfig` (JSON string), `assignmentId` (optional), `ignoreStoredTemplate` (optional `'true'`) | `KeyPreview` |

Teacher `counts` (every `AssignmentSummary` a teacher receives, including the gradebook's): over the latest
submission of each enrolled student — `submitted` (has one), `late` (it is late), `needsGrading` (no final score),
`lateUngraded` (late **and** no final score).

Create/update rules

- Fields: `title` (required, 1–200), `description` (≤ 10 000), `dueAt` (required, valid ISO date),
  `points` (required, > 0, ≤ 10 000), `gradingMode` (`auto|manual`, default `auto` on create), `gradingConfig`
  (JSON; normalize with `normalizeGradingConfig`; invalid → `400 { fields: { gradingConfig } }` in either mode).
  `gradingConfig` is optional: omitted on create → `DEFAULT_GRADING_CONFIG`; omitted on update → the stored config
  is kept. The client omits it when saving a manual-grading assignment.
- `gradingMode = 'auto'` **requires an answer key** (`keyFile`): on create always; on update only if the assignment
  has no key yet. Missing → `400 { error: "Upload the finished workbook (answer key) to autograde, or choose manual grading.", fields: { keyFile } }`.
  If the key yields zero gradable cells for the config → `400 { fields: { keyFile } }` with an explanation.
- Switching to `manual` keeps the stored key (so the teacher can switch back) but stops autograding; existing
  submissions get `auto_status = 'not_applicable'`, `auto_score = NULL`, `auto_report = NULL`.
- Whenever the key file, template file, grading config, mode, or points change on an `auto` assignment,
  re-grade all submissions synchronously before responding.
- `removeTemplate = 'true'` deletes the template (update only).
- Students see `AssignmentDetail` without `key` and `gradingConfig`, with `studentVisibility` instead.

Preview rules (`POST /api/grader/preview`)

- Used live by the assignment form while the teacher picks a key/config; nothing is stored (discard temp uploads).
- `keyFile` is required **unless** `assignmentId` is given (an assignment the teacher owns that has a stored key),
  in which case the stored key is used. Likewise the stored template is used when `templateFile` is absent and
  `assignmentId` is given, unless `ignoreStoredTemplate = 'true'` (the teacher is removing it in the form).
- Invalid config → `400 { fields: { gradingConfig } }`; unreadable file → `400 { fields: { keyFile | templateFile } }`.

## Submissions — `server/src/routes/submissions.ts`

| Method & path | Who | Body | Response |
|---|---|---|---|
| `GET /api/assignments/:assignmentId/submissions` | teacher | – | `AssignmentSubmissionsResponse` (one row per enrolled student, sorted by name) |
| `GET /api/assignments/:assignmentId/students/:studentId/submissions` | teacher | – | `SubmissionDetail[]` (all attempts, newest first) |
| `GET /api/assignments/:assignmentId/my-submissions` | student | – | `SubmissionDetail[]` (all attempts, newest first) |
| `POST /api/assignments/:assignmentId/submissions` | student, or teacher on behalf | **multipart**: `file` (required); `studentId` (required when a teacher uploads) | `SubmissionDetail` |
| `GET /api/submissions/:submissionId` | teacher or owning student | – | `SubmissionDetail` |
| `PATCH /api/submissions/:submissionId/grade` | teacher | `GradeSubmissionRequest` | `SubmissionDetail` |
| `GET /api/submissions/:submissionId/download` | teacher or owning student | – | file |
| `GET /api/submissions/:submissionId/workbook` | teacher or owning student | – | `WorkbookData` |

- Submissions are **always accepted, even after the due date**. `late`/`lateBySeconds` are computed live from
  `submitted_at` vs the assignment's current `due_at` (so moving the due date updates the flag).
- Each upload is a new attempt (`attempt = previous max + 1`). The latest attempt is the one that counts.
- On upload for an `auto` assignment: grade immediately with `gradeWorkbook`, store `auto_status='graded'`,
  `auto_score = round2(points * report.fraction)`, `auto_report = JSON`. If grading throws, store
  `auto_status='error'` and `auto_error = message` (the submission is still saved and the teacher grades it).
- `PATCH .../grade`: `score` must be `null` or `0 ≤ score ≤ points * 2` (extra credit allowed); `feedback` ≤ 10 000
  chars and is stored **trimmed** (the response carries the trimmed text). Sets `graded_by`, `graded_at`; clearing
  both (`score: null` and empty feedback) resets them to `null`. Teachers may also grade autograded submissions (override).
- Students only see the report when `showDetailsToStudents`; when `showExpectedToStudents` is false, strip
  `expected`, `expectedFormula` and `expectedText` from every cell.
- Status rules (`TeacherRowStatus` for the latest submission): no submission → `missing`; `override_score` set →
  `graded`; `auto_status='graded'` → `autograded`; otherwise → `needs_grading`.
- `StudentAssignmentStatus`: no submission → `missing` if past due else `not_submitted`; final score present →
  `graded`; otherwise `submitted`.

## Gradebook — `server/src/routes/gradebook.ts`

| Method & path | Who | Response |
|---|---|---|
| `GET /api/classes/:classId/gradebook` | teacher | `GradebookResponse` (latest submission per student × assignment) |
| `GET /api/classes/:classId/gradebook.csv` | teacher | `text/csv` attachment (see below) |

- CSV columns: `Student`, `Email`, one column per assignment headed `<title> (<points>)`, then `Total` (sum of final
  scores, ungraded/missing count as 0). An assignment cell is the final score; `Ungraded` when submitted but not
  scored yet; a ` LATE` suffix when the latest submission is late (`18.26 LATE`, `Ungraded LATE`); blank when missing.

## Autograder rules — `server/src/grader/`

These are the grading semantics both the grader and the UI copy/README must describe consistently.

- **Numeric tolerance** is applied in the key cell's display units (see `GradingConfig.numericTolerance`): percent
  formats use `numericTolerance / 100`, time formats at most one second, everything else as is. Floating-point slack
  is ~1e-12 relative, so tolerance `0` means exact.
- **Formulas required**: a student formula with no cell/range reference, defined name or function call (`=2693.25`,
  `=3200+520`) is hard-coded → `formula_required`. Cells filled by array / dynamic-array (spill) formulas count as
  formula cells for key and submission.
- **Volatile functions**: key cells whose formula calls `TODAY`, `NOW`, `RAND`, `RANDBETWEEN` or `RANDARRAY` are not
  compared by value (the saved result depends on when/where it was calculated). They are correct when the student's
  cell has a formula calling the same volatile function(s). The key preview and the report carry a warning naming
  those cells.
- **Dates**: workbooks in the 1904 date system are converted so every value compares in the 1900 system.
- **Sheet pairing** uses only key sheets that have graded cells; after name matching, any unmatched graded key sheet
  takes the first unmatched student sheet in order (with a warning), so a one-sheet CSV pairs with the first graded
  key sheet.
- **Recalculation** happens for formulas saved without results, and for every formula when the workbook asks for a
  full recalculation on load (`fullCalcOnLoad`, written by XlsxWriter/pandas) and its cached formula results are all
  0/empty.
- **Size limits**: a workbook whose sheets are too big to read safely (more than ~2,000,000 filled cells, or worksheet
  XML far beyond that) is rejected as unreadable → `400 { error }` with a "too large" explanation. Recalculation work
  is bounded by the populated area, so a tiny file with `=SUM(A1:XFD1048576)` cannot exhaust memory.
- **Semicolon CSVs** (`sep=;` or `;` delimiter, as saved by European-locale Excel) read `,` as the decimal separator.
