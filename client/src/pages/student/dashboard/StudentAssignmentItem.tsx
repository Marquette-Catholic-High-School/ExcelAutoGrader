import { Badge, Group, Stack, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconAlertTriangle,
  IconChevronRight,
  IconCircleCheck,
  IconClockHour4,
  IconFileSpreadsheet,
  IconHourglass,
} from '@tabler/icons-react';
import { Link } from 'react-router';
import type { AssignmentSummary, StudentAssignmentStatus } from '@shared/types';
import { BADGE_NO_SHRINK, GradingModeBadge, LateBadge, StudentStatusBadge } from '../../../components/StatusBadges';
import { formatDateTime, formatScoreOf, fromNow, isPast, percent, scoreColor } from '../../../utils/format';
import classes from './items.module.css';

/** Assignments due within this window get the "due soon" emphasis. */
export const DUE_SOON_MS = 48 * 3600 * 1000;

export function isDueSoon(dueAt: string): boolean {
  const ms = new Date(dueAt).getTime() - Date.now();
  return ms > 0 && ms <= DUE_SOON_MS;
}

const STATUS_ICON: Record<StudentAssignmentStatus, { icon: typeof IconFileSpreadsheet; color: string }> = {
  not_submitted: { icon: IconFileSpreadsheet, color: 'brand' },
  missing: { icon: IconAlertTriangle, color: 'red' },
  submitted: { icon: IconHourglass, color: 'blue' },
  graded: { icon: IconCircleCheck, color: 'teal' },
};

function DueLine({ a }: { a: AssignmentSummary }) {
  const status = a.mine?.status ?? 'not_submitted';
  if (status === 'missing') {
    return (
      <Text span size="xs" c="red" fw={600}>
        Was due {fromNow(a.dueAt)}
      </Text>
    );
  }
  if (status === 'not_submitted' && isDueSoon(a.dueAt)) {
    return (
      <Text span size="xs" c="orange" fw={700}>
        <IconClockHour4 size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
        Due {fromNow(a.dueAt)}
      </Text>
    );
  }
  if ((status === 'submitted' || status === 'graded') && a.mine?.submittedAt) {
    return (
      <Text span size="xs" c="dimmed">
        Submitted {fromNow(a.mine.submittedAt)}
      </Text>
    );
  }
  return (
    <Text span size="xs" c={isPast(a.dueAt) ? 'red' : 'dimmed'}>
      Due {formatDateTime(a.dueAt)}
    </Text>
  );
}

function Score({ a }: { a: AssignmentSummary }) {
  const score = a.mine?.finalScore;
  if (a.mine?.status !== 'graded' || score === null || score === undefined) return null;
  const pct = percent(score, a.points);
  return (
    <Tooltip label={pct === null ? 'Your score' : `${pct}%`}>
      <Badge variant="light" color={scoreColor(pct)} size="lg" radius="sm" tt="none" fw={700} {...BADGE_NO_SHRINK}>
        {formatScoreOf(score, a.points)}
      </Badge>
    </Tooltip>
  );
}

/** One assignment row for the student dashboard and class page; the whole row links to the assignment. */
export function StudentAssignmentItem({
  a,
  showClass = true,
  showMode = false,
}: {
  a: AssignmentSummary;
  showClass?: boolean;
  showMode?: boolean;
}) {
  const status = a.mine?.status ?? 'not_submitted';
  const { icon: Icon, color } = STATUS_ICON[status];
  return (
    <UnstyledButton component={Link} to={`/student/assignments/${a.id}`} className={classes.item}>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="md" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          <ThemeIcon variant="light" color={color} size={40} radius="md" visibleFrom="xs">
            <Icon size={20} />
          </ThemeIcon>
          <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
            <Text fw={600} lineClamp={2}>
              {a.title}
            </Text>
            <Text size="xs" c="dimmed" component="div">
              {showClass && <>{a.className} · </>}
              <DueLine a={a} />
            </Text>
            <Group gap={6} wrap="wrap">
              <StudentStatusBadge status={status} />
              <LateBadge late={a.mine?.late ?? false} />
              {showMode && <GradingModeBadge mode={a.gradingMode} />}
            </Group>
          </Stack>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Score a={a} />
          <IconChevronRight size={18} color="var(--mantine-color-dimmed)" />
        </Group>
      </Group>
    </UnstyledButton>
  );
}
