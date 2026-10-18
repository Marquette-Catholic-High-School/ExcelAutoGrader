import { useEffect, useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Blockquote,
  Button,
  Card,
  EmptyState,
  Grid,
  Group,
  RingProgress,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconClockExclamation,
  IconDownload,
  IconFileOff,
  IconHourglass,
  IconMessageCircle,
  IconPencil,
  IconRobot,
  IconUpload,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { AssignmentDetail, StudentAssignmentStatus, SubmissionDetail } from '@shared/types';
import { endpoints, qk } from '../../api/endpoints';
import { PastDueBadge } from '../../components/AssignmentBadges';
import { FileDropzone } from '../../components/FileDropzone';
import { GradeReportView } from '../../components/GradeReportView';
import { isNotFoundError, NotFoundCard } from '../../components/NotFoundCard';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, PageLoader } from '../../components/QueryState';
import { SubmissionWorkbookViewer, type CellFocus } from '../../components/SpreadsheetViewer';
import {
  BADGE_NO_SHRINK,
  GradingModeBadge,
  LateAlert,
  LateBadge,
  StudentStatusBadge,
} from '../../components/StatusBadges';
import { errorMessage, notifyError, notifySuccess } from '../../utils/errors';
import {
  formatDateTime,
  formatFileSize,
  formatScore,
  formatScoreOf,
  fromNow,
  percent,
  scoreColor,
} from '../../utils/format';
import { parseId } from '../../utils/params';
import { usePageTitle } from '../../utils/usePageTitle';

/** Re-renders periodically so "past due" and relative times stay correct while the page is open. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Runs a download, tracking its progress and reporting failures. */
function useDownload(): [boolean, (fn: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch((err) => notifyError(err, 'Download failed'))
      .finally(() => setBusy(false));
  };
  return [busy, run];
}

function DownloadButton({ label, download }: { label: string; download: () => Promise<void> }) {
  const [busy, run] = useDownload();
  return (
    <Button variant="default" leftSection={<IconDownload size={16} />} loading={busy} onClick={() => run(download)}>
      {label}
    </Button>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function studentStatus(latest: SubmissionDetail | undefined, pastDue: boolean): StudentAssignmentStatus {
  if (!latest) return pastDue ? 'missing' : 'not_submitted';
  return latest.finalScore !== null ? 'graded' : 'submitted';
}

function notifySubmitted(sub: SubmissionDetail) {
  const title = `${sub.late ? 'Submitted late' : 'Submitted'} — attempt #${sub.attempt}`;
  if (sub.autoStatus === 'graded' && sub.finalScore !== null) {
    const pct = percent(sub.finalScore, sub.pointsPossible);
    const score = formatScoreOf(sub.finalScore, sub.pointsPossible);
    notifySuccess(`Autograded score: ${score}${pct === null ? '' : ` (${pct}%)`}`, title);
  } else if (sub.autoStatus === 'error') {
    notifications.show({
      color: 'yellow',
      title,
      message: "The autograder couldn't check this file, so your teacher will grade it by hand.",
    });
  } else {
    notifySuccess('Your teacher will review your workbook and grade it.', title);
  }
}

export function StudentAssignmentPage() {
  const assignmentId = parseId(useParams().assignmentId);
  const now = useNow();

  const assignment = useQuery({
    queryKey: qk.assignment(assignmentId ?? 0),
    queryFn: () => endpoints.getAssignment(assignmentId ?? 0),
    enabled: assignmentId !== null,
  });
  const submissions = useQuery({
    queryKey: qk.mySubmissions(assignmentId ?? 0),
    queryFn: () => endpoints.listMySubmissions(assignmentId ?? 0),
    enabled: assignmentId !== null,
  });
  usePageTitle(assignment.data?.title ?? 'Assignment');

  if (assignmentId === null) return <NotFound />;
  if (assignment.isPending) return <PageLoader label="Loading assignment…" />;
  if (assignment.isError) {
    if (isNotFoundError(assignment.error)) return <NotFound />;
    return <ErrorAlert error={assignment.error} onRetry={() => assignment.refetch()} />;
  }

  const a = assignment.data;
  const pastDue = new Date(a.dueAt).getTime() < now;
  const subs = submissions.data ?? [];
  const latest = subs[0];
  const status = studentStatus(latest, pastDue);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Dashboard', to: '/student' },
          { label: a.className, to: `/student/classes/${a.classId}` },
          { label: a.title },
        ]}
        title={a.title}
        badges={
          <>
            <GradingModeBadge mode={a.gradingMode} />
            {submissions.isSuccess && <StudentStatusBadge status={status} />}
            {pastDue && <PastDueBadge />}
          </>
        }
        subtitle={
          <>
            {pastDue ? 'Was due' : 'Due'} {formatDateTime(a.dueAt)} ({fromNow(a.dueAt)}) · {plural(a.points, 'point')}
          </>
        }
        actions={
          a.template && (
            <DownloadButton label="Download starter file" download={() => endpoints.downloadTemplate(a.id)} />
          )
        }
      />

      <Stack gap="lg">
        <Grid gap="lg">
          <Grid.Col span={{ base: 12, md: 7 }}>
            <AboutCard assignment={a} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 5 }}>
            <SubmitCard key={a.id} assignment={a} pastDue={pastDue} attemptCount={subs.length} />
          </Grid.Col>
        </Grid>

        {submissions.isPending ? (
          <Card>
            <Stack gap="sm">
              <Skeleton h={22} w={220} />
              <Skeleton h={110} />
              <Skeleton h={22} w={160} />
            </Stack>
          </Card>
        ) : submissions.isError ? (
          <ErrorAlert
            error={submissions.error}
            title="Could not load your submissions"
            onRetry={() => submissions.refetch()}
          />
        ) : latest ? (
          <>
            <LatestResultCard key={latest.id} assignment={a} latest={latest} />
            <AttemptHistory submissions={subs} />
          </>
        ) : (
          <Card>
            <EmptyState
              icon={<IconUpload size={30} />}
              title="Nothing submitted yet"
              description={
                pastDue
                  ? 'This assignment is past due, but you can still upload your workbook. It will be marked late.'
                  : 'Upload your finished workbook above. Your score and feedback will show up here.'
              }
            />
          </Card>
        )}
      </Stack>
    </>
  );
}

function NotFound() {
  return (
    <NotFoundCard
      icon={<IconFileOff size={32} />}
      title="Assignment not found"
      description="It may have been deleted, or you might not be enrolled in this class."
      home="/student"
    />
  );
}

function AboutCard({ assignment: a }: { assignment: AssignmentDetail }) {
  const auto = a.gradingMode === 'auto';
  const showsDetails = a.studentVisibility?.showDetailsToStudents ?? false;
  return (
    <Card h="100%">
      <Stack gap="md">
        <Title order={4}>Instructions</Title>
        {a.description.trim() ? (
          <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.description}</Text>
        ) : (
          <Text c="dimmed" fs="italic">
            Your teacher didn't add written instructions for this assignment.
          </Text>
        )}
        <Alert
          variant="light"
          color={auto ? 'brand' : 'indigo'}
          icon={auto ? <IconRobot /> : <IconPencil />}
          title={auto ? 'Autograded' : 'Graded by your teacher'}
        >
          {auto ? (
            <>
              Autograded — you'll see your score as soon as you upload. You can resubmit; your latest upload counts.
              {showsDetails && ' You will also see which cells are right and which need another look.'}
            </>
          ) : (
            'Your teacher will review your workbook and grade it.'
          )}
        </Alert>
        {a.template && (
          <Text size="sm" c="dimmed">
            Starter file: <strong>{a.template.name}</strong> ({formatFileSize(a.template.size)}). Download it from the top
            of this page, fill it in, then upload it here.
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function SubmitCard({
  assignment: a,
  pastDue,
  attemptCount,
}: {
  assignment: AssignmentDetail;
  pastDue: boolean;
  attemptCount: number;
}) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const submit = useMutation({
    mutationFn: (f: File) => endpoints.submit(a.id, f),
    onSuccess: (sub) => {
      notifySubmitted(sub);
      setFile(null);
      void qc.invalidateQueries({ queryKey: qk.mySubmissions(a.id) });
      void qc.invalidateQueries({ queryKey: qk.assignment(a.id) });
      void qc.invalidateQueries({ queryKey: qk.classAssignments(a.classId) });
      void qc.invalidateQueries({ queryKey: qk.myAssignments });
    },
  });

  return (
    <Card h="100%">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Title order={4}>{attemptCount > 0 ? 'Submit a new attempt' : 'Submit your work'}</Title>
          {attemptCount > 0 && (
            <Badge variant="light" color="gray" {...BADGE_NO_SHRINK}>
              {plural(attemptCount, 'attempt')} so far
            </Badge>
          )}
        </Group>
        {pastDue && (
          <Alert color="red" variant="light" icon={<IconClockExclamation />} title="This assignment is past due">
            This assignment was due {formatDateTime(a.dueAt)} ({fromNow(a.dueAt)}). You can still submit, but it will be
            marked LATE.
          </Alert>
        )}
        <FileDropzone
          file={file}
          onFile={(f) => {
            setFile(f);
            submit.reset();
          }}
          onClear={() => {
            setFile(null);
            submit.reset();
          }}
          loading={submit.isPending}
          error={submit.isError ? errorMessage(submit.error) : null}
        />
        <Button
          size="md"
          fullWidth
          color={pastDue ? 'red' : undefined}
          leftSection={pastDue ? <IconClockExclamation size={18} /> : <IconUpload size={18} />}
          disabled={!file}
          loading={submit.isPending}
          onClick={() => file && submit.mutate(file)}
        >
          {pastDue ? 'Submit late' : 'Submit'}
        </Button>
        <Text size="xs" c="dimmed" ta="center">
          {submit.isPending
            ? a.gradingMode === 'auto'
              ? 'Uploading and autograding your workbook…'
              : 'Uploading your workbook…'
            : attemptCount > 0
              ? `This will be attempt #${attemptCount + 1}. Your latest upload is the one that counts.`
              : 'You can resubmit later — your latest upload is the one that counts.'}
        </Text>
      </Stack>
    </Card>
  );
}

function LatestResultCard({ assignment: a, latest }: { assignment: AssignmentDetail; latest: SubmissionDetail }) {
  const [focus, setFocus] = useState<CellFocus | null>(null);
  const status = studentStatus(latest, false);
  const byOther = latest.submittedByName !== latest.studentName;

  return (
    <Card>
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Group gap="xs">
              <Title order={4}>Your latest submission</Title>
              <StudentStatusBadge status={status} />
              <LateBadge late={latest.late} lateBySeconds={latest.lateBySeconds} />
            </Group>
            <Text size="sm" c="dimmed">
              Attempt #{latest.attempt} · {latest.file.name} · submitted {formatDateTime(latest.submittedAt)} (
              {fromNow(latest.submittedAt)}){byOther && ` by ${latest.submittedByName}`}
            </Text>
          </Stack>
          <DownloadButton label="Download my file" download={() => endpoints.downloadSubmission(latest.id)} />
        </Group>

        <LateAlert
          late={latest.late}
          lateBySeconds={latest.lateBySeconds}
          dueAt={a.dueAt}
          submittedAt={latest.submittedAt}
        />

        <ScoreSummary submission={latest} />

        {latest.feedback.trim() && (
          <div>
            <Text fw={600} mb="xs">
              Feedback from your teacher
            </Text>
            <Blockquote
              color="brand"
              icon={<IconMessageCircle size={20} />}
              iconSize={36}
              mt="lg"
              p="md"
              cite={
                latest.gradedByName
                  ? `— ${latest.gradedByName}${latest.gradedAt ? `, ${formatDateTime(latest.gradedAt)}` : ''}`
                  : undefined
              }
            >
              <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{latest.feedback}</Text>
            </Blockquote>
          </div>
        )}

        {latest.report ? (
          <div>
            <Group justify="space-between" align="baseline" mb="sm" gap="xs">
              <Title order={5}>Cell-by-cell results</Title>
              <Text size="xs" c="dimmed">
                Click a cell to find it in your workbook below
              </Text>
            </Group>
            <GradeReportView
              report={latest.report}
              showExpected={a.studentVisibility?.showExpectedToStudents ?? false}
              answerLabel="Your answer"
              onCellClick={(sheet, address) => setFocus({ sheet, address })}
            />
          </div>
        ) : (
          latest.autoStatus === 'graded' && (
            <Text size="sm" c="dimmed">
              Your teacher has turned off the cell-by-cell details for this assignment.
            </Text>
          )
        )}

        <div>
          <Title order={5} mb="sm">
            Your workbook
          </Title>
          <SubmissionWorkbookViewer submissionId={latest.id} report={latest.report} focus={focus} height={460} />
        </div>
      </Stack>
    </Card>
  );
}

function ScoreSummary({ submission: s }: { submission: SubmissionDetail }) {
  if (s.finalScore !== null) {
    const pct = percent(s.finalScore, s.pointsPossible) ?? 0;
    let source: ReactNode;
    if (s.overrideScore !== null) {
      source = `Graded by ${s.gradedByName ?? 'your teacher'}${s.gradedAt ? ` on ${formatDateTime(s.gradedAt)}` : ''}`;
      if (s.autoScore !== null && s.autoScore !== s.overrideScore) {
        source = `${source} · the autograder gave ${formatScore(s.autoScore)}`;
      }
    } else {
      source = s.report
        ? `Autograded · ${s.report.correct} of ${plural(s.report.total, 'cell')} correct`
        : 'Autograded';
    }
    return (
      <Group gap="lg" wrap="nowrap">
        <RingProgress
          size={112}
          thickness={10}
          roundCaps
          sections={[{ value: Math.min(100, pct), color: scoreColor(pct) }]}
          label={
            <Text ta="center" fw={700}>
              {pct}%
            </Text>
          }
          aria-label={`Score ${pct}%`}
        />
        <div>
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            Score
          </Text>
          <Text fz={36} fw={800} lh={1.1}>
            {formatScore(s.finalScore)}{' '}
            <Text span fz="xl" fw={500} c="dimmed">
              / {formatScore(s.pointsPossible)}
            </Text>
          </Text>
          <Text size="sm" c="dimmed" mt={4}>
            {source}
          </Text>
        </div>
      </Group>
    );
  }

  if (s.autoStatus === 'error') {
    return (
      <Alert color="yellow" variant="light" icon={<IconAlertTriangle />} title="This file couldn't be autograded">
        <Stack gap={4}>
          {s.autoError && <Text size="sm">{s.autoError}</Text>}
          <Text size="sm">Your teacher will grade this one by hand.</Text>
        </Stack>
      </Alert>
    );
  }

  return (
    <Group gap="md" wrap="nowrap">
      <ThemeIcon size={52} radius="xl" variant="light" color="blue">
        <IconHourglass size={26} />
      </ThemeIcon>
      <div>
        <Text fw={600} size="lg">
          Waiting for your teacher to grade
        </Text>
        <Text size="sm" c="dimmed">
          Your score and any feedback will appear here once it's graded.
        </Text>
      </div>
    </Group>
  );
}

function ScoreCell({ s }: { s: SubmissionDetail }) {
  if (s.finalScore !== null) {
    const pct = percent(s.finalScore, s.pointsPossible);
    return (
      <div>
        <Text size="sm" fw={600}>
          {formatScoreOf(s.finalScore, s.pointsPossible)}
        </Text>
        {pct !== null && (
          <Text size="xs" c="dimmed">
            {pct}%
          </Text>
        )}
      </div>
    );
  }
  if (s.autoStatus === 'error') {
    return (
      <Badge color="orange" variant="light" {...BADGE_NO_SHRINK}>
        Teacher will grade
      </Badge>
    );
  }
  return (
    <Text size="sm" c="dimmed">
      Not graded yet
    </Text>
  );
}

function AttemptDownload({ s }: { s: SubmissionDetail }) {
  const [busy, run] = useDownload();
  return (
    <Tooltip label={`Download attempt #${s.attempt}`}>
      <ActionIcon
        variant="subtle"
        color="gray"
        loading={busy}
        onClick={() => run(() => endpoints.downloadSubmission(s.id))}
        aria-label={`Download attempt #${s.attempt}`}
      >
        <IconDownload size={18} />
      </ActionIcon>
    </Tooltip>
  );
}

function AttemptHistory({ submissions }: { submissions: SubmissionDetail[] }) {
  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Title order={4}>Attempt history</Title>
        <Text size="sm" c="dimmed">
          {plural(submissions.length, 'attempt')} · the latest one counts
        </Text>
      </Group>
      <Table.ScrollContainer minWidth={640} type="native">
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Attempt</Table.Th>
              <Table.Th>Submitted</Table.Th>
              <Table.Th>Timing</Table.Th>
              <Table.Th>File</Table.Th>
              <Table.Th>Score</Table.Th>
              <Table.Th w={56}>
                <VisuallyHidden>Download</VisuallyHidden>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {submissions.map((s, i) => (
              <Table.Tr key={s.id}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text fw={600}>#{s.attempt}</Text>
                    {i === 0 && (
                      <Badge size="xs" variant="light" {...BADGE_NO_SHRINK}>
                        Latest
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{formatDateTime(s.submittedAt)}</Text>
                  <Text size="xs" c="dimmed">
                    {fromNow(s.submittedAt)}
                    {s.submittedByName !== s.studentName && ` · uploaded by ${s.submittedByName}`}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {s.late ? (
                    <LateBadge late lateBySeconds={s.lateBySeconds} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      On time
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" truncate="end" maw={220} title={s.file.name}>
                    {s.file.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatFileSize(s.file.size)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <ScoreCell s={s} />
                </Table.Td>
                <Table.Td>
                  <AttemptDownload s={s} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
