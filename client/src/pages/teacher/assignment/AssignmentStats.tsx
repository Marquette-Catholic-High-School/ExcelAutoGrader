import type { ReactNode } from 'react';
import { Card, Group, RingProgress, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconChartBar, IconClockExclamation, IconPencil } from '@tabler/icons-react';
import type { SubmissionRow } from '@shared/types';
import { formatScore, percent, scoreColor } from '../../../utils/format';
import type { SubmissionFilter } from './SubmissionsTable';
import classes from './assignment.module.css';

export interface AssignmentStatsData {
  students: number;
  submitted: number;
  late: number;
  needsGrading: number;
  graded: number;
  average: number | null;
}

export function computeStats(rows: SubmissionRow[]): AssignmentStatsData {
  const scores = rows.map((r) => r.latest?.finalScore).filter((s): s is number => s !== null && s !== undefined);
  const average = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null;
  return {
    students: rows.length,
    submitted: rows.filter((r) => r.latest).length,
    late: rows.filter((r) => r.latest?.late).length,
    needsGrading: rows.filter((r) => r.status === 'needs_grading').length,
    graded: scores.length,
    average,
  };
}

function StatCard({
  label,
  value,
  hint,
  visual,
  onClick,
  actionLabel,
}: {
  label: string;
  value: ReactNode;
  hint: ReactNode;
  visual: ReactNode;
  onClick?: () => void;
  actionLabel?: string;
}) {
  const body = (
    <Group justify="space-between" wrap="nowrap" align="center" h="100%">
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={700} lts={0.4}>
          {label}
        </Text>
        <Text fz={26} fw={700} lh={1.2}>
          {value}
        </Text>
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      </Stack>
      {visual}
    </Group>
  );
  if (!onClick) {
    return (
      <Card padding="md" className={classes.statCard}>
        {body}
      </Card>
    );
  }
  return (
    <Card
      padding="md"
      component="button"
      type="button"
      className={`${classes.statCard} ${classes.statCardButton}`}
      onClick={onClick}
      aria-label={actionLabel}
    >
      {body}
    </Card>
  );
}

export function AssignmentStats({
  stats,
  points,
  onFilter,
}: {
  stats: AssignmentStatsData;
  points: number;
  onFilter: (filter: SubmissionFilter) => void;
}) {
  const submittedPct = stats.students ? Math.round((stats.submitted / stats.students) * 100) : 0;
  const avgPct = percent(stats.average, points);

  return (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
      <StatCard
        label="Submitted"
        value={`${stats.submitted} / ${stats.students}`}
        hint={stats.students ? `${submittedPct}% of the class` : 'No students yet'}
        visual={
          <RingProgress
            size={64}
            thickness={7}
            roundCaps
            sections={[{ value: submittedPct, color: 'brand' }]}
            label={
              <Text ta="center" size="xs" fw={700}>
                {submittedPct}%
              </Text>
            }
          />
        }
      />
      <StatCard
        label="Late"
        value={<Text span inherit c={stats.late ? 'red' : undefined}>{stats.late}</Text>}
        hint="Submitted after the due date"
        onClick={stats.late ? () => onFilter('late') : undefined}
        actionLabel="Show late submissions"
        visual={
          <ThemeIcon size={44} radius="xl" variant="light" color="red">
            <IconClockExclamation size={22} />
          </ThemeIcon>
        }
      />
      <StatCard
        label="Needs grading"
        value={<Text span inherit c={stats.needsGrading ? 'orange' : undefined}>{stats.needsGrading}</Text>}
        hint={stats.needsGrading ? 'Waiting for your score' : 'All caught up'}
        onClick={stats.needsGrading ? () => onFilter('needs_grading') : undefined}
        actionLabel="Show submissions that need grading"
        visual={
          <ThemeIcon size={44} radius="xl" variant="light" color="orange">
            <IconPencil size={22} />
          </ThemeIcon>
        }
      />
      <StatCard
        label="Average score"
        value={stats.average === null ? '—' : `${formatScore(stats.average)} / ${formatScore(points)}`}
        hint={stats.average === null ? 'No scores yet' : `${avgPct}% · ${stats.graded} scored`}
        visual={
          <ThemeIcon size={44} radius="xl" variant="light" color={scoreColor(avgPct)}>
            <IconChartBar size={22} />
          </ThemeIcon>
        }
      />
    </SimpleGrid>
  );
}
