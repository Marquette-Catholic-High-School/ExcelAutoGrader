import { useState } from 'react';
import { Alert, Button, Card, Group, Modal, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertTriangle, IconDeviceFloppy, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { ClassSummary } from '@shared/types';
import { endpoints, qk } from '../../../api/endpoints';
import { fieldErrors, notifyError, notifySuccess } from '../../../utils/errors';
import { classFormRules } from './CreateClassModal';
import { confirmAction } from './confirmAction';
import { CopyIconButton } from './JoinCode';
import { invalidateClassSummary } from './queries';

function DetailsCard({ cls }: { cls: ClassSummary }) {
  const qc = useQueryClient();
  const form = useForm({
    initialValues: { name: cls.name, description: cls.description },
    validate: classFormRules,
  });

  const save = useMutation({
    mutationFn: (values: { name: string; description: string }) => endpoints.updateClass(cls.id, values),
    onSuccess: (updated) => {
      qc.setQueryData(qk.class(cls.id), updated);
      invalidateClassSummary(qc, cls.id);
      void qc.invalidateQueries({ queryKey: qk.myAssignments });
      const values = { name: updated.name, description: updated.description };
      form.setInitialValues(values);
      form.setValues(values);
      form.resetDirty(values);
      notifySuccess('Class details saved.');
    },
    onError: (err) => {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length > 0) form.setErrors(fields);
      else notifyError(err, 'Could not save the class');
    },
  });

  return (
    <Card>
      <Title order={3} fz="h4" mb="md">
        Class details
      </Title>
      <form
        onSubmit={form.onSubmit((values) =>
          save.mutate({ name: values.name.trim(), description: values.description.trim() }),
        )}
        noValidate
      >
        <Stack gap="md">
          <TextInput label="Class name" required {...form.getInputProps('name')} />
          <Textarea
            label="Description"
            description="Students see this on the class page."
            autosize
            minRows={3}
            maxRows={10}
            {...form.getInputProps('description')}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" disabled={!form.isDirty() || save.isPending} onClick={() => form.reset()}>
              Discard changes
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={!form.isDirty()}
              leftSection={<IconDeviceFloppy size={18} />}
            >
              Save changes
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

function JoinCodeCard({ cls }: { cls: ClassSummary }) {
  const qc = useQueryClient();
  const regenerate = useMutation({
    mutationFn: () => endpoints.regenerateJoinCode(cls.id),
    onSuccess: (updated) => {
      qc.setQueryData(qk.class(cls.id), updated);
      invalidateClassSummary(qc, cls.id);
      notifySuccess(`The new join code is ${updated.joinCode ?? ''}.`, 'Join code changed');
    },
    onError: (err) => notifyError(err, 'Could not change the join code'),
  });

  function confirmRegenerate() {
    confirmAction({
      title: 'Generate a new join code?',
      message:
        'The current code stops working right away. Students who already joined stay in the class; anyone you shared the old code with will need the new one.',
      confirmLabel: 'Generate new code',
      color: 'orange',
      action: () => regenerate.mutateAsync(),
    });
  }

  return (
    <Card>
      <Title order={3} fz="h4" mb={4}>
        Join code
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        Students enter this code under “Join a class” on their dashboard to enroll themselves.
      </Text>
      <Group justify="space-between" wrap="wrap" gap="md">
        <Group gap="xs">
          <Text ff="monospace" fz={28} fw={700} style={{ letterSpacing: 4 }}>
            {cls.joinCode ?? '——'}
          </Text>
          {cls.joinCode && <CopyIconButton value={cls.joinCode} label="Copy join code" size="md" />}
        </Group>
        <Button
          variant="default"
          leftSection={<IconRefresh size={18} />}
          onClick={confirmRegenerate}
          loading={regenerate.isPending}
        >
          Generate new code
        </Button>
      </Group>
    </Card>
  );
}

function DeleteClassModal({ cls, opened, onClose }: { cls: ClassSummary; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === cls.name.trim();

  const remove = useMutation({
    mutationFn: () => endpoints.deleteClass(cls.id),
    onSuccess: () => {
      notifySuccess(`${cls.name} and everything in it was deleted.`, 'Class deleted');
      navigate('/teacher', { replace: true });
      void qc.invalidateQueries({ queryKey: qk.classes, exact: true });
      void qc.invalidateQueries({ queryKey: qk.myAssignments });
    },
    onError: (err) => notifyError(err, 'Could not delete the class'),
  });

  function handleClose() {
    if (remove.isPending) return;
    setTyped('');
    onClose();
  }

  return (
    <Modal opened={opened} onClose={handleClose} title={`Delete ${cls.name}?`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (matches) remove.mutate();
        }}
      >
        <Stack gap="md">
          <Alert color="red" variant="light" icon={<IconAlertTriangle />}>
            This permanently deletes the class, its {cls.assignmentCount}{' '}
            {cls.assignmentCount === 1 ? 'assignment' : 'assignments'}, every student submission and all uploaded
            files. Student accounts are kept. This cannot be undone.
          </Alert>
          <TextInput
            label={
              <>
                Type <b>{cls.name}</b> to confirm
              </>
            }
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            autoComplete="off"
            data-autofocus
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={handleClose} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              color="red"
              disabled={!matches}
              loading={remove.isPending}
              leftSection={<IconTrash size={18} />}
            >
              Delete class
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function DangerZone({ cls }: { cls: ClassSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <Card style={{ borderColor: 'var(--mantine-color-red-light-color)' }}>
      <Group justify="space-between" wrap="wrap" gap="md">
        <Stack gap={4} style={{ flex: 1, minWidth: 240 }}>
          <Title order={3} fz="h4" c="red">
            Delete this class
          </Title>
          <Text size="sm" c="dimmed">
            Removes the class with all of its assignments, submissions and files. Student accounts are not deleted.
          </Text>
        </Stack>
        <Button color="red" variant="light" leftSection={<IconTrash size={18} />} onClick={() => setOpen(true)}>
          Delete class
        </Button>
      </Group>
      <DeleteClassModal cls={cls} opened={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

export function SettingsPanel({ cls }: { cls: ClassSummary }) {
  return (
    <Stack gap="lg" maw={760}>
      <DetailsCard cls={cls} />
      <JoinCodeCard cls={cls} />
      <DangerZone cls={cls} />
    </Stack>
  );
}
