/**
 * Small shared badges/alerts used across teacher and student pages.
 * The LATE flag must look identical everywhere: red, filled, with a clock icon.
 */
import { Alert, Badge, Tooltip, type BadgeProps, type MantineSize } from '@mantine/core';
import { IconAlertTriangle, IconClockExclamation, IconPencil, IconRobot } from '@tabler/icons-react';
import type { GradingMode, StudentAssignmentStatus, TeacherRowStatus } from '@shared/types';
import { formatDateTime, formatDuration } from '../utils/format';

/**
 * Keeps a badge at its full label width. A Badge clips its label with an ellipsis (overflow: hidden), which also
 * lets flex rows and auto-width table cells squeeze it down to "L…"; spread this on every status badge.
 */
export const BADGE_NO_SHRINK = { miw: 'max-content', style: { flexShrink: 0 } } satisfies Partial<BadgeProps>;

export function LateBadge({
  late,
  lateBySeconds,
  size = 'sm',
}: {
  late: boolean;
  lateBySeconds?: number;
  size?: MantineSize;
}) {
  if (!late) return null;
  const badge = (
    <Badge
      color="red"
      variant="filled"
      size={size}
      leftSection={<IconClockExclamation size={12} />}
      {...BADGE_NO_SHRINK}
    >
      Late
    </Badge>
  );
  if (lateBySeconds === undefined) return badge;
  return <Tooltip label={`Submitted ${formatDuration(lateBySeconds)} after the due date`}>{badge}</Tooltip>;
}

/** Big, unmissable banner for grading / viewing a late submission. Renders nothing when not late. */
export function LateAlert({
  late,
  lateBySeconds,
  dueAt,
  submittedAt,
}: {
  late: boolean;
  lateBySeconds: number;
  dueAt: string;
  submittedAt: string;
}) {
  if (!late) return null;
  return (
    <Alert
      color="red"
      variant="filled"
      icon={<IconAlertTriangle />}
      title={`Late submission — ${formatDuration(lateBySeconds)} after the due date`}
    >
      Due {formatDateTime(dueAt)} · Submitted {formatDateTime(submittedAt)}
    </Alert>
  );
}

const TEACHER_STATUS: Record<TeacherRowStatus, { label: string; color: string }> = {
  missing: { label: 'Missing', color: 'gray' },
  needs_grading: { label: 'Needs grading', color: 'orange' },
  autograded: { label: 'Autograded', color: 'teal' },
  graded: { label: 'Graded', color: 'blue' },
};

/**
 * `pastDue` refines 'missing' (no submission): red "Missing" once the due date has passed, gray "Not submitted"
 * before it. Without `pastDue` it stays a neutral gray "Missing".
 */
export function TeacherStatusBadge({
  status,
  size = 'sm',
  pastDue,
}: {
  status: TeacherRowStatus;
  size?: MantineSize;
  pastDue?: boolean;
}) {
  const s =
    status === 'missing' && pastDue !== undefined
      ? pastDue
        ? { label: 'Missing', color: 'red' }
        : { label: 'Not submitted', color: 'gray' }
      : TEACHER_STATUS[status];
  return (
    <Badge color={s.color} variant="light" size={size} {...BADGE_NO_SHRINK}>
      {s.label}
    </Badge>
  );
}

const STUDENT_STATUS: Record<StudentAssignmentStatus, { label: string; color: string }> = {
  not_submitted: { label: 'Not submitted', color: 'gray' },
  missing: { label: 'Missing', color: 'red' },
  submitted: { label: 'Submitted', color: 'blue' },
  graded: { label: 'Graded', color: 'teal' },
};

export function StudentStatusBadge({ status, size = 'sm' }: { status: StudentAssignmentStatus; size?: MantineSize }) {
  const s = STUDENT_STATUS[status];
  return (
    <Badge color={s.color} variant="light" size={size} {...BADGE_NO_SHRINK}>
      {s.label}
    </Badge>
  );
}

export function GradingModeBadge({ mode, size = 'sm' }: { mode: GradingMode; size?: MantineSize }) {
  return mode === 'auto' ? (
    <Badge color="brand" variant="outline" size={size} leftSection={<IconRobot size={12} />} {...BADGE_NO_SHRINK}>
      Autograded
    </Badge>
  ) : (
    <Badge color="indigo" variant="outline" size={size} leftSection={<IconPencil size={12} />} {...BADGE_NO_SHRINK}>
      Manual grading
    </Badge>
  );
}
