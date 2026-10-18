import type { ReactNode } from 'react';
import {
  ActionIcon,
  Avatar,
  Button,
  Card,
  EmptyState,
  Group,
  Menu,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconDotsVertical,
  IconDownload,
  IconFilterOff,
  IconSearch,
  IconUpload,
  IconUserPlus,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import { Link } from 'react-router';
import type { AssignmentDetail, StudentInfo, SubmissionRow } from '@shared/types';
import { endpoints } from '../../../api/endpoints';
import { LateBadge, TeacherStatusBadge } from '../../../components/StatusBadges';
import { notifyError } from '../../../utils/errors';
import { formatDateTime, formatScore, fromNow, isPast, percent, scoreTextColor } from '../../../utils/format';
import classes from './assignment.module.css';

export type SubmissionFilter = 'all' | 'needs_grading' | 'late' | 'missing' | 'graded';

export const SUBMISSION_FILTERS: SubmissionFilter[] = ['all', 'needs_grading', 'late', 'missing', 'graded'];

const FILTER_TEST: Record<SubmissionFilter, (row: SubmissionRow) => boolean> = {
  all: () => true,
  needs_grading: (r) => r.status === 'needs_grading',
  late: (r) => !!r.latest?.late,
  missing: (r) => r.status === 'missing',
  graded: (r) => r.status === 'graded' || r.status === 'autograded',
};

export function isSubmissionFilter(value: string | null): value is SubmissionFilter {
  return value !== null && (SUBMISSION_FILTERS as string[]).includes(value);
}

function matchesSearch(row: SubmissionRow, query: string) {
  if (!query) return true;
  const q = query.toLowerCase();
  return row.student.name.toLowerCase().includes(q) || row.student.email.toLowerCase().includes(q);
}

function StatusCell({ row, pastDue }: { row: SubmissionRow; pastDue: boolean }) {
  const latest = row.latest;
  return (
    <Group gap={6} wrap="nowrap">
      <TeacherStatusBadge status={row.status} pastDue={pastDue} />
      {latest && <LateBadge late={latest.late} lateBySeconds={latest.lateBySeconds} />}
      {latest?.autoStatus === 'error' && (
        <Tooltip label={latest.autoError ?? "The autograder couldn't read this file"} multiline maw={280}>
          <IconAlertCircle size={16} color="var(--mantine-color-orange-6)" aria-label="Autograder error" />
        </Tooltip>
      )}
    </Group>
  );
}

function ScoreCell({ row, points }: { row: SubmissionRow; points: number }) {
  const latest = row.latest;
  if (!latest || latest.finalScore === null) {
    return (
      <Text size="sm" c="dimmed">
        {row.status === 'needs_grading' ? 'Not graded' : '—'}
      </Text>
    );
  }
  const pct = percent(latest.finalScore, points);
  const source = latest.overrideScore !== null ? 'override' : 'auto';
  return (
    <Stack gap={0}>
      <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>
        <Text span inherit c={scoreTextColor(pct)}>
          {formatScore(latest.finalScore)}
        </Text>{' '}
        / {formatScore(points)}
      </Text>
      <Text size="xs" c="dimmed">
        {pct}% · {source}
      </Text>
    </Stack>
  );
}

function SubmittedCell({ row, pastDue }: { row: SubmissionRow; pastDue: boolean }) {
  const latest = row.latest;
  if (!latest) {
    return (
      <Text size="sm" c={pastDue ? 'red' : 'dimmed'} fw={pastDue ? 600 : undefined}>
        {pastDue ? 'Missing' : 'Not yet'}
      </Text>
    );
  }
  const byOther = latest.submittedByName !== row.student.name;
  return (
    <Stack gap={0}>
      <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
        {formatDateTime(latest.submittedAt)}
      </Text>
      <Text size="xs" c="dimmed">
        {fromNow(latest.submittedAt)}
        {byOther && ` · uploaded by ${latest.submittedByName}`}
      </Text>
    </Stack>
  );
}

function RowActions({
  row,
  gradeHref,
  onUploadFor,
}: {
  row: SubmissionRow;
  gradeHref: string;
  onUploadFor: (student: StudentInfo) => void;
}) {
  const needsGrading = row.status === 'needs_grading';
  return (
    <Group gap={4} justify="flex-end" wrap="nowrap">
      {/* Black on orange-6 is about 8:1 in both color schemes; white on orange is under 3.5:1. */}
      <Button
        component={Link}
        to={gradeHref}
        size="xs"
        variant={needsGrading ? 'filled' : 'light'}
        color={needsGrading ? 'orange.6' : undefined}
        c={needsGrading ? 'black' : undefined}
        aria-label={`${needsGrading ? 'Grade' : 'View'} ${row.student.name}`}
      >
        {needsGrading ? 'Grade' : 'View'}
      </Button>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" aria-label={`More actions for ${row.student.name}`}>
            <IconDotsVertical size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconDownload size={16} />}
            disabled={!row.latest}
            onClick={() => row.latest && endpoints.downloadSubmission(row.latest.id).catch((e) => notifyError(e))}
          >
            Download file
          </Menu.Item>
          <Menu.Item leftSection={<IconUpload size={16} />} onClick={() => onUploadFor(row.student)}>
            Upload on behalf…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

const EMPTY_FILTER_TEXT: Record<SubmissionFilter, string> = {
  all: 'No students to show.',
  needs_grading: 'All caught up — nothing needs grading right now.',
  late: 'No late submissions.',
  missing: 'Everyone has submitted something.',
  graded: 'Nothing has a score yet.',
};

function FilterLabel({ label, count }: { label: string; count: number }) {
  return (
    <Group gap={6} wrap="nowrap" justify="center">
      <span>{label}</span>
      <span className={classes.countPill}>{count}</span>
    </Group>
  );
}

export function SubmissionsTable({
  assignment,
  rows,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  onReset,
  onUploadFor,
}: {
  assignment: AssignmentDetail;
  rows: SubmissionRow[];
  filter: SubmissionFilter;
  onFilterChange: (filter: SubmissionFilter) => void;
  /** The search box text (local state, so typing never waits for the URL). */
  search: string;
  onSearchChange: (search: string) => void;
  /** Clears both the search and the filter in one update ("Show everyone"). */
  onReset: () => void;
  onUploadFor: (student: StudentInfo) => void;
}) {
  const pastDue = isPast(assignment.dueAt);
  const counts = Object.fromEntries(
    SUBMISSION_FILTERS.map((f) => [f, rows.filter(FILTER_TEST[f]).length]),
  ) as Record<SubmissionFilter, number>;
  const visible = rows.filter((r) => FILTER_TEST[filter](r) && matchesSearch(r, search.trim()));

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          py="xl"
          icon={<IconUsers size={28} />}
          withIndicatorBackground
          title="No students in this class yet"
          description="Add students to the class and their submissions will show up here."
        >
          <EmptyState.Actions>
            <Button
              component={Link}
              to={`/teacher/classes/${assignment.classId}?tab=students`}
              leftSection={<IconUserPlus size={16} />}
            >
              Add students
            </Button>
          </EmptyState.Actions>
        </EmptyState>
      </Card>
    );
  }

  const filterData: { value: SubmissionFilter; label: ReactNode }[] = [
    { value: 'all', label: <FilterLabel label="All" count={counts.all} /> },
    { value: 'needs_grading', label: <FilterLabel label="Needs grading" count={counts.needs_grading} /> },
    { value: 'late', label: <FilterLabel label="Late" count={counts.late} /> },
    { value: 'missing', label: <FilterLabel label={pastDue ? 'Missing' : 'Not submitted'} count={counts.missing} /> },
    { value: 'graded', label: <FilterLabel label="Graded" count={counts.graded} /> },
  ];

  return (
    <Card padding={0}>
      <Group justify="space-between" p="md" gap="sm" wrap="wrap">
        <ScrollArea type="auto" scrollbarSize={4} offsetScrollbars="x" style={{ maxWidth: '100%' }}>
          <SegmentedControl
            data={filterData}
            value={filter}
            onChange={(v) => onFilterChange(v as SubmissionFilter)}
            aria-label="Filter submissions"
          />
        </ScrollArea>
        <TextInput
          placeholder="Search students"
          aria-label="Search students by name or email"
          leftSection={<IconSearch size={16} />}
          rightSection={
            search ? (
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                onClick={() => onSearchChange('')}
                aria-label="Clear search"
              >
                <IconX size={14} />
              </ActionIcon>
            ) : null
          }
          value={search}
          onChange={(e) => onSearchChange(e.currentTarget.value)}
          w={{ base: '100%', sm: 260 }}
        />
      </Group>

      {visible.length === 0 ? (
        <EmptyState
          py="xl"
          size="sm"
          icon={<IconFilterOff size={24} />}
          withIndicatorBackground
          title={search.trim() ? `No students match “${search.trim()}”` : 'Nothing here'}
          description={search.trim() ? 'Try a different name or email.' : EMPTY_FILTER_TEXT[filter]}
        >
          <EmptyState.Actions>
            <Button variant="default" size="xs" onClick={onReset}>
              Show everyone
            </Button>
          </EmptyState.Actions>
        </EmptyState>
      ) : (
        <Table.ScrollContainer minWidth={820}>
          <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Student</Table.Th>
                {/* Room for "Needs grading" + "Late" + the error icon: the table scrolls instead of squeezing it. */}
                <Table.Th miw={240}>Status</Table.Th>
                <Table.Th>Submitted</Table.Th>
                <Table.Th ta="center">Attempts</Table.Th>
                <Table.Th>Score</Table.Th>
                <Table.Th>
                  <VisuallyHidden>Actions</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.map((row) => (
                <Table.Tr key={row.student.id} className={row.latest?.late ? classes.lateRow : undefined}>
                  <Table.Td>
                    <Group gap="sm" wrap="nowrap">
                      <Avatar name={row.student.name} color="initials" size={32} radius="xl" />
                      <Stack gap={0} style={{ minWidth: 0 }}>
                        <Text size="sm" fw={600} truncate="end">
                          {row.student.name}
                        </Text>
                        <Text size="xs" c="dimmed" truncate="end">
                          {row.student.email}
                        </Text>
                      </Stack>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <StatusCell row={row} pastDue={pastDue} />
                  </Table.Td>
                  <Table.Td>
                    <SubmittedCell row={row} pastDue={pastDue} />
                  </Table.Td>
                  <Table.Td ta="center">
                    <Text size="sm" c={row.attemptCount ? undefined : 'dimmed'}>
                      {row.attemptCount || '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <ScoreCell row={row} points={assignment.points} />
                  </Table.Td>
                  <Table.Td>
                    <RowActions
                      row={row}
                      gradeHref={`/teacher/assignments/${assignment.id}/grade/${row.student.id}`}
                      onUploadFor={onUploadFor}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}
