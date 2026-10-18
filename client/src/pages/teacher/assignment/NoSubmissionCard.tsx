import { Box, Card, EmptyState, Text } from '@mantine/core';
import { IconFileOff } from '@tabler/icons-react';
import type { AssignmentDetail } from '@shared/types';
import { formatDateTime, isPast } from '../../../utils/format';
import { UploadOnBehalfForm } from './UploadOnBehalfModal';

/** Grading workspace empty state: nothing submitted yet, with an upload-on-behalf dropzone. */
export function NoSubmissionCard({
  assignment,
  student,
}: {
  assignment: AssignmentDetail;
  student: { id: number; name: string };
}) {
  const pastDue = isPast(assignment.dueAt);
  return (
    <Card padding="xl">
      <EmptyState
        icon={<IconFileOff size={28} />}
        withIndicatorBackground
        title="No submission yet"
        description={`${student.name} hasn't uploaded a workbook for this assignment.`}
      >
        {pastDue ? (
          <Text c="red" fw={700} size="sm" ta="center">
            Missing — it was due {formatDateTime(assignment.dueAt)}.
          </Text>
        ) : (
          <Text c="dimmed" size="sm" ta="center">
            Due {formatDateTime(assignment.dueAt)}.
          </Text>
        )}
      </EmptyState>
      <Box maw={560} w="100%" mx="auto" mt="xl">
        <UploadOnBehalfForm assignment={assignment} student={student} />
      </Box>
    </Card>
  );
}
