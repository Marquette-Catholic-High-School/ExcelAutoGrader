/**
 * Shared API contract between the server (Express) and the client (React + Mantine).
 *
 * Every JSON request/response body in docs/API.md is described by a type in this file.
 * Import types with `import type`. The only runtime value is DEFAULT_GRADING_CONFIG.
 *   server: import type { User } from '../../shared/types.js'   (tsx maps .js -> .ts)
 *   client: import type { User } from '@shared/types'            (Vite + tsconfig alias)
 *
 * Conventions:
 * - All timestamps are ISO-8601 strings in UTC (e.g. "2026-10-16T21:00:00.000Z").
 * - All ids are integers.
 * - Scores are in assignment points (not percentages) and rounded to 2 decimals.
 */

export type Role = 'teacher' | 'student';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  /**
   * True for accounts created by a teacher (or reset by one) with a temporary password, until the student
   * changes it. The client keeps such users on /account until they choose a new password.
   */
  mustChangePassword: boolean;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: User;
  /**
   * Register only: present when the sign-up matched an account a teacher had already added by email (an invited
   * student). Lists the names of the classes the student is now in, so the app can welcome them.
   */
  claimedClasses?: string[];
}

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
  role: Role;
  /**
   * The join code of one of the student's classes. Needed (unless the server's REQUIRE_CODE_FOR_INVITES setting is
   * off) only when the email belongs to a student a teacher added who has not signed up yet; ignored otherwise.
   * Matched like JoinClassRequest.joinCode (any case, spaces and dashes ignored).
   */
  joinCode?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ApiError {
  error: string;
  /** Optional field-level messages, keyed by request field name. */
  fields?: Record<string, string>;
  /**
   * Optional machine-readable reason:
   * - `needs_signup`: login with an email a teacher added that has no account yet (the student should use "Create
   *   an account" with that email).
   * - `join_code_required`: register with such an email but without the code of one of the student's classes, or
   *   with a code that matches none of them (`fields.joinCode` says which).
   */
  code?: 'needs_signup' | 'join_code_required';
}

export interface OkResponse {
  ok: true;
}

/* ------------------------------------------------------------------ */
/* Classes & enrollment                                               */
/* ------------------------------------------------------------------ */

export interface ClassSummary {
  id: number;
  name: string;
  description: string;
  teacherId: number;
  teacherName: string;
  /** Only present for the owning teacher. Students join with this code. */
  joinCode?: string;
  studentCount: number;
  assignmentCount: number;
  createdAt: string;
}

export interface CreateClassRequest {
  name: string;
  description?: string;
}

export type UpdateClassRequest = Partial<CreateClassRequest>;

export interface JoinClassRequest {
  joinCode: string;
}

export interface StudentInfo {
  id: number;
  name: string;
  email: string;
  joinedAt: string;
  mustChangePassword: boolean;
  /**
   * True for a student a teacher added by email who has not signed up yet. The account exists (it can be enrolled,
   * graded and submitted for by the teacher) but has no password; the first sign-up with this email takes it over.
   */
  pending: boolean;
  /**
   * Roster responses only (GET /api/classes/:classId/students and AddStudentsResponse): whether the calling
   * teacher may reset this student's password (see the reset-password rule in docs/API.md). Omitted
   * elsewhere; clients treat a missing value as true and must still handle a 403 from reset-password.
   */
  canResetPassword?: boolean;
}

export interface AddStudentsRequest {
  /** `name` may be empty: a placeholder is made from the email and replaced by the student's own name at sign-up. */
  students: { name: string; email: string }[];
}

export interface AddedStudentResult {
  student: StudentInfo;
  /** True if a new (pending, invited) student account was created for this email. */
  created: boolean;
  /** Same as student.pending: the student has not signed up yet and will be matched by email when they do. */
  pending: boolean;
  /** No longer sent (accounts are invited, not given passwords). Kept for older clients; always absent. */
  tempPassword?: string;
  /** True if the student was already enrolled in this class (nothing changed). */
  alreadyEnrolled: boolean;
}

/** One data row of an uploaded class roster, as POST .../students/import-preview read it. */
export interface RosterPreviewRow {
  /** Row number in the file, as a spreadsheet program shows it (1-based, header row included). */
  line: number;
  name: string;
  email: string;
  /**
   * invite:  nobody has signed up with this email yet (no account, or one another teacher invited that is still
   *          pending); it will be added and matched when the student signs up
   * add:     an existing student account that has signed up; it is added to the class right away
   * already: already in this class (nothing to do)
   * error:   can't be added (see `error`)
   */
  status: 'invite' | 'add' | 'already' | 'error';
  error?: string;
}

export interface RosterPreview {
  fileName: string;
  rows: RosterPreviewRow[];
  /** Which columns were used, as shown to the teacher, e.g. { email: 'Email Address', name: 'First Name + Last Name' }. */
  columns: { email: string; name: string | null };
  /** Things worth knowing that didn't stop the import (skipped blank rows, duplicates merged, row limit, ...). */
  warnings: string[];
}

export interface AddStudentsResponse {
  added: AddedStudentResult[];
  /** Rows that could not be added (bad email, email belongs to a teacher, ...). */
  errors: { email: string; name: string; error: string }[];
}

export interface ResetPasswordResponse {
  tempPassword: string;
}

/* ------------------------------------------------------------------ */
/* Grading configuration                                              */
/* ------------------------------------------------------------------ */

export type GradingMode = 'auto' | 'manual';

/**
 * Which cells of the answer key are checked.
 * - 'all':      every non-empty cell in the answer key
 * - 'formulas': only cells that contain a formula in the answer key
 * - 'ranges':   only cells inside `ranges` (that are non-empty in the key)
 */
export type GradingScope = 'all' | 'formulas' | 'ranges';

export interface GradingConfig {
  scope: GradingScope;
  /** A1 ranges such as "Sheet1!B2:D10", "B2:B20" (first sheet) or "Totals!F5". Used when scope = 'ranges'. */
  ranges: string[];
  /**
   * Numbers within this absolute difference are considered equal (inclusive). Default 0.01.
   * The tolerance is applied in the units the key cell is displayed in:
   * - percent-formatted key cells (number format contains "%"): in percentage points, i.e. numericTolerance / 100
   *   as a fraction (0.01 → 31.80% matches 31.79%–31.81%, but not 31.9%);
   * - time-formatted key cells (date/time formats with hours, minutes or seconds): at most one second
   *   (min(numericTolerance, 1/86400) days);
   * - everything else (plain numbers, currency, whole-day dates): as is.
   * Only a negligible floating-point slack (about 1e-12 relative) is added, so 0 means "exactly equal".
   */
  numericTolerance: number;
  /** Compare text case-sensitively. Default false. */
  caseSensitive: boolean;
  /** Trim and collapse whitespace before comparing text. Default true. */
  ignoreWhitespace: boolean;
  /**
   * If the key cell has a formula, the student's cell must also contain a formula (no hard-coded answers).
   * Default true. A formula that references no cell, range, defined name or function (e.g. "=2693.25" or
   * "=3200+520") counts as hard-coded. Cells filled by an array or dynamic-array (spill) formula count as
   * formula cells, for both the key and the submission. Not enforced for key cells whose own formula is
   * constant-only.
   */
  requireFormulas: boolean;
  /**
   * When a starter template is attached, skip cells whose value in the key is identical to the template
   * (students should not get credit for content they were given). Default true. Ignored without a template.
   */
  excludeTemplateCells: boolean;
  /** Students can see the cell-by-cell report (which cells were right/wrong). Default true. */
  showDetailsToStudents: boolean;
  /** Students can see the expected values/formulas in the report. Default false. */
  showExpectedToStudents: boolean;
}

export const DEFAULT_GRADING_CONFIG: GradingConfig = {
  scope: 'all',
  ranges: [],
  numericTolerance: 0.01,
  caseSensitive: false,
  ignoreWhitespace: true,
  requireFormulas: true,
  excludeTemplateCells: true,
  showDetailsToStudents: true,
  showExpectedToStudents: false,
};

/** Response of POST /api/grader/preview: what the autograder would check for a given key + config. */
export interface KeyPreview {
  totalCells: number;
  formulaCells: number;
  sheets: { name: string; gradedCells: number; sampleAddresses: string[] }[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Assignments                                                        */
/* ------------------------------------------------------------------ */

export interface FileInfo {
  name: string;
  size: number;
}

/** Status of an assignment from a single student's point of view. */
export type StudentAssignmentStatus =
  | 'not_submitted' // nothing submitted, not yet due
  | 'missing' // nothing submitted and past due
  | 'submitted' // submitted, waiting for teacher (manual mode or autograde error)
  | 'graded'; // has a final score (autograded or teacher-graded)

export interface MySubmissionSummary {
  status: StudentAssignmentStatus;
  latestSubmissionId: number | null;
  submittedAt: string | null;
  late: boolean;
  attemptCount: number;
  finalScore: number | null;
}

export interface AssignmentSummary {
  id: number;
  classId: number;
  className: string;
  title: string;
  dueAt: string;
  points: number;
  gradingMode: GradingMode;
  createdAt: string;
  /** Teacher-only counts (omitted for students). */
  counts?: {
    students: number;
    submitted: number;
    /** Enrolled students whose latest submission is late (graded or not). */
    late: number;
    /** Latest submissions without a final score (manual mode or autograde errors). */
    needsGrading: number;
    /**
     * Late latest submissions that still have no final score (subset of both `late` and `needsGrading`).
     * Always sent by the current server; optional only for compatibility (clients fall back to `late`).
     */
    lateUngraded?: number;
  };
  /** Student-only (omitted for teachers). */
  mine?: MySubmissionSummary;
}

export interface AssignmentDetail extends AssignmentSummary {
  description: string;
  /** Visible to students too: the starter file they can download. */
  template: FileInfo | null;
  /** Teacher-only: the answer key ("finished document"). Students only learn whether one exists via gradingMode. */
  key?: FileInfo | null;
  /** Teacher-only full config. Students receive only the visibility flags. */
  gradingConfig?: GradingConfig;
  studentVisibility?: Pick<GradingConfig, 'showDetailsToStudents' | 'showExpectedToStudents'>;
}

/**
 * Create:  POST  /api/classes/:classId/assignments  (multipart/form-data)
 * Update:  PATCH /api/assignments/:id               (multipart/form-data, every field optional)
 *
 * Text fields: title, description, dueAt (ISO string), points (number as string),
 *              gradingMode ('auto' | 'manual'), gradingConfig (JSON string of GradingConfig),
 *              removeTemplate ('true' to delete the starter template, update only)
 * File fields: keyFile (required when creating with gradingMode='auto', or when switching an
 *              assignment without a key to 'auto'), templateFile (optional)
 */
export interface AssignmentFormFields {
  title: string;
  description: string;
  dueAt: string;
  points: number;
  gradingMode: GradingMode;
  gradingConfig: GradingConfig;
}

/* ------------------------------------------------------------------ */
/* Autograde report                                                   */
/* ------------------------------------------------------------------ */

export type CellPrimitive = string | number | boolean | null;

export type CellFailReason =
  | 'missing_sheet' // student workbook has no matching sheet
  | 'empty' // student cell is empty
  | 'value_mismatch' // value differs (beyond tolerance)
  | 'formula_required'; // value correct but hard-coded (typed value or constant-only formula) where the key uses a formula

export interface CellResult {
  sheet: string; // key sheet name
  address: string; // A1 address, e.g. "C7"
  correct: boolean;
  reason?: CellFailReason;
  /**
   * Raw values: numbers, text, booleans. Dates/times are Excel serial numbers in the 1900 date system and
   * percents are fractions (31.8% = 0.318). `expected`, `expectedFormula` and `expectedText` are stripped
   * for students when showExpectedToStudents is false.
   */
  expected?: CellPrimitive;
  expectedFormula?: string;
  /**
   * The key cell's value as Excel displays it (its number format applied), e.g. "31.8%", "10/16/2026",
   * "9:00", "$1,234.50". Only set for numeric values whose display text is known. Older stored reports
   * lack it, so clients fall back to formatting `expected`.
   */
  expectedText?: string;
  actual: CellPrimitive;
  actualFormula?: string;
  /** The student cell's value as displayed in their workbook; same rules as `expectedText`. */
  actualText?: string;
}

export interface SheetReport {
  keySheet: string;
  /** Name of the student sheet that was matched, or null if none. */
  studentSheet: string | null;
  correct: number;
  total: number;
  cells: CellResult[];
}

export interface GradeReport {
  correct: number;
  total: number;
  /** correct / total, 0..1 */
  fraction: number;
  sheets: SheetReport[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Submissions                                                        */
/* ------------------------------------------------------------------ */

export type AutoStatus = 'not_applicable' | 'graded' | 'error';

export interface SubmissionDetail {
  id: number;
  assignmentId: number;
  studentId: number;
  studentName: string;
  attempt: number; // 1-based attempt number for this student+assignment
  file: FileInfo;
  submittedAt: string;
  /** Name of who uploaded it (a teacher may upload on a student's behalf). */
  submittedByName: string;
  /** True when submittedAt is after the assignment's due date (computed live against the current due date). */
  late: boolean;
  /** Seconds after the due date (0 when not late). */
  lateBySeconds: number;
  pointsPossible: number;
  autoStatus: AutoStatus;
  /** Autograded score in points, or null. */
  autoScore: number | null;
  autoError: string | null;
  /** null when not graded automatically, or when a student is not allowed to see details. */
  report: GradeReport | null;
  /** Teacher-entered score; overrides autoScore when not null. */
  overrideScore: number | null;
  /** overrideScore ?? autoScore. */
  finalScore: number | null;
  feedback: string;
  gradedAt: string | null;
  gradedByName: string | null;
}

/** Teacher view of an assignment: one row per enrolled student. */
export type TeacherRowStatus =
  | 'missing' // no submission
  | 'needs_grading' // latest submission has no final score
  | 'autograded' // final score comes from the autograder
  | 'graded'; // teacher has set a score

export interface SubmissionRow {
  student: StudentInfo;
  status: TeacherRowStatus;
  attemptCount: number;
  latest: SubmissionDetail | null;
}

export interface AssignmentSubmissionsResponse {
  assignment: AssignmentDetail;
  rows: SubmissionRow[];
}

export interface GradeSubmissionRequest {
  /** null clears the override (falls back to the autograde score). */
  score: number | null;
  feedback: string;
}

export interface RegradeResponse {
  regraded: number;
  errors: number;
}

/* ------------------------------------------------------------------ */
/* Gradebook                                                          */
/* ------------------------------------------------------------------ */

export interface GradebookCell {
  submissionId: number | null;
  status: TeacherRowStatus;
  finalScore: number | null;
  late: boolean;
  submittedAt: string | null;
}

export interface GradebookResponse {
  assignments: AssignmentSummary[];
  students: StudentInfo[];
  /** cells[studentId][assignmentId] */
  cells: Record<string, Record<string, GradebookCell>>;
}

/* ------------------------------------------------------------------ */
/* Workbook viewer                                                    */
/* ------------------------------------------------------------------ */

/**
 * SheetJS-style cell type: n=number, s=string, b=boolean, e=error, d=date.
 * The server never emits 'd' (workbooks are read with cellDates=false); it stays in the union so clients
 * can handle it defensively.
 */
export type CellType = 'n' | 's' | 'b' | 'e' | 'd';

export interface ViewerCell {
  /**
   * Raw value. Dates and times arrive as Excel serial numbers with t = 'n' (display them via `w`); error
   * cells carry their text ("#DIV/0!") with t = 'e'.
   */
  v: CellPrimitive;
  t: CellType;
  /** Formatted text as Excel would display it (number format applied, e.g. "10/16/2026"), when available. */
  w?: string;
  /** Formula without the leading "=", e.g. "SUM(B2:B10)". */
  f?: string;
}

export interface ViewerSheet {
  name: string;
  /** Number of rows/columns in the rendered range (starting at A1). */
  rowCount: number;
  colCount: number;
  /** True if the sheet was larger than the viewer limit (1000 rows x 100 cols) and was cut off. */
  truncated: boolean;
  /** Sparse map keyed by A1 address ("B7"). */
  cells: Record<string, ViewerCell>;
  /** Merged ranges as A1 strings, e.g. "A1:C1". */
  merges: string[];
  /** Optional column widths in characters (index 0 = column A). */
  colWidths?: (number | null)[];
}

export interface WorkbookData {
  fileName: string;
  sheets: ViewerSheet[];
}
