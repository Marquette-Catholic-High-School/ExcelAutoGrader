import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Group,
  NumberInput,
  Paper,
  Progress,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowRight,
  IconCheck,
  IconDeviceFloppy,
  IconHistory,
  IconPencil,
  IconRobot,
} from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AssignmentDetail, GradeSubmissionRequest, SubmissionDetail } from '@shared/types';
import { endpoints, qk } from '../../../api/endpoints';
import { fieldErrors, notifyError, notifySuccess } from '../../../utils/errors';
import {
  formatDateTime,
  formatFileSize,
  formatScore,
  fromNow,
  percent,
  scoreColor,
  scoreTextColor,
} from '../../../utils/format';
import { invalidateSubmissions } from './cache';
import { ShortcutHint } from './ShortcutHint';
import classes from './assignment.module.css';

function parseScore(value: number | string): number | null {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed);
}

function FinalScore({ submission, points }: { submission: SubmissionDetail; points: number }) {
  const final = submission.finalScore;
  const pct = percent(final, points);
  const source =
    final === null
      ? 'Not graded yet'
      : submission.overrideScore !== null
        ? submission.autoScore !== null
          ? 'Your score (overrides the autograder)'
          : 'Your score'
        : 'From the autograder';
  return (
    <Stack gap={0} align="flex-end">
      <Text fz={28} fw={750} lh={1.1} c={final === null ? 'dimmed' : scoreTextColor(pct)}>
        {final === null ? '—' : formatScore(final)}
        <Text span fz="md" fw={500} c="dimmed">
          {' '}
          / {formatScore(points)}
        </Text>
      </Text>
      <Text size="xs" c="dimmed">
        {pct !== null ? `${pct}% · ` : ''}
        {source}
      </Text>
    </Stack>
  );
}

function AutogradeSummary({ submission, assignment }: { submission: SubmissionDetail; assignment: AssignmentDetail }) {
  if (submission.autoStatus === 'error') {
    return (
      <Alert color="red" variant="light" icon={<IconAlertTriangle />} title="The autograder couldn't grade this file">
        <Stack gap={4}>
          {submission.autoError && <Text size="sm">{submission.autoError}</Text>}
          <Text size="sm" fw={600}>
            Grade this one manually: review the workbook and enter a score below.
          </Text>
        </Stack>
      </Alert>
    );
  }

  if (submission.autoStatus === 'graded' && submission.autoScore !== null) {
    const report = submission.report;
    const pct = percent(submission.autoScore, submission.pointsPossible) ?? 0;
    return (
      <Paper withBorder p="sm" radius="md">
        <Group justify="space-between" mb={6} wrap="nowrap">
          <Group gap={6} wrap="nowrap">
            <ThemeIcon size="sm" variant="light" radius="sm">
              <IconRobot size={14} />
            </ThemeIcon>
            <Text size="sm" fw={600}>
              Autograde score
            </Text>
          </Group>
          <Text size="sm" fw={700}>
            {formatScore(submission.autoScore)} / {formatScore(submission.pointsPossible)}
          </Text>
        </Group>
        <Progress value={pct} color={scoreColor(pct)} size="md" radius="xl" aria-label={`Autograde score ${pct}%`} />
        {report && (
          <Text size="xs" c="dimmed" mt={6}>
            {report.correct.toLocaleString()} of {report.total.toLocaleString()} cells correct
          </Text>
        )}
      </Paper>
    );
  }

  return (
    <Paper withBorder p="sm" radius="md">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon size="sm" variant="light" color="indigo" radius="sm" mt={2}>
          <IconPencil size={14} />
        </ThemeIcon>
        <Text size="sm" c="dimmed">
          {assignment.gradingMode === 'manual'
            ? 'This assignment is graded by hand. Review the workbook and enter a score out of ' +
              `${formatScore(assignment.points)}.`
            : "This attempt wasn't autograded. Review the workbook and enter a score."}
        </Text>
      </Group>
    </Paper>
  );
}

function SubmissionMeta({ submission, attemptCount }: { submission: SubmissionDetail; attemptCount: number }) {
  const byOther = submission.submittedByName !== submission.studentName;
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        Attempt {submission.attempt} of {attemptCount} · submitted {formatDateTime(submission.submittedAt)} (
        {fromNow(submission.submittedAt)})
      </Text>
      {byOther && (
        <Text size="xs" c="dimmed">
          Uploaded by {submission.submittedByName} on the student's behalf
        </Text>
      )}
      <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
        {submission.file.name} · {formatFileSize(submission.file.size)}
      </Text>
    </Stack>
  );
}

export interface GradingPanelProps {
  assignment: AssignmentDetail;
  submission: SubmissionDetail;
  attemptCount: number;
  /** The latest attempt, when `submission` is an older one. */
  latest: SubmissionDetail | null;
  onSelectLatest: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Where "Save & next" goes; null = back to the submissions list. */
  nextName: string | null;
  onNext: () => void;
}

/** Score, feedback and save controls for one attempt. Remount (key) per submission to reset the draft. */
export function GradingPanel({
  assignment,
  submission,
  attemptCount,
  latest,
  onSelectLatest,
  onDirtyChange,
  nextName,
  onNext,
}: GradingPanelProps) {
  const qc = useQueryClient();
  const [score, setScore] = useState<number | string>(submission.overrideScore ?? '');
  const [feedback, setFeedback] = useState(submission.feedback);
  const [error, setError] = useState<string | null>(null);
  const [savingNext, setSavingNext] = useState(false);

  const points = assignment.points;
  const maxScore = points * 2;
  const parsed = parseScore(score);
  // The server stores feedback trimmed, so surrounding whitespace alone is not an unsaved change.
  const dirty = parsed !== submission.overrideScore || feedback.trim() !== submission.feedback.trim();
  const hasAuto = submission.autoScore !== null;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = useMutation({
    mutationFn: (body: GradeSubmissionRequest) => endpoints.gradeSubmission(submission.id, body),
    onSuccess: (updated) => {
      qc.setQueryData<SubmissionDetail[]>(qk.studentSubmissions(assignment.id, updated.studentId), (old) =>
        old?.map((s) => (s.id === updated.id ? updated : s)),
      );
      qc.setQueryData(qk.submission(updated.id), updated);
      void invalidateSubmissions(qc, assignment.classId, assignment.id, updated.studentId);
    },
  });

  const validate = (): string | null => {
    if (parsed === null) return null;
    if (Number.isNaN(parsed)) return 'Enter a number.';
    if (parsed < 0) return "The score can't be negative.";
    if (parsed > maxScore) {
      return `The score can be at most ${formatScore(maxScore)} (double the points, for extra credit).`;
    }
    return null;
  };

  const doSave = async (andNext: boolean) => {
    if (save.isPending) return;
    const problem = validate();
    setError(problem);
    if (problem) return;
    setSavingNext(andNext);
    const sentScore = parsed;
    const sentFeedback = feedback.trim();
    try {
      const updated = await save.mutateAsync({ score: sentScore, feedback: sentFeedback });
      // Show exactly what was stored (trimmed feedback, rounded score), unless the teacher kept typing meanwhile.
      setFeedback((current) => (current.trim() === sentFeedback ? updated.feedback : current));
      setScore((current) => (parseScore(current) === sentScore ? (updated.overrideScore ?? '') : current));
      const shown =
        updated.finalScore === null ? 'no score' : `${formatScore(updated.finalScore)} / ${formatScore(points)}`;
      notifySuccess(`${updated.studentName}: ${shown}`, 'Grade saved');
      if (andNext) onNext();
    } catch (err) {
      setError(fieldErrors(err).score ?? null);
      notifyError(err, "Couldn't save the grade");
    } finally {
      setSavingNext(false);
    }
  };

  useHotkeys(
    [
      ['mod+Enter', () => void doSave(false)],
      ['mod+shift+Enter', () => void doSave(true)],
    ],
    [],
  );

  const nextLabel = nextName ? 'Save & next' : 'Save & back to list';

  return (
    <Card padding="lg" className={classes.gradingCard}>
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Title order={3} fz="h4">
            Grade
          </Title>
          <FinalScore submission={submission} points={points} />
        </Group>

        {latest && (
          <Alert color="blue" variant="light" icon={<IconHistory />} p="sm">
            <Stack gap={6} align="flex-start">
              <Text size="sm">
                You're viewing attempt {submission.attempt}. Only the latest attempt ({latest.attempt}) counts toward
                the grade.
              </Text>
              <Button size="compact-xs" variant="light" onClick={onSelectLatest}>
                Go to the latest attempt
              </Button>
            </Stack>
          </Alert>
        )}

        <AutogradeSummary submission={submission} assignment={assignment} />

        <Stack gap={6}>
          <NumberInput
            label={`Score (out of ${formatScore(points)})`}
            description={
              hasAuto
                ? 'Leave blank to use the autograde score. Anything you enter overrides it.'
                : `Up to ${formatScore(maxScore)} with extra credit.`
            }
            placeholder={hasAuto ? `${formatScore(submission.autoScore)} (autograde)` : `0 – ${formatScore(points)}`}
            value={score}
            onChange={(v) => {
              setScore(v);
              setError(null);
            }}
            min={0}
            max={maxScore}
            step={0.5}
            decimalScale={2}
            allowNegative={false}
            clampBehavior="none"
            error={error}
            size="md"
          />
          <Group gap="xs">
            {hasAuto && parsed === null && (
              <Button
                size="compact-sm"
                variant="subtle"
                leftSection={<IconRobot size={14} />}
                onClick={() => setScore(submission.autoScore ?? '')}
              >
                Use autograde score
              </Button>
            )}
            {parsed !== null && (
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                leftSection={<IconArrowBackUp size={14} />}
                onClick={() => {
                  setScore('');
                  setError(null);
                }}
              >
                {hasAuto ? 'Clear override' : 'Clear score'}
              </Button>
            )}
          </Group>
        </Stack>

        <Textarea
          label="Feedback"
          description="The student sees this with their score."
          placeholder="What went well, and what to fix next time…"
          autosize
          minRows={4}
          maxRows={14}
          maxLength={10_000}
          value={feedback}
          onChange={(e) => setFeedback(e.currentTarget.value)}
        />

        <Stack gap={8} className={classes.panelActions}>
          {/* Wraps instead of truncating: "Save & back to list" gets its own row when the column is narrow. */}
          <Group gap="sm" wrap="wrap">
            <Button
              leftSection={<IconDeviceFloppy size={16} />}
              onClick={() => void doSave(false)}
              loading={save.isPending && !savingNext}
              disabled={save.isPending && savingNext}
              style={{ flex: '1 1 auto' }}
            >
              Save
            </Button>
            <Tooltip label={nextName ? `Then open ${nextName}` : 'Then return to the submissions list'}>
              <Button
                variant="light"
                rightSection={<IconArrowRight size={16} />}
                onClick={() => void doSave(true)}
                loading={save.isPending && savingNext}
                disabled={save.isPending && !savingNext}
                style={{ flex: '1 1 auto' }}
              >
                {nextLabel}
              </Button>
            </Tooltip>
          </Group>
          <Group justify="space-between" gap="xs" wrap="wrap">
            <ShortcutHint keys={['mod', 'Enter']} />
            {dirty ? (
              <Text size="xs" c="orange" fw={600}>
                Unsaved changes
              </Text>
            ) : submission.gradedAt ? (
              <Group gap={4} wrap="nowrap">
                <IconCheck size={14} color="var(--mantine-color-teal-6)" />
                <Text size="xs" c="dimmed">
                  Saved
                </Text>
              </Group>
            ) : null}
          </Group>
        </Stack>

        {submission.gradedAt && (
          <Text size="xs" c="dimmed">
            Graded by {submission.gradedByName ?? 'a teacher'} · {formatDateTime(submission.gradedAt)}
          </Text>
        )}

        <Divider />
        <SubmissionMeta submission={submission} attemptCount={attemptCount} />
      </Stack>
    </Card>
  );
}
