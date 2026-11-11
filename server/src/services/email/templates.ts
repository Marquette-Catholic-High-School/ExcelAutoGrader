/**
 * Email content. Each email is a list of blocks rendered twice, as simple inline-styled HTML that reads well on
 * phones and as plain text, so both parts always say the same thing. All user content (names, titles, file names)
 * goes through escapeHtml when rendered to HTML; subjects are cleaned for headers by the mailer.
 */
import type { AutoStatus } from '../../../../shared/types.js';
import { emailConfig, link, timeZone } from './config.js';
import { escapeHtml, formatDate, formatDateTime, formatDuration, formatScoreOf } from './format.js';
import type { MailContent } from './mailer.js';

/* ------------------------------------------------------------------ */
/* Blocks                                                             */
/* ------------------------------------------------------------------ */

export type Inline = string | { bold: string } | { href: string; label: string };

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'subheading'; text: string }
  | { kind: 'paragraph'; parts: Inline[] }
  | { kind: 'alert'; text: string }
  | { kind: 'details'; rows: [label: string, value: string][] }
  | { kind: 'button'; href: string; label: string }
  | { kind: 'list'; items: Inline[][] }
  | { kind: 'steps'; title: string; items: Inline[][] }
  | { kind: 'table'; head: string[]; rows: string[][] };

const FONT = 'font-family:Arial,Helvetica,sans-serif;';
const INK = '#1f2933';
const MUTED = '#52606d';
const BRAND = '#1e7145';

function inlineHtml(parts: Inline[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return escapeHtml(part);
      if ('bold' in part) return `<strong>${escapeHtml(part.bold)}</strong>`;
      return `<a href="${escapeHtml(part.href)}" style="color:${BRAND};">${escapeHtml(part.label)}</a>`;
    })
    .join('');
}

function inlineText(parts: Inline[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if ('bold' in part) return part.bold;
      return part.label === part.href ? part.href : `${part.label} (${part.href})`;
    })
    .join('');
}

const CELL = `padding:6px 8px;border-bottom:1px solid #e4e7eb;vertical-align:top;text-align:left;`;
const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0"';

function listItems(items: Inline[][]): string {
  return items.map((item) => `<li style="margin:0 0 4px;">${inlineHtml(item)}</li>`).join('');
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return `<h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;color:${INK};">${escapeHtml(block.text)}</h1>`;
    case 'subheading':
      return `<h2 style="margin:22px 0 8px;font-size:16px;line-height:1.3;">${escapeHtml(block.text)}</h2>`;
    case 'paragraph':
      return `<p style="margin:0 0 12px;">${inlineHtml(block.parts)}</p>`;
    case 'alert':
      return (
        `<p style="margin:0 0 12px;padding:10px 12px;background:#fff4e5;border-left:4px solid #d9822b;` +
        `color:#7a4510;font-weight:bold;">${escapeHtml(block.text)}</p>`
      );
    case 'details': {
      const rows = block.rows
        .map(
          ([label, value]) =>
            `<tr><td style="${CELL}color:${MUTED};width:38%;">${escapeHtml(label)}</td>` +
            `<td style="${CELL}color:${INK};">${escapeHtml(value)}</td></tr>`,
        )
        .join('');
      return `<table ${TABLE} style="border-collapse:collapse;margin:0 0 16px;font-size:15px;">${rows}</table>`;
    }
    case 'button':
      return (
        `<p style="margin:18px 0;"><a href="${escapeHtml(block.href)}" style="display:inline-block;` +
        `background:${BRAND};color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 20px;` +
        `border-radius:6px;">${escapeHtml(block.label)}</a></p>`
      );
    case 'list':
      return `<ul style="margin:0 0 12px;padding-left:22px;">${listItems(block.items)}</ul>`;
    case 'steps':
      return (
        `<p style="margin:16px 0 6px;font-weight:bold;">${escapeHtml(block.title)}</p>` +
        `<ol style="margin:0 0 12px;padding-left:22px;">${listItems(block.items)}</ol>`
      );
    case 'table': {
      const head = block.head.map((h) => `<th style="${CELL}background:#f0f4f8;color:${MUTED};">${escapeHtml(h)}</th>`);
      const rows = block.rows.map(
        (r) => `<tr>${r.map((c) => `<td style="${CELL}">${escapeHtml(c)}</td>`).join('')}</tr>`,
      );
      return (
        `<table ${TABLE} style="border-collapse:collapse;margin:0 0 12px;font-size:14px;">` +
        `<tr>${head.join('')}</tr>${rows.join('')}</table>`
      );
    }
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return block.text;
    case 'subheading':
      return `${block.text}\n${'-'.repeat(Math.min(block.text.length, 60))}`;
    case 'paragraph':
      return inlineText(block.parts);
    case 'alert':
      return `** ${block.text} **`;
    case 'details':
      return block.rows.map(([label, value]) => `${label}: ${value}`).join('\n');
    case 'button':
      return `${block.label}: ${block.href}`;
    case 'list':
      return block.items.map((item) => `- ${inlineText(item)}`).join('\n');
    case 'steps':
      return [block.title, ...block.items.map((item, i) => `${i + 1}. ${inlineText(item)}`)].join('\n');
    case 'table':
      return block.rows.map((row) => `- ${row.filter(Boolean).join(' · ')}`).join('\n');
  }
}

export interface EmailParts {
  subject: string;
  /** Preview line shown by mail apps next to the subject. */
  preheader: string;
  blocks: Block[];
  /** Why the email was sent (and how to turn it off). */
  footer: Inline[][];
}

export function renderEmail({ subject, preheader, blocks, footer }: EmailParts): MailContent {
  const brand = emailConfig().fromName;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;">
<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>
<table ${TABLE} style="background:#f4f6f8;">
<tr><td align="center" style="padding:20px 10px;">
<table ${TABLE} style="max-width:600px;background:#ffffff;border:1px solid #e4e7eb;border-radius:8px;">
<tr><td style="padding:18px 22px 0;${FONT}font-size:14px;font-weight:bold;color:${BRAND};">
${escapeHtml(brand)}
</td></tr>
<tr><td style="padding:10px 22px 14px;${FONT}font-size:16px;line-height:1.5;color:${INK};">
${blocks.map(blockHtml).join('\n')}
</td></tr>
</table>
<table ${TABLE} style="max-width:600px;">
<tr><td style="padding:12px 22px;${FONT}font-size:12px;line-height:1.5;color:#7b8794;">
${footer.map((line) => `<p style="margin:0 0 6px;">${inlineHtml(line)}</p>`).join('\n')}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  const text = `${brand}\n\n${blocks.map(blockText).join('\n\n')}\n\n--\n${footer.map(inlineText).join('\n')}\n`;
  return { subject, html, text };
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                      */
/* ------------------------------------------------------------------ */

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export interface StudentRecipient {
  name: string;
  email: string;
  /** Invited by a teacher, not signed up yet: the email includes sign-up steps. */
  pending: boolean;
  /** The class code to give at sign-up, or null when REQUIRE_CODE_FOR_INVITES is off. */
  joinCode: string | null;
  /** Stops all email to this address, without signing in. */
  unsubscribeUrl: string;
}

function signUpSteps(student: StudentRecipient): Block {
  const items: Inline[][] = [
    ['Go to ', { href: link('/register?role=student'), label: link('/register?role=student') }],
    ['Choose Student and sign up with this email address: ', { bold: student.email }],
  ];
  if (student.joinCode) items.push(['When asked for the class code, enter ', { bold: student.joinCode }, '.']);
  items.push(['After that, sign in any time to see your work, scores and feedback.']);
  return { kind: 'steps', title: "You haven't created your account yet. To see your work online:", items };
}

function studentOptOut(student: StudentRecipient): Inline[] {
  if (student.pending) {
    return [
      "Didn't expect this email? ",
      { href: student.unsubscribeUrl, label: 'Unsubscribe' },
      ' to stop all emails to this address. After you sign up, you can also turn them off on your Account page.',
    ];
  }
  const account: Inline = { href: link('/account'), label: 'Account page' };
  const unsubscribe: Inline = { href: student.unsubscribeUrl, label: 'unsubscribe' };
  return ['You can turn these emails off on your ', account, ', or ', unsubscribe, '.'];
}

function assignmentButton(student: StudentRecipient, assignmentId: number): Block[] {
  if (student.pending) return [signUpSteps(student)];
  return [{ kind: 'button', href: link(`/student/assignments/${assignmentId}`), label: 'Open the assignment' }];
}

/* ------------------------------------------------------------------ */
/* Receipt                                                            */
/* ------------------------------------------------------------------ */

export interface ReceiptData {
  student: StudentRecipient;
  assignmentId: number;
  assignmentTitle: string;
  className: string;
  attempt: number;
  submittedAt: string;
  lateBySeconds: number;
  /** null when the student uploaded it themself. */
  uploadedByTeacher: string | null;
  fileName: string;
  autoStatus: AutoStatus;
  autoScore: number | null;
  points: number;
}

export function receiptEmail(d: ReceiptData): MailContent {
  const zone = timeZone();
  const late = d.lateBySeconds > 0;
  const score =
    d.autoStatus === 'graded' && d.autoScore !== null
      ? formatScoreOf(d.autoScore, d.points)
      : 'Your teacher will grade this file.';
  const hi = `Hi ${firstName(d.student.name)}, `;
  const title = { bold: d.assignmentTitle };
  const intro: Inline[] = d.uploadedByTeacher
    ? [`${hi}your teacher ${d.uploadedByTeacher} uploaded a file for `, title, ` in ${d.className} for you.`]
    : [`${hi}we received your work for `, title, ` in ${d.className}.`];
  const blocks: Block[] = [
    { kind: 'heading', text: late ? 'Your work was received (late)' : 'Your work was received' },
    { kind: 'paragraph', parts: intro },
  ];
  const howLate = formatDuration(d.lateBySeconds);
  if (late) blocks.push({ kind: 'alert', text: `LATE: submitted ${howLate} after the due date.` });
  blocks.push(
    {
      kind: 'details',
      rows: [
        ['Assignment', d.assignmentTitle],
        ['Class', d.className],
        ['Attempt', `#${d.attempt}`],
        ['Submitted', formatDateTime(d.submittedAt, zone)],
        ['On time?', late ? `LATE (${howLate} late)` : 'Yes'],
        ['Uploaded by', d.uploadedByTeacher ? `${d.uploadedByTeacher} (teacher)` : 'You'],
        ['File', d.fileName],
        [d.autoStatus === 'graded' ? 'Autograde score' : 'Score', score],
      ],
    },
    ...assignmentButton(d.student, d.assignmentId),
  );
  if (d.autoStatus === 'graded') {
    blocks.push({ kind: 'paragraph', parts: ['Your teacher may still change the score or add feedback.'] });
  }
  return renderEmail({
    subject: `${late ? 'Received (late)' : 'Received'}: ${d.assignmentTitle} — ${d.className}`,
    preheader: `Attempt #${d.attempt} for ${d.assignmentTitle} was received${late ? ' (late)' : ''}.`,
    blocks,
    footer: [
      [
        "You're getting this email because ",
        d.uploadedByTeacher ? 'work was turned in for you' : 'you turned in work',
        ` in ${d.className} on ${emailConfig().fromName}.`,
      ],
      studentOptOut(d.student),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Overdue reminder                                                   */
/* ------------------------------------------------------------------ */

export interface ReminderData {
  student: StudentRecipient;
  assignmentId: number;
  assignmentTitle: string;
  className: string;
  teacherName: string;
  dueAt: string;
  overdueSeconds: number;
  reminderNumber: number;
  maxReminders: number;
}

export function overdueEmail(d: ReminderData): MailContent {
  const due = formatDateTime(d.dueAt, timeZone());
  const overdue = formatDuration(d.overdueSeconds);
  return renderEmail({
    subject: `Reminder: ${d.assignmentTitle} is overdue — ${d.className}`,
    preheader: `${d.assignmentTitle} was due ${due}. Late work is still accepted.`,
    blocks: [
      { kind: 'heading', text: `${d.assignmentTitle} is overdue` },
      {
        kind: 'paragraph',
        parts: [
          `Hi ${firstName(d.student.name)}, `,
          { bold: d.assignmentTitle },
          ` for ${d.className} was due ${due} (${overdue} ago), and nothing has been turned in yet.`,
        ],
      },
      { kind: 'paragraph', parts: [{ bold: 'Late work is still accepted' }, ', so you can still turn it in.'] },
      {
        kind: 'details',
        rows: [
          ['Assignment', d.assignmentTitle],
          ['Class', d.className],
          ['Teacher', d.teacherName],
          ['Was due', due],
          ['Overdue by', overdue],
        ],
      },
      ...assignmentButton(d.student, d.assignmentId),
    ],
    footer: [
      [
        `You're getting this reminder because ${d.className} has overdue reminders turned on and this assignment ` +
          `hasn't been turned in (reminder ${d.reminderNumber} of at most ${d.maxReminders}). ` +
          'They stop as soon as you turn it in.',
      ],
      studentOptOut(d.student),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Daily report                                                       */
/* ------------------------------------------------------------------ */

export interface ReportSubmission {
  studentName: string;
  assignmentTitle: string;
  submittedAt: string;
  attempt: number;
  /** Final score, or null when not graded yet. */
  score: number | null;
  points: number;
  late: boolean;
  autoError: boolean;
}

export interface ClassReport {
  classId: number;
  className: string;
  submissions: ReportSubmission[];
  /** Submissions in the window beyond the ones listed. */
  moreSubmissions: number;
  needsGrading: { assignmentId: number; title: string; count: number }[];
  dueSoon: { assignmentId: number; title: string; dueAt: string; submitted: number; students: number }[];
  overdue: { assignmentId: number; title: string; dueAt: string; missing: string[]; missingCount: number }[];
}

export interface DailyReportData {
  teacherName: string;
  /** Stops all email to the teacher's address, without signing in. */
  unsubscribeUrl: string;
  /** Start and end of the window for "new submissions". */
  since: string;
  until: string;
  classes: ClassReport[];
}

export function newSubmissionCount(report: DailyReportData): number {
  return report.classes.reduce((sum, c) => sum + c.submissions.length + c.moreSubmissions, 0);
}

function submissionRow(s: ReportSubmission, zone: string): string[] {
  const ungraded = s.autoError ? 'Needs grading (autograde error)' : 'Needs grading';
  const score = s.score !== null ? formatScoreOf(s.score, s.points) : ungraded;
  const attempt = s.attempt > 1 ? ` (attempt ${s.attempt})` : '';
  const submitted = formatDateTime(s.submittedAt, zone);
  return [s.studentName, `${s.assignmentTitle}${attempt}`, submitted, s.late ? `${score} · LATE` : score];
}

function classBlocks(c: ClassReport, zone: string): Block[] {
  const blocks: Block[] = [{ kind: 'subheading', text: c.className }];
  const total = c.submissions.length + c.moreSubmissions;
  if (total > 0) {
    blocks.push(
      { kind: 'paragraph', parts: [{ bold: `New submissions (${total})` }] },
      {
        kind: 'table',
        head: ['Student', 'Assignment', 'Submitted', 'Score'],
        rows: c.submissions.map((s) => submissionRow(s, zone)),
      },
    );
    if (c.moreSubmissions > 0) blocks.push({ kind: 'paragraph', parts: [`…and ${c.moreSubmissions} more.`] });
  } else {
    blocks.push({ kind: 'paragraph', parts: ['No new submissions.'] });
  }
  if (c.needsGrading.length > 0) {
    blocks.push(
      { kind: 'paragraph', parts: [{ bold: 'Needs grading' }] },
      {
        kind: 'list',
        items: c.needsGrading.map((a) => [
          { href: link(`/teacher/assignments/${a.assignmentId}`), label: a.title },
          `: ${a.count} ${a.count === 1 ? 'submission' : 'submissions'}`,
        ]),
      },
    );
  }
  if (c.dueSoon.length > 0) {
    blocks.push(
      { kind: 'paragraph', parts: [{ bold: 'Due in the next 7 days' }] },
      {
        kind: 'list',
        items: c.dueSoon.map((a) => [
          { href: link(`/teacher/assignments/${a.assignmentId}`), label: a.title },
          ` — due ${formatDateTime(a.dueAt, zone)} — ${a.submitted} of ${a.students} submitted`,
        ]),
      },
    );
  }
  if (c.overdue.length > 0) {
    blocks.push(
      { kind: 'paragraph', parts: [{ bold: 'Overdue, still missing' }] },
      {
        kind: 'list',
        items: c.overdue.map((a) => {
          const more = a.missingCount - a.missing.length;
          const names = a.missing.join(', ') + (more > 0 ? `, and ${more} more` : '');
          return [
            { href: link(`/teacher/assignments/${a.assignmentId}`), label: a.title },
            ` — due ${formatDate(a.dueAt, zone)} — missing (${a.missingCount}): ${names}`,
          ];
        }),
      },
    );
  }
  return blocks;
}

export function dailyReportEmail(d: DailyReportData): MailContent {
  const zone = timeZone();
  const count = newSubmissionCount(d);
  const day = formatDate(d.until, zone);
  const summary =
    count === 0
      ? 'No new submissions'
      : `${count} new ${count === 1 ? 'submission' : 'submissions'}`;
  const blocks: Block[] = [
    { kind: 'heading', text: `Daily report for ${day}` },
    {
      kind: 'paragraph',
      parts: [`Hi ${d.teacherName}. `, { bold: summary }, ` since ${formatDateTime(d.since, zone)}.`],
    },
  ];
  if (d.classes.length === 0) blocks.push({ kind: 'paragraph', parts: ["You don't have any classes yet."] });
  for (const c of d.classes) blocks.push(...classBlocks(c, zone));
  blocks.push({ kind: 'button', href: link('/teacher'), label: `Open ${emailConfig().fromName}` });
  return renderEmail({
    subject: `Daily report: ${summary.toLowerCase()} — ${day}`,
    preheader: `${summary} in your classes since ${formatDateTime(d.since, zone)}.`,
    blocks,
    footer: [
      ["You're getting this daily report because it's turned on for your teacher account."],
      [
        'Change the time or turn it off on your ',
        { href: link('/account'), label: 'Account page' },
        ', or ',
        { href: d.unsubscribeUrl, label: 'unsubscribe' },
        '.',
      ],
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Test email                                                         */
/* ------------------------------------------------------------------ */

export function testEmail(teacherName: string, teacherEmail: string): MailContent {
  const cfg = emailConfig();
  const zone = timeZone();
  return renderEmail({
    subject: `Test email from ${cfg.fromName}`,
    preheader: 'Email is working.',
    blocks: [
      { kind: 'heading', text: 'Email is working' },
      {
        kind: 'paragraph',
        parts: [`Hi ${teacherName}, this is a test email. If you can read it, email from this app reaches you.`],
      },
      {
        kind: 'details',
        rows: [
          ['Sent from', `${cfg.fromName} <${cfg.fromAddress}>`],
          ['Sent to', teacherEmail],
          ['Sent at', formatDateTime(new Date(), zone)],
          ['Time zone', zone],
          ['Links go to', link('')],
        ],
      },
      { kind: 'button', href: link('/teacher'), label: `Open ${cfg.fromName}` },
    ],
    footer: [[`You're getting this because ${teacherName} asked for a test email on the Account page.`]],
  });
}
