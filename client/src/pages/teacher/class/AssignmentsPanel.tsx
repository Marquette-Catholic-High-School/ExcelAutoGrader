import {
  Anchor,
  Button,
  Card,
  EmptyState,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import {
  IconChecks,
  IconChevronRight,
  IconFileSpreadsheet,
  IconPlus,
  IconRobot,
  IconUpload,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { AssignmentSummary } from '@shared/types';
import { endpoints, qk } from '../../../api/endpoints';
import { LateCountBadge, NeedsGradingCountBadge } from '../../../components/AssignmentBadges';
import { QueryState } from '../../../components/QueryState';
import { GradingModeBadge } from '../../../components/StatusBadges';
import { formatScore } from '../../../utils/format';
import { DueDate } from './DueDate';
import classes from './cards.module.css';

function newAssignmentPath(classId: number) {
  return `/teacher/classes/${classId}/assignments/new`;
}

function SubmittedCell({ a }: { a: AssignmentSummary }) {
  const submitted = a.counts?.submitted ?? 0;
  const total = a.counts?.students ?? 0;
  const pct = total > 0 ? (submitted / total) * 100 : 0;
  return (
    <Stack gap={4} w={110}>
      <Text size="sm" fw={500}>
        {submitted} / {total}
      </Text>
      <Progress
        value={pct}
        size="sm"
        color={pct === 100 ? 'teal' : 'brand'}
        aria-label={`${submitted} of ${total} submitted`}
      />
    </Stack>
  );
}

function GradingCell({ a }: { a: AssignmentSummary }) {
  const needs = a.counts?.needsGrading ?? 0;
  if (needs > 0) return <NeedsGradingCountBadge count={needs} />;
  if ((a.counts?.submitted ?? 0) === 0) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Group gap={4} c="teal" wrap="nowrap">
      <IconChecks size={16} />
      <Text size="sm" c="teal">
        All graded
      </Text>
    </Group>
  );
}

function AssignmentsTable({ list }: { list: AssignmentSummary[] }) {
  const navigate = useNavigate();
  return (
    <Card p={0}>
      <Table.ScrollContainer minWidth={900}>
        <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Assignment</Table.Th>
              <Table.Th w={210}>Due</Table.Th>
              <Table.Th w={140}>Submitted</Table.Th>
              <Table.Th w={110}>Late</Table.Th>
              <Table.Th w={150}>Needs grading</Table.Th>
              <Table.Th w={40}>
                <VisuallyHidden>Open</VisuallyHidden>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.map((a) => {
              const to = `/teacher/assignments/${a.id}`;
              const late = a.counts?.late ?? 0;
              return (
                <Table.Tr key={a.id} className={classes.clickableRow} onClick={() => navigate(to)}>
                  <Table.Td maw={320}>
                    <Anchor component={Link} to={to} fw={600} c="inherit" onClick={(e) => e.stopPropagation()}>
                      {a.title}
                    </Anchor>
                    <Group gap={8} mt={4}>
                      <GradingModeBadge mode={a.gradingMode} size="xs" />
                      <Text size="xs" c="dimmed">
                        {formatScore(a.points)} pts
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <DueDate dueAt={a.dueAt} />
                  </Table.Td>
                  <Table.Td>
                    <SubmittedCell a={a} />
                  </Table.Td>
                  <Table.Td>
                    {late > 0 ? (
                      <LateCountBadge count={late} />
                    ) : (
                      <Text size="sm" c="dimmed">
                        None
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <GradingCell a={a} />
                  </Table.Td>
                  <Table.Td>
                    <IconChevronRight size={16} color="var(--mantine-color-dimmed)" />
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

const STEPS = [
  {
    icon: <IconFileSpreadsheet size={20} />,
    title: 'Upload the finished workbook',
    text: 'Your completed copy is the answer key. Optionally attach a starter file for students.',
  },
  {
    icon: <IconUpload size={20} />,
    title: 'Students upload their work',
    text: 'Uploads are accepted any time. Anything after the due date is flagged late.',
  },
  {
    icon: <IconRobot size={20} />,
    title: 'Grades appear instantly',
    text: 'Each cell is compared with your key. Adjust any score or leave feedback afterwards.',
  },
];

function NoAssignments({ classId }: { classId: number }) {
  return (
    <Card py="xl">
      <EmptyState
        variant="light"
        size="md"
        icon={<IconFileSpreadsheet size={32} />}
        title="No assignments yet"
        description="Create an assignment and upload the finished Excel workbook. The autograder uses it to check every student's file."
      >
        <EmptyState.Actions>
          <Button component={Link} to={newAssignmentPath(classId)} leftSection={<IconPlus size={18} />}>
            New assignment
          </Button>
        </EmptyState.Actions>
      </EmptyState>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" mt="xl" maw={880} mx="auto" w="100%">
        {STEPS.map((step, i) => (
          <Stack key={step.title} gap={6} align="center" ta="center">
            <ThemeIcon variant="light" size={40} radius="xl">
              {step.icon}
            </ThemeIcon>
            <Text fw={600} size="sm">
              {i + 1}. {step.title}
            </Text>
            <Text size="xs" c="dimmed">
              {step.text}
            </Text>
          </Stack>
        ))}
      </SimpleGrid>
      <Text size="xs" c="dimmed" ta="center" mt="lg">
        No answer key? Choose manual grading and review each student's workbook in the built-in viewer.
      </Text>
    </Card>
  );
}

export function AssignmentsPanel({ classId }: { classId: number }) {
  const query = useQuery({
    queryKey: qk.classAssignments(classId),
    queryFn: () => endpoints.listClassAssignments(classId),
  });

  return (
    <QueryState query={query} loadingLabel="Loading assignments…">
      {(list) =>
        list.length === 0 ? (
          <NoAssignments classId={classId} />
        ) : (
          <Stack gap="md">
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {list.length} {list.length === 1 ? 'assignment' : 'assignments'}, sorted by due date
              </Text>
              <Tooltip label="Upload a finished workbook to autograde, or grade by hand">
                <Button component={Link} to={newAssignmentPath(classId)} leftSection={<IconPlus size={18} />}>
                  New assignment
                </Button>
              </Tooltip>
            </Group>
            <AssignmentsTable list={list} />
          </Stack>
        )
      }
    </QueryState>
  );
}
