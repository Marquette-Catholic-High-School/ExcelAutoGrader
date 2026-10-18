import { useState } from 'react';
import { Button, Center, Group, Modal, PinInput, Stack, Text } from '@mantine/core';
import { IconDoorEnter } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiRequestError } from '../../../api/client';
import { endpoints, qk } from '../../../api/endpoints';
import { errorMessage, notifySuccess } from '../../../utils/errors';

const CODE_LENGTH = 6;

function joinError(err: unknown): string {
  if (err instanceof ApiRequestError && err.status === 404) {
    return 'No class uses that code. Check it with your teacher and try again.';
  }
  return errorMessage(err);
}

/** "Join a class" dialog: a 6-character code, then straight to the class page. */
export function JoinClassModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  const join = useMutation({
    mutationFn: (joinCode: string) => endpoints.joinClass(joinCode),
    onSuccess: (cls) => {
      void qc.invalidateQueries({ queryKey: qk.classes, exact: true });
      void qc.invalidateQueries({ queryKey: qk.myAssignments });
      qc.setQueryData(qk.class(cls.id), cls);
      notifySuccess(`Welcome to ${cls.name}!`, 'You joined the class');
      handleClose();
      navigate(`/student/classes/${cls.id}`);
    },
  });

  function handleClose() {
    setCode('');
    join.reset();
    onClose();
  }

  const complete = code.length === CODE_LENGTH;

  return (
    <Modal opened={opened} onClose={handleClose} title="Join a class" centered>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (complete) join.mutate(code);
        }}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Ask your teacher for the 6-character class code and enter it below.
          </Text>
          <Center>
            <PinInput
              length={CODE_LENGTH}
              type="alphanumeric"
              size="lg"
              value={code}
              onChange={(value) => {
                setCode(value.toUpperCase());
                if (join.isError) join.reset();
              }}
              placeholder=""
              ariaLabel="Class join code"
              oneTimeCode={false}
              autoFocus
              error={join.isError}
              styles={{
                input: {
                  textTransform: 'uppercase',
                  fontFamily: 'var(--mantine-font-family-monospace)',
                  fontWeight: 700,
                },
              }}
            />
          </Center>
          {join.isError && (
            <Text size="sm" c="red" ta="center" role="alert">
              {joinError(join.error)}
            </Text>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!complete}
              loading={join.isPending}
              leftSection={<IconDoorEnter size={18} />}
            >
              Join class
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
