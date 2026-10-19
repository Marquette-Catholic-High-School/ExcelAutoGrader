import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconClockExclamation, IconMailForward, IconUpload } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AssignmentDetail, SubmissionDetail } from '@shared/types';
import { endpoints } from '../../../api/endpoints';
import { FileDropzone } from '../../../components/FileDropzone';
import { errorMessage, fieldErrors, notifySuccess } from '../../../utils/errors';
import { formatScoreOf, isPast } from '../../../utils/format';
import { invalidateSubmissions } from './cache';

export interface StudentRef {
  id: number;
  name: string;
  /** Added by email, not signed up yet (StudentInfo.pending). */
  pending?: boolean;
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

function uploadResultMessage(sub: SubmissionDetail): string {
  const late = sub.late ? ' It is flagged as late.' : '';
  if (sub.autoStatus === 'graded') return `Autograded: ${formatScoreOf(sub.autoScore, sub.pointsPossible)}.${late}`;
  if (sub.autoStatus === 'error') {
    return `Saved, but the autograder couldn't grade it, so it needs manual grading.${late}`;
  }
  return `Saved as attempt ${sub.attempt} and ready to grade.${late}`;
}

/** Dropzone + upload button for submitting a workbook on a student's behalf (a new attempt for them). */
export function UploadOnBehalfForm({
  assignment,
  student,
  onUploaded,
  onCancel,
}: {
  assignment: AssignmentDetail;
  student: StudentRef;
  onUploaded?: (submission: SubmissionDetail) => void;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pastDue = isPast(assignment.dueAt);

  const upload = useMutation({
    mutationFn: (f: File) => endpoints.submit(assignment.id, f, student.id),
    onSuccess: async (submission) => {
      await invalidateSubmissions(qc, assignment.classId, assignment.id, student.id);
      notifySuccess(uploadResultMessage(submission), `Uploaded for ${student.name}`);
      setFile(null);
      onUploaded?.(submission);
    },
    onError: (err) => setError(fieldErrors(err).file ?? errorMessage(err)),
  });

  return (
    <Stack gap="md">
      <FileDropzone
        label={`Upload on behalf of ${student.name}`}
        description="The student's finished workbook (.xlsx, .xlsm, .xls, .csv or .ods)."
        file={file}
        onFile={(f) => {
          setFile(f);
          setError(null);
        }}
        onClear={() => setFile(null)}
        loading={upload.isPending}
        error={error}
      />
      {student.pending && (
        <Alert color="grape" variant="light" icon={<IconMailForward />} p="sm">
          {student.name} hasn't signed up yet — they'll see this work when they create their account.
        </Alert>
      )}
      {pastDue && (
        <Alert color="red" variant="light" icon={<IconClockExclamation />} p="sm">
          The due date has passed, so this upload will be flagged as late.
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        It's saved as a new attempt for {firstName(student.name)} and recorded as uploaded by you.
        {assignment.gradingMode === 'auto' ? ' The autograder scores it right away.' : ''}
      </Text>
      <Group justify="flex-end" gap="sm">
        {onCancel && (
          <Button variant="default" onClick={onCancel} disabled={upload.isPending}>
            Cancel
          </Button>
        )}
        <Button
          leftSection={<IconUpload size={16} />}
          disabled={!file}
          loading={upload.isPending}
          onClick={() => file && upload.mutate(file)}
        >
          Upload for {firstName(student.name)}
        </Button>
      </Group>
    </Stack>
  );
}

export function UploadOnBehalfModal({
  opened,
  onClose,
  assignment,
  student,
  onUploaded,
}: {
  opened: boolean;
  onClose: () => void;
  assignment: AssignmentDetail;
  student: StudentRef | null;
  onUploaded?: (submission: SubmissionDetail) => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={650}>Upload a submission</Text>} size="lg" centered>
      {student && (
        <UploadOnBehalfForm
          key={student.id}
          assignment={assignment}
          student={student}
          onCancel={onClose}
          onUploaded={(submission) => {
            onUploaded?.(submission);
            onClose();
          }}
        />
      )}
    </Modal>
  );
}
