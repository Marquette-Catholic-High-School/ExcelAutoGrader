import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Alert, Button, Card, Group, Menu, Stack, Text, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconDots,
  IconDownload,
  IconEye,
  IconFileSpreadsheet,
  IconKey,
  IconPencil,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import type { AssignmentDetail, AssignmentSubmissionsResponse, StudentInfo } from '@shared/types';
import { endpoints, qk } from '../../api/endpoints';
import { PastDueBadge } from '../../components/AssignmentBadges';
import { isNotFoundError } from '../../components/NotFoundCard';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, PageLoader } from '../../components/QueryState';
import { GradingModeBadge } from '../../components/StatusBadges';
import { notifyError } from '../../utils/errors';
import { formatDateTime, fromNow, formatScore, isPast } from '../../utils/format';
import { parseId } from '../../utils/params';
import { usePageTitle } from '../../utils/usePageTitle';
import { AnswerKeySection } from './assignment/AnswerKeySection';
import { AssignmentNotFound } from './assignment/AssignmentNotFound';
import { AssignmentStats, computeStats } from './assignment/AssignmentStats';
import { invalidateAssignment } from './assignment/cache';
import { DeleteAssignmentModal } from './assignment/DeleteAssignmentModal';
import { isSubmissionFilter, SubmissionsTable, type SubmissionFilter } from './assignment/SubmissionsTable';
import { UploadOnBehalfModal } from './assignment/UploadOnBehalfModal';

const SEARCH_URL_DELAY_MS = 250;

function useRegrade(assignment: AssignmentDetail) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => endpoints.regradeAssignment(assignment.id),
    onSuccess: async ({ regraded, errors }) => {
      await invalidateAssignment(qc, assignment.classId, assignment.id);
      notifications.show({
        color: errors > 0 ? 'yellow' : 'teal',
        title: 'Autograder finished',
        message:
          `Re-graded ${regraded} submission${regraded === 1 ? '' : 's'}.` +
          (errors > 0 ? ` ${errors} couldn't be graded automatically and need a manual score.` : ''),
      });
    },
    onError: (err) => notifyError(err, "Couldn't re-run the autograder"),
  });

  const confirm = (submitted: number) =>
    modals.openConfirmModal({
      title: 'Re-run the autograder?',
      children: (
        <Text size="sm">
          Every attempt from {submitted} student{submitted === 1 ? '' : 's'} is checked again against the current answer
          key and grading options. Scores you entered yourself still take priority over the autograde score.
        </Text>
      ),
      labels: { confirm: 'Re-run autograder', cancel: 'Cancel' },
      onConfirm: () => mutation.mutate(),
    });

  return { confirm, isPending: mutation.isPending };
}

function HeaderActions({
  assignment,
  submitted,
  onDelete,
}: {
  assignment: AssignmentDetail;
  submitted: number;
  onDelete: () => void;
}) {
  const regrade = useRegrade(assignment);
  const download = (fn: (id: number) => Promise<void>) => fn(assignment.id).catch((e) => notifyError(e));
  return (
    <>
      <Button
        component={Link}
        to={`/teacher/assignments/${assignment.id}/edit`}
        variant="default"
        leftSection={<IconPencil size={16} />}
      >
        Edit
      </Button>
      {assignment.gradingMode === 'auto' && (
        <Tooltip label={submitted ? 'Grade every submission again with the current key' : 'Nothing to grade yet'}>
          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            loading={regrade.isPending}
            data-disabled={submitted === 0 || undefined}
            aria-disabled={submitted === 0}
            onClick={() => submitted > 0 && regrade.confirm(submitted)}
          >
            Re-run autograder
          </Button>
        </Tooltip>
      )}
      <Menu position="bottom-end" width={230}>
        <Menu.Target>
          <ActionIcon variant="default" size="lg" aria-label="More assignment actions">
            <IconDots size={18} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Files</Menu.Label>
          <Menu.Item
            leftSection={<IconKey size={16} />}
            disabled={!assignment.key}
            onClick={() => download(endpoints.downloadKey)}
          >
            Download answer key
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFileSpreadsheet size={16} />}
            disabled={!assignment.template}
            onClick={() => download(endpoints.downloadTemplate)}
          >
            Download starter file
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={onDelete}>
            Delete assignment
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}

function AboutCard({ assignment }: { assignment: AssignmentDetail }) {
  if (!assignment.description.trim() && !assignment.template) return null;
  return (
    <Card>
      <Stack gap="sm">
        {assignment.description.trim() && (
          <>
            <Title order={3} fz="h5">
              Instructions
            </Title>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {assignment.description}
            </Text>
          </>
        )}
        {assignment.template && (
          <Group gap="xs">
            <IconFileSpreadsheet size={16} color="var(--mantine-color-dimmed)" />
            <Text size="sm" c="dimmed">
              Starter file for students:
            </Text>
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconDownload size={14} />}
              onClick={() => endpoints.downloadTemplate(assignment.id).catch((e) => notifyError(e))}
            >
              {assignment.template.name}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function AssignmentView({ data }: { data: AssignmentSubmissionsResponse }) {
  const { assignment, rows } = data;
  const [searchParams, setSearchParams] = useSearchParams();
  const [deleteOpened, deleteHandlers] = useDisclosure(false);
  const [uploadFor, setUploadFor] = useState<StudentInfo | null>(null);
  const [uploadOpened, uploadHandlers] = useDisclosure(false);
  usePageTitle(assignment.title);

  const filterParam = searchParams.get('filter');
  const filter: SubmissionFilter = isSubmissionFilter(filterParam) ? filterParam : 'all';
  const search = searchParams.get('q') ?? '';
  const updateParams = (patch: Record<string, string | null>) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  // The debounced URL write below must merge into the current params, not those of the render that scheduled it.
  const updateParamsRef = useRef(updateParams);
  useEffect(() => {
    updateParamsRef.current = updateParams;
  });

  // The search box is local state: URL updates run in a router transition, so binding the input to the URL
  // made the caret jump and dropped keystrokes. The URL (?q=) follows after a short pause.
  const [searchInput, setSearchInput] = useState(search);
  const syncedSearchRef = useRef(search);
  const searchTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    // Our own debounced write coming back: the input is already ahead of it.
    if (search === syncedSearchRef.current) return;
    // Changed from outside (Back/Forward, a link with ?q=): show it and drop any pending write.
    syncedSearchRef.current = search;
    window.clearTimeout(searchTimerRef.current);
    setSearchInput(search);
  }, [search]);
  useEffect(() => () => window.clearTimeout(searchTimerRef.current), []);

  const changeSearch = (value: string) => {
    setSearchInput(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      syncedSearchRef.current = value;
      updateParamsRef.current({ q: value || null });
    }, SEARCH_URL_DELAY_MS);
  };

  /** Switch the filter (null = everyone) and clear the search, in one URL update. */
  const showFilter = (f: SubmissionFilter | null) => {
    window.clearTimeout(searchTimerRef.current);
    syncedSearchRef.current = '';
    setSearchInput('');
    updateParams({ filter: f === 'all' ? null : f, q: null });
  };

  const stats = computeStats(rows);
  const pastDue = isPast(assignment.dueAt);
  const autoErrors = rows.filter((r) => r.latest?.autoStatus === 'error').length;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: assignment.className, to: `/teacher/classes/${assignment.classId}` },
          { label: assignment.title },
        ]}
        title={assignment.title}
        badges={
          <>
            <GradingModeBadge mode={assignment.gradingMode} />
            {pastDue && <PastDueBadge />}
          </>
        }
        subtitle={
          <>
            Due {formatDateTime(assignment.dueAt)} ({fromNow(assignment.dueAt)}) ·{' '}
            {formatScore(assignment.points)} point{assignment.points === 1 ? '' : 's'}
          </>
        }
        actions={<HeaderActions assignment={assignment} submitted={stats.submitted} onDelete={deleteHandlers.open} />}
      />

      <Stack gap="lg">
        <AssignmentStats
          stats={stats}
          points={assignment.points}
          onFilter={showFilter}
        />

        {assignment.gradingMode === 'manual' && (
          <Alert color="indigo" variant="light" icon={<IconEye />} title="This assignment is graded manually">
            Open any submission to see the student's workbook in the built-in viewer, then enter a score and feedback.
            Want scores filled in for you?{' '}
            <Text
              component={Link}
              to={`/teacher/assignments/${assignment.id}/edit`}
              inherit
              c="indigo"
              fw={600}
              td="underline"
            >
              Add an answer key
            </Text>{' '}
            to switch to autograding.
          </Alert>
        )}

        {autoErrors > 0 && (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle />} title="Some files couldn't be autograded">
            <Group justify="space-between" gap="sm">
              <Text size="sm">
                {autoErrors} submission{autoErrors === 1 ? '' : 's'} couldn't be read by the autograder and{' '}
                {autoErrors === 1 ? 'is' : 'are'} waiting for you to grade by hand.
              </Text>
              <Button
                size="xs"
                color="orange"
                variant="light"
                onClick={() => showFilter('needs_grading')}
              >
                Show them
              </Button>
            </Group>
          </Alert>
        )}

        <AboutCard assignment={assignment} />

        {assignment.gradingMode === 'auto' && <AnswerKeySection assignment={assignment} />}

        <SubmissionsTable
          assignment={assignment}
          rows={rows}
          filter={filter}
          onFilterChange={(f) => updateParams({ filter: f === 'all' ? null : f })}
          search={searchInput}
          onSearchChange={changeSearch}
          onReset={() => showFilter(null)}
          onUploadFor={(student) => {
            setUploadFor(student);
            uploadHandlers.open();
          }}
        />
      </Stack>

      <UploadOnBehalfModal
        opened={uploadOpened}
        onClose={uploadHandlers.close}
        assignment={assignment}
        student={uploadFor}
      />
      <DeleteAssignmentModal
        opened={deleteOpened}
        onClose={deleteHandlers.close}
        assignment={assignment}
        submissionCount={stats.submitted}
      />
    </>
  );
}

/** /teacher/assignments/:assignmentId — overview of one assignment and every student's submission. */
export function TeacherAssignmentPage() {
  const assignmentId = parseId(useParams().assignmentId);
  const query = useQuery({
    queryKey: qk.assignmentSubmissions(assignmentId ?? 0),
    queryFn: () => endpoints.listAssignmentSubmissions(assignmentId ?? 0),
    enabled: assignmentId !== null,
  });
  if (assignmentId === null) return <AssignmentNotFound />;
  if (query.isPending) return <PageLoader label="Loading submissions…" />;
  if (isNotFoundError(query.error)) return <AssignmentNotFound />;
  if (query.error || !query.data) return <ErrorAlert error={query.error} onRetry={() => query.refetch()} />;
  return <AssignmentView key={assignmentId} data={query.data} />;
}
