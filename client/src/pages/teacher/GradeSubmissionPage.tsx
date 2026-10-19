import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Card, Grid, Group, Select, Skeleton, Stack, Text, Title, Tooltip } from '@mantine/core';
import { useDisclosure, useHotkeys } from '@mantine/hooks';
import {
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
  IconHistory,
  IconPointer,
  IconUserOff,
} from '@tabler/icons-react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import type { AssignmentSubmissionsResponse, SubmissionDetail, SubmissionRow } from '@shared/types';
import { endpoints, qk } from '../../api/endpoints';
import { GradeReportView } from '../../components/GradeReportView';
import { isNotFoundError } from '../../components/NotFoundCard';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, PageLoader } from '../../components/QueryState';
import type { CellFocus } from '../../components/SpreadsheetViewer';
import { LateAlert, LateBadge, PendingBadge, TeacherStatusBadge } from '../../components/StatusBadges';
import { formatDateTime, isPast } from '../../utils/format';
import { parseId } from '../../utils/params';
import { usePageTitle } from '../../utils/usePageTitle';
import { AssignmentNotFound } from './assignment/AssignmentNotFound';
import { GradingPanel } from './assignment/GradingPanel';
import { NoSubmissionCard } from './assignment/NoSubmissionCard';
import { StickyPanel } from './assignment/StickyPanel';
import { UploadOnBehalfModal } from './assignment/UploadOnBehalfModal';
import { useUnsavedChangesGuard } from './assignment/useUnsavedChangesGuard';
import { WorkbookPanel, type WorkbookView } from './assignment/WorkbookPanel';

/** The next row after `index` (wrapping around) whose latest submission still needs a score. */
function findNextNeedsGrading(rows: SubmissionRow[], index: number): SubmissionRow | null {
  for (let step = 1; step <= rows.length; step++) {
    const i = (index + step + rows.length) % rows.length;
    if (i !== index && rows[i].status === 'needs_grading') return rows[i];
  }
  return null;
}

function attemptLabel(s: SubmissionDetail, isLatest: boolean) {
  return `Attempt ${s.attempt}${isLatest ? ' (latest)' : ''}`;
}

function WorkspaceSkeleton() {
  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, lg: 8 }}>
        <Card>
          <Skeleton h={32} w={320} mb="md" />
          <Skeleton h={480} />
        </Card>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 4 }}>
        <Card>
          <Stack>
            <Skeleton h={28} w="50%" />
            <Skeleton h={70} />
            <Skeleton h={40} />
            <Skeleton h={110} />
            <Skeleton h={36} />
          </Stack>
        </Card>
      </Grid.Col>
    </Grid>
  );
}

function GradeWorkspace({
  data,
  studentId,
  attemptsQ,
  view,
  onViewChange,
}: {
  data: AssignmentSubmissionsResponse;
  studentId: number;
  attemptsQ: UseQueryResult<SubmissionDetail[]>;
  view: WorkbookView;
  onViewChange: (view: WorkbookView) => void;
}) {
  const { assignment, rows } = data;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const viewerRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focus, setFocus] = useState<CellFocus | null>(null);
  const [dirty, setDirty] = useState(false);
  const [uploadOpened, uploadHandlers] = useDisclosure(false);

  const index = rows.findIndex((r) => r.student.id === studentId);
  const row = index >= 0 ? rows[index] : null;
  const attempts = attemptsQ.data ?? [];
  const studentName = row?.student.name ?? attempts[0]?.studentName ?? 'Student';
  const student = { id: studentId, name: studentName, pending: !!row?.student.pending };
  const prev = index > 0 ? rows[index - 1] : null;
  const next = index >= 0 && index < rows.length - 1 ? rows[index + 1] : null;
  const nextNeeds = findNextNeedsGrading(rows, index);
  const saveNextTarget = nextNeeds ?? next;

  const latest = attempts[0] ?? null;
  const selected = attempts.find((s) => s.id === selectedId) ?? latest;
  const viewingOlder = !!selected && !!latest && selected.id !== latest.id;

  usePageTitle(`Grading ${studentName} · ${assignment.title}`);

  const { guard, bypass } = useUnsavedChangesGuard(dirty, {
    message: `Your score and feedback for ${studentName} haven't been saved. Leave without saving?`,
  });

  const gradeUrl = (id: number) => `/teacher/assignments/${assignment.id}/grade/${id}`;
  const goTo = (target: SubmissionRow | null) => {
    if (target) guard(() => navigate(gradeUrl(target.student.id)));
  };

  useHotkeys([
    ['[', () => goTo(prev)],
    [']', () => goTo(next)],
    ['alt+ArrowLeft', () => goTo(prev)],
    ['alt+ArrowRight', () => goTo(next)],
  ]);

  // Warm the cache so Prev / Next feel instant.
  const neighborIds = [prev, next, nextNeeds].filter((r): r is SubmissionRow => !!r?.latest).map((r) => r.student.id);
  const neighborKey = neighborIds.join(',');
  useEffect(() => {
    for (const id of neighborKey ? neighborKey.split(',').map(Number) : []) {
      void qc.prefetchQuery({
        queryKey: qk.studentSubmissions(assignment.id, id),
        queryFn: () => endpoints.listStudentSubmissions(assignment.id, id),
        staleTime: 15_000,
      });
    }
  }, [neighborKey, assignment.id, qc]);

  const handleCellClick = (sheet: string, address: string) => {
    // `sheet` is the key's sheet name; the student viewer maps it to the matching student sheet itself.
    setFocus({ sheet, address });
    const studentSheet = selected?.report?.sheets.find((s) => s.keySheet === sheet)?.studentSheet ?? null;
    if (!studentSheet && view === 'student' && assignment.key) onViewChange('key');
    // After the viewer has scrolled the cell into view inside its grid, bring the whole viewer card on screen.
    window.setTimeout(() => viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
  };

  const selectAttempt = (id: number) => guard(() => setSelectedId(id));

  // Side by side needs the full width (at 8/12 of a laptop screen the two panes would stack).
  const sideBySide = view === 'side' && !!assignment.key;

  const position = index >= 0 ? `Student ${index + 1} of ${rows.length}` : 'Not enrolled in this class';
  const subtitle = row ? `${row.student.email} · ${position}` : position;

  const navControls = (
    <Group gap="xs" wrap="wrap">
      {attempts.length > 1 && selected && (
        <Select
          aria-label="Attempt"
          leftSection={<IconHistory size={16} />}
          w={210}
          allowDeselect={false}
          value={String(selected.id)}
          onChange={(v) => v && selectAttempt(Number(v))}
          data={attempts.map((s, i) => ({ value: String(s.id), label: attemptLabel(s, i === 0) }))}
          renderOption={({ option }) => {
            const s = attempts.find((a) => String(a.id) === option.value);
            return (
              <Stack gap={0}>
                <Group gap={6}>
                  <Text size="sm">{option.label}</Text>
                  {s && <LateBadge late={s.late} size="xs" />}
                </Group>
                {s && (
                  <Text size="xs" c="dimmed">
                    {formatDateTime(s.submittedAt)}
                  </Text>
                )}
              </Stack>
            );
          }}
        />
      )}
      <Button.Group>
        <Tooltip label="Previous student  [  or  Alt+←">
          <Button
            variant="default"
            leftSection={<IconChevronLeft size={16} />}
            disabled={!prev}
            onClick={() => goTo(prev)}
            aria-label={prev ? `Previous student: ${prev.student.name}` : 'Previous student'}
          >
            Prev
          </Button>
        </Tooltip>
        <Tooltip label="Next student  ]  or  Alt+→">
          <Button
            variant="default"
            rightSection={<IconChevronRight size={16} />}
            disabled={!next}
            onClick={() => goTo(next)}
            aria-label={next ? `Next student: ${next.student.name}` : 'Next student'}
          >
            Next
          </Button>
        </Tooltip>
      </Button.Group>
      <Tooltip label={nextNeeds ? `Open ${nextNeeds.student.name}` : 'Nothing else needs grading'}>
        <Button
          variant="light"
          color="orange"
          rightSection={<IconArrowRight size={16} />}
          data-disabled={!nextNeeds || undefined}
          aria-disabled={!nextNeeds}
          onClick={() => goTo(nextNeeds)}
        >
          Next needs grading
        </Button>
      </Tooltip>
    </Group>
  );

  let body;
  if (attemptsQ.isPending) {
    body = <WorkspaceSkeleton />;
  } else if (attemptsQ.error) {
    body = (
      <ErrorAlert
        error={attemptsQ.error}
        onRetry={() => attemptsQ.refetch()}
        title="Couldn't load this student's submissions"
      />
    );
  } else if (!selected) {
    body = <NoSubmissionCard assignment={assignment} student={student} />;
  } else {
    const report = selected.report && (
      <Card>
        <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
          <Title order={3} fz="h4">
            Cell-by-cell report
          </Title>
          <Group gap={4}>
            <IconPointer size={14} color="var(--mantine-color-dimmed)" />
            <Text size="xs" c="dimmed">
              Click a row to jump to that cell
            </Text>
          </Group>
        </Group>
        <GradeReportView key={selected.id} report={selected.report} showExpected onCellClick={handleCellClick} />
      </Card>
    );
    // Side by side: the workbook gets its own full-width row, then the report and the grading panel. The columns
    // are keyed so switching views moves the report without remounting the grading panel (and losing the draft).
    const panelAlone = sideBySide && !report;
    body = (
      <Grid gap="lg">
        <Grid.Col key="workbook" span={{ base: 12, lg: sideBySide ? 12 : 8 }}>
          <Stack gap="lg">
            <WorkbookPanel
              ref={viewerRef}
              assignment={assignment}
              submission={selected}
              view={view}
              onViewChange={onViewChange}
              focus={focus}
              // Uploading switches to the new attempt, which resets the grading draft: confirm that first.
              onUploadNew={() => guard(uploadHandlers.open)}
            />
            {!sideBySide && report}
          </Stack>
        </Grid.Col>
        {sideBySide && report && (
          <Grid.Col key="report" span={{ base: 12, lg: 8 }}>
            {report}
          </Grid.Col>
        )}
        <Grid.Col key="panel" span={{ base: 12, lg: panelAlone ? 12 : 4 }}>
          <StickyPanel enabled={!panelAlone}>
            <GradingPanel
              key={selected.id}
              assignment={assignment}
              submission={selected}
              attemptCount={attempts.length}
              latest={viewingOlder ? latest : null}
              onSelectLatest={() => latest && selectAttempt(latest.id)}
              onDirtyChange={setDirty}
              nextName={saveNextTarget?.student.name ?? null}
              // The grade was just saved, so leave without the unsaved-changes prompt.
              onNext={() =>
                bypass(() =>
                  navigate(
                    saveNextTarget ? gradeUrl(saveNextTarget.student.id) : `/teacher/assignments/${assignment.id}`,
                  ),
                )
              }
            />
          </StickyPanel>
        </Grid.Col>
      </Grid>
    );
  }

  return (
    <>
      {selected?.late && (
        <Box mb="md">
          <LateAlert
            late={selected.late}
            lateBySeconds={selected.lateBySeconds}
            dueAt={assignment.dueAt}
            submittedAt={selected.submittedAt}
          />
        </Box>
      )}
      <PageHeader
        crumbs={[
          { label: assignment.className, to: `/teacher/classes/${assignment.classId}` },
          { label: assignment.title, to: `/teacher/assignments/${assignment.id}` },
          { label: studentName },
        ]}
        title={studentName}
        badges={
          <>
            {row && <TeacherStatusBadge status={row.status} pastDue={isPast(assignment.dueAt)} size="md" />}
            {row && <PendingBadge pending={row.student.pending} size="md" />}
            {selected && <LateBadge late={selected.late} lateBySeconds={selected.lateBySeconds} size="md" />}
          </>
        }
        subtitle={subtitle}
        actions={navControls}
      />
      {!row && (
        <Alert color="yellow" variant="light" icon={<IconUserOff />} mb="lg" title="Not enrolled">
          {studentName} isn't enrolled in {assignment.className} anymore. Their submissions are kept, but they won't
          appear in the submissions list.
        </Alert>
      )}
      {body}
      {selected && (
        <UploadOnBehalfModal
          opened={uploadOpened}
          onClose={uploadHandlers.close}
          assignment={assignment}
          student={student}
          onUploaded={(submission) => setSelectedId(submission.id)}
        />
      )}
    </>
  );
}

/** /teacher/assignments/:assignmentId/grade/:studentId — the grading workspace for one student. */
export function GradeSubmissionPage() {
  const params = useParams();
  const assignmentId = parseId(params.assignmentId);
  const studentId = parseId(params.studentId);
  const valid = assignmentId !== null && studentId !== null;
  const [view, setView] = useState<WorkbookView>('student');

  const subsQ = useQuery({
    queryKey: qk.assignmentSubmissions(assignmentId ?? 0),
    queryFn: () => endpoints.listAssignmentSubmissions(assignmentId ?? 0),
    enabled: valid,
  });
  const attemptsQ = useQuery({
    queryKey: qk.studentSubmissions(assignmentId ?? 0, studentId ?? 0),
    queryFn: () => endpoints.listStudentSubmissions(assignmentId ?? 0, studentId ?? 0),
    enabled: valid,
  });

  if (!valid) return <AssignmentNotFound />;
  if (subsQ.isPending) return <PageLoader label="Loading submissions…" />;
  if (isNotFoundError(subsQ.error)) return <AssignmentNotFound />;
  if (subsQ.error || !subsQ.data) return <ErrorAlert error={subsQ.error} onRetry={() => subsQ.refetch()} />;
  if (isNotFoundError(attemptsQ.error)) {
    return (
      <AssignmentNotFound
        title="Student not found"
        description="This student doesn't exist, or the link is not quite right. Open the assignment to pick a student."
      />
    );
  }
  return (
    <GradeWorkspace
      key={`${assignmentId}-${studentId}`}
      data={subsQ.data}
      studentId={studentId}
      attemptsQ={attemptsQ}
      view={view}
      onViewChange={setView}
    />
  );
}
