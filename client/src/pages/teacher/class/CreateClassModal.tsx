import { Button, Group, Modal, Stack, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { CreateClassRequest } from '@shared/types';
import { endpoints, qk } from '../../../api/endpoints';
import { fieldErrors, notifyError, notifySuccess } from '../../../utils/errors';

export const CLASS_NAME_MAX = 100;
export const CLASS_DESCRIPTION_MAX = 2000;

/** Shared validation for the create and edit class forms. */
export const classFormRules = {
  name: (value: string) => {
    const name = value.trim();
    if (!name) return 'Give your class a name';
    return name.length > CLASS_NAME_MAX ? `Use ${CLASS_NAME_MAX} characters or fewer` : null;
  },
  description: (value: string) =>
    value.trim().length > CLASS_DESCRIPTION_MAX ? `Use ${CLASS_DESCRIPTION_MAX} characters or fewer` : null,
};

/** "New class" dialog. On success it opens the new class on the Students tab so the teacher can add a roster. */
export function CreateClassModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<Required<CreateClassRequest>>({
    mode: 'uncontrolled',
    initialValues: { name: '', description: '' },
    validate: classFormRules,
  });

  const create = useMutation({
    mutationFn: (values: CreateClassRequest) => endpoints.createClass(values),
    onSuccess: (cls) => {
      qc.setQueryData(qk.class(cls.id), cls);
      void qc.invalidateQueries({ queryKey: qk.classes, exact: true });
      const next = cls.joinCode
        ? `Add your students next, or share the join code ${cls.joinCode}.`
        : 'Add your students next.';
      notifySuccess(next, `${cls.name} created`);
      handleClose();
      navigate(`/teacher/classes/${cls.id}?tab=students`);
    },
    onError: (err) => {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length > 0) form.setErrors(fields);
      else notifyError(err, 'Could not create the class');
    },
  });

  function handleClose() {
    form.reset();
    create.reset();
    onClose();
  }

  return (
    <Modal opened={opened} onClose={handleClose} title="New class" size="md">
      <form
        onSubmit={form.onSubmit((values) =>
          create.mutate({ name: values.name.trim(), description: values.description.trim() }),
        )}
        noValidate
      >
        <Stack gap="md">
          <TextInput
            label="Class name"
            placeholder="e.g. Business Math — Period 3"
            required
            data-autofocus
            key={form.key('name')}
            {...form.getInputProps('name')}
          />
          <Textarea
            label="Description"
            description="Optional. Students see this on the class page."
            placeholder="What this class covers, meeting times, where to get help…"
            autosize
            minRows={3}
            maxRows={8}
            key={form.key('description')}
            {...form.getInputProps('description')}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create class
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
