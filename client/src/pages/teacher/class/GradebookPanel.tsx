import { useState } from 'react';
import {
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  EmptyState,
  Group,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconDownload, IconTable } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { AssignmentSummary, GradebookCell, GradebookResponse, StudentInfo } from '@shared/types';
import { endpoints, qk } from '../../../api/endpoints';
import { QueryState } from '../../../components/QueryState';
import { LateBadge } from '../../../components/StatusBadges';
import { notifyError } from '../../../utils/errors';
import { formatDateTime, formatScore, isPast, percent, scoreColor, scoreTextColor } from '../../../utils/format';
import classes from './cards.module.css';

const SCORE_LEGEND = [
  { label: '90%+', color: 'teal' },
  { label: '70–89%', color: 'lime' },
  { label: '50–69%', color: 'yellow' },
  { label: 'Below 50%', color: 'red' },
];

function NeedsGradingDot() {
  return (
    <Box
      component="span"
      w={8}
      h={8}
      bg="orange"
      style={{ borderRadius: '50%', display: 'inline-block', flexShrink: 0 }}
      aria-hidden
    />
  );
}

function ScorePill({ score, points }: { score: number; points: number }) {
  const pct = percent(score, points);
  return (
    <Badge variant="light" color={scoreColor(pct)} size="lg" radius="sm" tt="none" fw={700}>
      {formatScore(score)}
    </Badge>
  );
}

function cellLabel(student: StudentInfo, a: AssignmentSummary, cell: GradebookCell | undefined): string {
  const base = `${student.name}, ${a.title}`;
  if (!cell || cell.status === 'missing') return `${base}: ${isPast(a.dueAt) ? 'missing' : 'not submitted yet'}`;
  const late = cell.late ? ', late' : '';
  if (cell.finalScore !== null) return `${base}: ${formatScore(cell.finalScore)} of ${formatScore(a.points)}${late}`;
  return `${base}: needs grading${late}`;
}

function CellContent({ a, cell }: { a: AssignmentSummary; cell: GradebookCell | undefined }) {
  if (!cell || cell.status === 'missing') {
    return isPast(a.dueAt) ? (
      <Text size="xs" c="red" fw={600} opacity={0.75}>
        Missing
      </Text>
    ) : (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <>
      {cell.finalScore !== null ? (
        <ScorePill score={cell.finalScore} points={a.points} />
      ) : (
        <Group gap={6} wrap="nowrap">
          <NeedsGradingDot />
          <Text size="xs" c="orange" fw={600} style={{ whiteSpace: 'nowrap' }}>
            Needs grading
          </Text>
        </Group>
      )}
      <LateBadge late={cell.late} size="xs" />
    </>
  );
}

function studentTotal(data: GradebookResponse, studentId: number) {
  let earned = 0;
  let possible = 0;
  for (const a of data.assignments) {
    const score = data.cells[studentId]?.[a.id]?.finalScore;
    if (score === null || score === undefined) continue;
    earned += score;
    possible += a.points;
  }
  return { earned, possible, pct: possible > 0 ? percent(earned, possible) : null };
}

function classAverage(data: GradebookResponse, a: AssignmentSummary) {
  const scores = data.students
    .map((s) => data.cells[s.id]?.[a.id]?.finalScore)
    .filter((v): v is number => v !== null && v !== undefined);
  if (scores.length === 0) return null;
  return { pct: percent(scores.reduce((x, y) => x + y, 0) / scores.length, a.points), count: scores.length };
}

function Legend() {
  return (
    <Group gap="lg" wrap="wrap" fz="xs" c="dimmed">
      <Group gap={6}>
        {SCORE_LEGEND.map((item) => (
          <Badge key={item.label} variant="light" color={item.color} size="sm" tt="none" radius="sm">
            {item.label}
          </Badge>
        ))}
      </Group>
      <Group gap={6}>
        <LateBadge late size="xs" />
        <Text size="xs" c="dimmed">
          submitted after the due date
        </Text>
      </Group>
      <Group gap={6}>
        <NeedsGradingDot />
        <Text size="xs" c="dimmed">
          needs grading
        </Text>
      </Group>
      <Group gap={6}>
        <Text size="xs" c="red" fw={600} opacity={0.75}>
          Missing
        </Text>
        <Text size="xs" c="dimmed">
          past due, nothing submitted
        </Text>
      </Group>
      <Group gap={6}>
        <Text size="xs">—</Text>
        <Text size="xs" c="dimmed">
          not due yet
        </Text>
      </Group>
    </Group>
  );
}

function GradebookTable({ data }: { data: GradebookResponse }) {
  const navigate = useNavigate();
  const colWidth = 136;
  return (
    <Card p={0}>
      <Table.ScrollContainer minWidth={220 + data.assignments.length * colWidth + 120} type="native">
        <Table withColumnBorders verticalSpacing="xs" horizontalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th className={classes.stickyCol} miw={{ base: 150, sm: 220 }}>
                Student
              </Table.Th>
              {data.assignments.map((a) => (
                <Table.Th key={a.id} w={colWidth} miw={colWidth} ta="center" style={{ verticalAlign: 'bottom' }}>
                  <Tooltip label={`Due ${formatDateTime(a.dueAt)}`}>
                    <Anchor component={Link} to={`/teacher/assignments/${a.id}`} fz="sm" fw={600} lineClamp={2}>
                      {a.title}
                    </Anchor>
                  </Tooltip>
                  <Text size="xs" c="dimmed" fw={400}>
                    {formatScore(a.points)} pts
                  </Text>
                </Table.Th>
              ))}
              <Table.Th ta="center" miw={120} style={{ verticalAlign: 'bottom' }}>
                Total
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.students.map((s) => {
              const total = studentTotal(data, s.id);
              return (
                <Table.Tr key={s.id}>
                  <Table.Td className={classes.stickyCol}>
                    <Text size="sm" fw={500} lineClamp={1}>
                      {s.name}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {s.email}
                    </Text>
                  </Table.Td>
                  {data.assignments.map((a) => {
                    const cell = data.cells[s.id]?.[a.id];
                    return (
                      <Table.Td key={a.id} p={2}>
                        <UnstyledButton
                          className={classes.gradeCell}
                          aria-label={cellLabel(s, a, cell)}
                          onClick={() => navigate(`/teacher/assignments/${a.id}/grade/${s.id}`)}
                        >
                          <CellContent a={a} cell={cell} />
                        </UnstyledButton>
                      </Table.Td>
                    );
                  })}
                  <Table.Td ta="center">
                    {total.pct === null ? (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    ) : (
                      <Stack gap={0} align="center">
                        <Text size="sm" fw={700} c={scoreTextColor(total.pct)}>
                          {total.pct}%
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatScore(total.earned)} / {formatScore(total.possible)}
                        </Text>
                      </Stack>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr>
              <Table.Th className={classes.stickyCol}>
                <Text size="sm" fw={600}>
                  Class average
                </Text>
              </Table.Th>
              {data.assignments.map((a) => {
                const avg = classAverage(data, a);
                return (
                  <Table.Td key={a.id} ta="center">
                    {avg ? (
                      <Tooltip
                        label={`Average of ${avg.count} graded ${avg.count === 1 ? 'submission' : 'submissions'}`}
                      >
                        <Text size="sm" fw={600} c={scoreTextColor(avg.pct)}>
                          {avg.pct}%
                        </Text>
                      </Tooltip>
                    ) : (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                );
              })}
              <Table.Td />
            </Table.Tr>
          </Table.Tfoot>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

export function GradebookPanel({ classId }: { classId: number }) {
  const query = useQuery({ queryKey: qk.gradebook(classId), queryFn: () => endpoints.getGradebook(classId) });
  const [exporting, setExporting] = useState(false);

  async function exportCsv() {
    setExporting(true);
    try {
      await endpoints.downloadGradebookCsv(classId);
    } catch (err) {
      notifyError(err, 'Could not export the gradebook');
    } finally {
      setExporting(false);
    }
  }

  return (
    <QueryState query={query} loadingLabel="Loading gradebook…">
      {(data) => {
        if (data.students.length === 0 || data.assignments.length === 0) {
          return (
            <Card py="xl">
              <EmptyState
                variant="light"
                size="md"
                icon={<IconTable size={32} />}
                title="The gradebook is empty"
                description={
                  data.students.length === 0
                    ? 'Add students to this class and their grades will appear here.'
                    : 'Create an assignment and every student’s score will appear here as they submit.'
                }
              />
            </Card>
          );
        }
        return (
          <Stack gap="md">
            <Group justify="space-between" wrap="wrap" gap="sm">
              <Text size="sm" c="dimmed">
                {data.students.length} {data.students.length === 1 ? 'student' : 'students'} ×{' '}
                {data.assignments.length} {data.assignments.length === 1 ? 'assignment' : 'assignments'}. Select a
                cell to view or grade that submission.
              </Text>
              <Button
                variant="default"
                leftSection={<IconDownload size={18} />}
                loading={exporting}
                onClick={exportCsv}
              >
                Export CSV
              </Button>
            </Group>
            <GradebookTable data={data} />
            <Legend />
            <Text size="xs" c="dimmed">
              Total is the sum of final scores divided by the points of the assignments that have a score, so missing
              and ungraded work is not counted yet.
            </Text>
          </Stack>
        );
      }}
    </QueryState>
  );
}
