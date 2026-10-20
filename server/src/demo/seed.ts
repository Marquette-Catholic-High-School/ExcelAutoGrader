/**
 * Demo data for `npm run seed`. Uses the db helpers, the services and the real grader directly (no HTTP), so
 * the stored reports are exactly what an upload through the app would produce. Import only from seed.ts,
 * which checks the environment first: importing this module opens the database in DATA_DIR.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GradingConfig, GradingMode } from '../../../shared/types.js';
import { hashPassword } from '../auth.js';
import {
  UPLOAD_DIR,
  db,
  get,
  run,
  transaction,
  type AssignmentRow,
  type FileRow,
  type SubmissionRow,
  type UserRow,
} from '../db.js';
import {
  MONTHLY_BUDGET,
  MONTHLY_BUDGET_VARIANTS,
  monthlyBudgetKey,
  monthlyBudgetSubmission,
  monthlyBudgetTemplate,
  type MonthlyBudgetVariant,
} from '../grader/fixtures.js';
import { normalizeGradingConfig, previewKey } from '../grader/index.js';
import { addStudents, createClass, enroll, resetStudentPassword } from '../services/classes.js';
import { autoGrade } from '../services/grading.js';
import { filePath } from '../uploads.js';
import {
  GRADE_CALCULATOR,
  PRICE_LIST,
  SALES_REPORT,
  gradeCalculatorKey,
  gradeCalculatorSubmission,
  gradeCalculatorTemplate,
  priceListKey,
  priceListSubmission,
  priceListTemplate,
  salesReportWorkbook,
} from './workbooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = path.resolve(here, '../../../samples');

export const DEMO_PASSWORD = 'password123';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

let print: (line: string) => void = (line) => console.log(line);
const log = (line = '') => print(line);
const step = (text: string) => log(`\n• ${text}`);

function when(date: Date | string): string {
  return new Date(date).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function relativeTo(dueAt: string, submittedAt: string): string {
  const late = Date.parse(submittedAt) - Date.parse(dueAt);
  if (late <= 0) return 'on time';
  const days = Math.floor(late / DAY);
  const hours = Math.floor((late % DAY) / HOUR);
  return days > 0 ? `LATE by ${days}d ${hours}h` : `LATE by ${hours}h`;
}

/* ------------------------------------------------------------------ */
/* Dates (local time, like a teacher picking them in the app)         */
/* ------------------------------------------------------------------ */

/** Today (local) + `days`, at hh:mm local time. */
function onDay(days: number, hours: number, minutes = 0): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

const shift = (date: Date, ms: number) => new Date(date.getTime() + ms);
const iso = (date: Date) => date.toISOString();

/* ------------------------------------------------------------------ */
/* Reset                                                              */
/* ------------------------------------------------------------------ */

/** Children before parents, so foreign keys never block a delete. */
const TABLES = ['sessions', 'submissions', 'enrollments', 'assignments', 'classes', 'files', 'users'];

/**
 * Empties every table (and the id counters) instead of deleting the database file, so an app that is already
 * running keeps working and simply sees the fresh data. Then removes every uploaded file.
 */
function resetData(): void {
  step('Resetting the database and removing uploaded files');
  transaction(() => {
    for (const table of TABLES) run(`DELETE FROM ${table}`);
    run('DELETE FROM sqlite_sequence');
  });
  db.exec('VACUUM');
  const uploads = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : [];
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  log(`  Emptied ${TABLES.length} tables and removed ${uploads.length} uploaded file(s).`);
}

/* ------------------------------------------------------------------ */
/* Builders                                                           */
/* ------------------------------------------------------------------ */

function createUser(name: string, email: string, role: UserRow['role'], createdAt: Date): UserRow {
  const { lastInsertRowid } = run(
    `INSERT INTO users (email, name, password_hash, role, must_change_password, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    email,
    name,
    hashPassword(DEMO_PASSWORD),
    role,
    iso(createdAt),
  );
  return get<UserRow>('SELECT * FROM users WHERE id = ?', lastInsertRowid)!;
}

function createDemoClass(teacher: UserRow, name: string, description: string, createdAt: Date) {
  const id = createClass(teacher.id, name, description);
  run('UPDATE classes SET created_at = ? WHERE id = ?', iso(createdAt), id);
  const joinCode = get<{ join_code: string }>('SELECT join_code FROM classes WHERE id = ?', id)!.join_code;
  return { id, name, joinCode };
}

function enrollAt(classId: number, students: UserRow[], joinedAt: Date): void {
  for (const student of students) {
    enroll(classId, student.id);
    const sql = 'UPDATE enrollments SET joined_at = ? WHERE class_id = ? AND student_id = ?';
    run(sql, iso(joinedAt), classId, student.id);
  }
}

/** Writes the bytes into the uploads folder and records them, like an upload through the app. */
function storeFile(bytes: Buffer, originalName: string, uploadedBy: UserRow, createdAt: Date): FileRow {
  const storedName = `${crypto.randomUUID()}${path.extname(originalName).toLowerCase()}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), bytes);
  const { lastInsertRowid } = run(
    'INSERT INTO files (original_name, stored_name, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?)',
    originalName,
    storedName,
    bytes.length,
    uploadedBy.id,
    iso(createdAt),
  );
  return get<FileRow>('SELECT * FROM files WHERE id = ?', lastInsertRowid)!;
}

interface AssignmentSpec {
  classId: number;
  teacher: UserRow;
  title: string;
  description: string;
  dueAt: Date;
  points: number;
  mode: GradingMode;
  config?: Partial<GradingConfig>;
  key?: { bytes: Buffer; name: string };
  template?: { bytes: Buffer; name: string };
  createdAt: Date;
}

function createAssignment(spec: AssignmentSpec): AssignmentRow {
  const config = normalizeGradingConfig(spec.config ?? {});
  const key = spec.key && storeFile(spec.key.bytes, spec.key.name, spec.teacher, spec.createdAt);
  const template = spec.template && storeFile(spec.template.bytes, spec.template.name, spec.teacher, spec.createdAt);
  const { lastInsertRowid } = run(
    `INSERT INTO assignments (class_id, title, description, due_at, points, grading_mode, grading_config,
       key_file_id, template_file_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    spec.classId,
    spec.title,
    spec.description,
    iso(spec.dueAt),
    spec.points,
    spec.mode,
    JSON.stringify(config),
    key?.id ?? null,
    template?.id ?? null,
    iso(spec.createdAt),
  );
  const assignment = get<AssignmentRow>('SELECT * FROM assignments WHERE id = ?', lastInsertRowid)!;

  let grading = 'graded manually (no answer key)';
  if (spec.mode === 'auto') {
    if (!key) throw new Error(`"${spec.title}" is autograded but has no answer key.`);
    const preview = previewKey({ keyPath: filePath(key), templatePath: template ? filePath(template) : null, config });
    if (preview.totalCells === 0) throw new Error(`The answer key of "${spec.title}" has nothing to grade.`);
    grading = `autograded, ${preview.totalCells} cells checked`;
  }
  log(`  ${spec.title}: ${spec.points} pts, ${grading}, due ${when(spec.dueAt)}`);
  return assignment;
}

interface SubmissionSpec {
  assignment: AssignmentRow;
  student: UserRow;
  bytes: Buffer;
  fileName: string;
  submittedAt: Date;
  /** A teacher uploading on the student's behalf (default: the student). */
  uploadedBy?: UserRow;
}

/** A new attempt, autograded with the real grader when the assignment is autograded. */
function submit(spec: SubmissionSpec): SubmissionRow {
  const { assignment, student } = spec;
  const uploader = spec.uploadedBy ?? student;
  const file = storeFile(spec.bytes, spec.fileName, uploader, spec.submittedAt);
  const result = autoGrade(assignment, filePath(file));
  if (assignment.grading_mode === 'auto' && result.auto_status !== 'graded') {
    throw new Error(`Autograding ${student.name}'s "${spec.fileName}" failed: ${result.auto_error}`);
  }
  const { next } = get<{ next: number }>(
    'SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM submissions WHERE assignment_id = ? AND student_id = ?',
    assignment.id,
    student.id,
  )!;
  const { lastInsertRowid } = run(
    `INSERT INTO submissions (assignment_id, student_id, file_id, attempt, submitted_at, submitted_by,
       auto_status, auto_score, auto_report, auto_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    assignment.id,
    student.id,
    file.id,
    next,
    iso(spec.submittedAt),
    uploader.id,
    result.auto_status,
    result.auto_score,
    result.auto_report,
    result.auto_error,
  );
  const row = get<SubmissionRow>('SELECT * FROM submissions WHERE id = ?', lastInsertRowid)!;
  const score = row.auto_score === null ? 'waiting for the teacher' : `${row.auto_score} / ${assignment.points}`;
  const timing = relativeTo(assignment.due_at, row.submitted_at);
  const by = uploader === student ? '' : `  (uploaded by ${uploader.name})`;
  log(`    ${student.name.padEnd(15)} attempt ${row.attempt}  ${timing.padEnd(16)} ${score}${by}`);
  return row;
}

/** What PATCH /api/submissions/:id/grade does: optional score override plus feedback. */
function teacherGrade(submission: SubmissionRow, teacher: UserRow, score: number | null, feedback: string, at: Date) {
  run(
    'UPDATE submissions SET override_score = ?, feedback = ?, graded_by = ?, graded_at = ? WHERE id = ?',
    score,
    feedback,
    teacher.id,
    iso(at),
    submission.id,
  );
}

/* ------------------------------------------------------------------ */
/* Demo content                                                       */
/* ------------------------------------------------------------------ */

const budgetFile = (variant: MonthlyBudgetVariant) => ({
  bytes: monthlyBudgetSubmission(variant),
  fileName: MONTHLY_BUDGET_VARIANTS[variant].fileName,
});

export interface DemoAccount {
  name: string;
  email: string;
  role: UserRow['role'];
  password: string;
  note: string;
}

export interface SeedResult {
  accounts: DemoAccount[];
  joinCodes: { name: string; joinCode: string }[];
}

/** Resets DATA_DIR and fills it with the demo. `quiet` turns off the progress output (tests). */
export async function seedDemoData(options: { quiet?: boolean } = {}): Promise<SeedResult> {
  print = options.quiet ? () => {} : (line) => console.log(line);
  resetData();

  step('Creating accounts');
  const teacher = createUser('Ms. Rivera', 'teacher@demo.test', 'teacher', onDay(-60, 9));
  const [ava, ben, chloe, diego, emma] = [
    ['Ava Thompson', 'ava@demo.test'],
    ['Ben Carter', 'ben@demo.test'],
    ['Chloe Nguyen', 'chloe@demo.test'],
    ['Diego Ramirez', 'diego@demo.test'],
    ['Emma Wilson', 'emma@demo.test'],
  ].map(([name, email]) => createUser(name, email, 'student', onDay(-45, 10)));
  log(`  ${teacher.name} and 5 students, all with the password "${DEMO_PASSWORD}"`);

  step('Class "Business Computing 101"');
  const bc101 = createDemoClass(
    teacher,
    'Business Computing 101',
    'Hands-on Excel for business: budgets, sales reports and grade books. Every assignment is a workbook.',
    onDay(-28, 8),
  );
  enrollAt(bc101.id, [ava, ben, chloe, diego, emma], onDay(-27, 12));
  // Finn and Grace are added the way a teacher adds students in the app: by email, which makes accounts that wait
  // for the student to sign up. The teacher then created a temporary password for Finn; Grace hasn't signed up yet.
  const { added } = addStudents(bc101.id, [
    { name: 'Finn Murphy', email: 'finn@demo.test' },
    { name: 'Grace Lee', email: 'grace@demo.test' },
  ]);
  const [finn, grace] = ['finn@demo.test', 'grace@demo.test'].map((email) => {
    const id = added.find((a) => a.student.email === email && a.created && a.pending)?.student.id;
    if (!id) throw new Error(`${email} should have been added as a new student who hasn't signed up.`);
    return get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
  });
  const addedAt = onDay(-20, 9);
  for (const student of [finn, grace]) run('UPDATE users SET created_at = ? WHERE id = ?', iso(addedAt), student.id);
  enrollAt(bc101.id, [finn, grace], addedAt);
  const finnPassword = resetStudentPassword(finn.id);
  log(`  Join code ${bc101.joinCode}; students: Ava, Ben, Chloe, Diego, Emma, and Finn and Grace (added by email)`);

  const budgetDue = onDay(-3, 23, 59);
  const budget = createAssignment({
    classId: bc101.id,
    teacher,
    title: MONTHLY_BUDGET.title,
    description: MONTHLY_BUDGET.description,
    dueAt: budgetDue,
    points: 20,
    mode: 'auto',
    key: { bytes: monthlyBudgetKey(), name: MONTHLY_BUDGET.keyFileName },
    template: { bytes: monthlyBudgetTemplate(), name: MONTHLY_BUDGET.templateFileName },
    createdAt: onDay(-14, 7, 30),
  });
  const budgetAttempt = (student: UserRow, variant: MonthlyBudgetVariant, offsetFromDue: number) =>
    submit({ assignment: budget, student, ...budgetFile(variant), submittedAt: shift(budgetDue, offsetFromDue) });
  budgetAttempt(ava, 'perfect', -2 * DAY - 5 * HOUR);
  const benBudget = budgetAttempt(ben, 'partial', -6 * HOUR);
  budgetAttempt(chloe, 'hardcoded', -47 * MINUTE);
  // Diego's first, unfinished attempt was on time; the much better second one came in a day late.
  budgetAttempt(diego, 'incomplete', -5 * HOUR);
  budgetAttempt(diego, 'mostly', DAY + 2 * HOUR + 14 * MINUTE);
  // Grace handed in her workbook on a USB stick before the deadline; the teacher uploaded it for her.
  submit({
    assignment: budget,
    student: grace,
    bytes: monthlyBudgetSubmission('mostly'),
    fileName: 'Monthly Budget - Grace Lee.xlsx',
    submittedAt: shift(budgetDue, -DAY - 3 * HOUR),
    uploadedBy: teacher,
  });
  teacherGrade(
    benBudget,
    teacher,
    null,
    'Good start, Ben. Three things to fix: the Freelance difference (D6) should be Actual minus Budgeted, ' +
      'your Total Expenses SUM in C16 stops before Savings, and % of Income in E12 should divide by Total ' +
      'Income ($C$7). The budgeted Net in B18 is still empty.',
    shift(budgetDue, DAY + 9 * HOUR),
  );
  log("    Emma and Finn have not submitted (missing). Ben has teacher feedback. Grace's work was uploaded for her.");

  const salesDue = onDay(5, 23, 59);
  const sales = createAssignment({
    classId: bc101.id,
    teacher,
    ...SALES_REPORT,
    dueAt: salesDue,
    points: 50,
    mode: 'manual',
    createdAt: onDay(-5, 8),
  });
  submit({
    assignment: sales,
    student: ava,
    bytes: salesReportWorkbook('polished', ava.name),
    fileName: 'Q3 Sales Report - Ava Thompson.xlsx',
    submittedAt: onDay(-1, 16, 20),
  });
  const benSales = submit({
    assignment: sales,
    student: ben,
    bytes: salesReportWorkbook('unformatted', ben.name),
    fileName: 'Ben Carter Q3 report.xlsx',
    submittedAt: onDay(-2, 21, 5),
  });
  teacherGrade(
    benSales,
    teacher,
    42,
    'Clear layout and every total is correct. Points off because the Share of Sales column is not formatted ' +
      'as percentages, and the report never names the top region (East). Add both and this is ready to share.',
    onDay(-1, 8, 40),
  );
  log('    Ben graded 42 / 50 with feedback; Ava needs grading.');

  createAssignment({
    classId: bc101.id,
    teacher,
    ...GRADE_CALCULATOR,
    dueAt: onDay(10, 23, 59),
    points: 10,
    mode: 'auto',
    key: { bytes: gradeCalculatorKey(), name: 'Grade Calculator - Answer Key.xlsx' },
    template: { bytes: gradeCalculatorTemplate(), name: 'Grade Calculator - Starter.xlsx' },
    createdAt: onDay(-1, 7, 50),
  });
  log('    No submissions yet.');

  step('Class "Spreadsheet Skills"');
  const skills = createDemoClass(
    teacher,
    'Spreadsheet Skills',
    'Short warm-up exercises on formulas, cell references and formatting.',
    onDay(-42, 8),
  );
  enrollAt(skills.id, [ava, emma], onDay(-41, 13));
  log(`  Join code ${skills.joinCode}; students: Ava, Emma`);
  const warmUp = createAssignment({
    classId: skills.id,
    teacher,
    ...PRICE_LIST,
    dueAt: onDay(2, 23, 59),
    points: 10,
    mode: 'auto',
    config: { scope: 'formulas', showExpectedToStudents: true },
    key: { bytes: priceListKey(), name: 'Price List - Answer Key.xlsx' },
    template: { bytes: priceListTemplate(), name: 'Price List - Starter.xlsx' },
    createdAt: onDay(-6, 8, 15),
  });
  submit({
    assignment: warmUp,
    student: emma,
    bytes: priceListSubmission(),
    fileName: 'Price List - Emma.xlsx',
    submittedAt: onDay(-1, 19, 42),
  });

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const students: DemoAccount[] = [ava, ben, chloe, diego, emma].map((s) => ({
    name: s.name,
    email: s.email,
    role: 'student',
    password: DEMO_PASSWORD,
    note: s === ava || s === emma ? 'Also in Spreadsheet Skills' : '',
  }));
  return {
    accounts: [
      { name: teacher.name, email: teacher.email, role: 'teacher', password: DEMO_PASSWORD, note: 'Owns both classes' },
      ...students,
      {
        name: finn.name,
        email: finn.email,
        role: 'student',
        password: finnPassword,
        note: 'Temporary password; must choose a new one at sign-in',
      },
      {
        name: grace.name,
        email: grace.email,
        role: 'student',
        password: '(none yet)',
        note: `Added by email, has not signed up: "Create an account" with this email and code ${bc101.joinCode}`,
      },
    ],
    joinCodes: [bc101, skills].map(({ name, joinCode }) => ({ name, joinCode })),
  };
}

/* ------------------------------------------------------------------ */
/* Sample files for trying uploads by hand                            */
/* ------------------------------------------------------------------ */

/**
 * A class roster for trying a roster upload. In Business Computing 101, Ava is already in the class, the others are
 * new (Leo has no name, so the app makes one from his email). @demo.test emails count as demo accounts for the seed.
 */
export const CLASS_ROSTER_CSV = [
  'First Name,Last Name,Email',
  'Hana,Kim,hana.kim@demo.test',
  'Isaac,Okafor,isaac.okafor@demo.test',
  'Julia,Rossi,julia.rossi@demo.test',
  ',,leo.martin@demo.test',
  'Ava,Thompson,ava@demo.test',
  '',
].join('\n');

export function writeSamples(): void {
  step(`Writing sample files to ${SAMPLES_DIR}`);
  const files: [string, Buffer][] = [
    ['monthly-budget-KEY.xlsx', monthlyBudgetKey()],
    ['monthly-budget-starter.xlsx', monthlyBudgetTemplate()],
    ['monthly-budget-student-perfect.xlsx', monthlyBudgetSubmission('perfect')],
    ['monthly-budget-student-mistakes.xlsx', monthlyBudgetSubmission('partial')],
    ['monthly-budget-student-hardcoded.xlsx', monthlyBudgetSubmission('hardcoded')],
    ['monthly-budget-student-renamed-sheet.xlsx', monthlyBudgetSubmission('renamed')],
    ['grade-calculator-KEY.xlsx', gradeCalculatorKey()],
    ['grade-calculator-starter.xlsx', gradeCalculatorTemplate()],
    ['grade-calculator-student.xlsx', gradeCalculatorSubmission()],
    ['sales-report-student.xlsx', salesReportWorkbook('polished', 'Sample Student')],
    ['class-roster.csv', Buffer.from(CLASS_ROSTER_CSV, 'utf8')],
  ];
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  for (const [name, bytes] of files) fs.writeFileSync(path.join(SAMPLES_DIR, name), bytes);
  log(`  ${files.length} files (see samples/README.md for what each one shows).`);
}
