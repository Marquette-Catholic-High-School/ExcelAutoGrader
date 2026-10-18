import { Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { AssignmentDetail } from '@shared/types';
import { endpoints, qk } from '../../../api/endpoints';
import { notifyError, notifySuccess } from '../../../utils/errors';
import { invalidateAssignment } from './cache';

export function DeleteAssignmentModal({
  opened,
  onClose,
  assignment,
  submissionCount,
}: {
  opened: boolean;
  onClose: () => void;
  assignment: AssignmentDetail;
  submissionCount: number;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const remove = useMutation({
    mutationFn: () => endpoints.deleteAssignment(assignment.id),
    onSuccess: async () => {
      navigate(`/teacher/classes/${assignment.classId}`);
      // Drop the deleted assignment's cached data after this page has unmounted.
      window.setTimeout(() => qc.removeQueries({ queryKey: qk.assignment(assignment.id) }), 0);
      await invalidateAssignment(qc, assignment.classId);
      notifySuccess(`“${assignment.title}” was deleted.`, 'Assignment deleted');
    },
    onError: (err) => notifyError(err, "Couldn't delete the assignment"),
  });

  return (
    <Modal
      opened={opened}
      onClose={() => !remove.isPending && onClose()}
      title={<Text fw={650}>Delete this assignment?</Text>}
      centered
    >
      <Stack gap="md">
        <Text size="sm">
          <strong>{assignment.title}</strong> will be removed for everyone in {assignment.className}. This permanently
          deletes:
        </Text>
        <List size="sm" spacing={4}>
          <List.Item>
            {submissionCount === 0
              ? 'The assignment (no student has submitted yet)'
              : `${submissionCount} student submission${submissionCount === 1 ? '' : 's'} and their grades`}
          </List.Item>
          {assignment.key && <List.Item>The answer key ({assignment.key.name})</List.Item>}
          {assignment.template && <List.Item>The starter file ({assignment.template.name})</List.Item>}
        </List>
        <Text size="sm" c="red" fw={500}>
          This can't be undone.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={remove.isPending} data-autofocus>
            Cancel
          </Button>
          <Button
            color="red"
            leftSection={<IconTrash size={16} />}
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete assignment
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
