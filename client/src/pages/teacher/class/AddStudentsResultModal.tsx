import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  List,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconCheck, IconCopy, IconKey } from '@tabler/icons-react';
import type { AddStudentsResponse, ClassSummary, StudentInfo } from '@shared/types';
import { CopyInstructionsButton } from './SignUpInstructions';
import { useLatched } from './useLatched';

function loginUrl() {
  return `${window.location.origin}/login`;
}

function Section({
  title,
  count,
  color,
  children,
}: {
  title: string;
  count: number;
  color: string;
  children: ReactNode;
}) {
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Title order={4} fz="md">
          {title}
        </Title>
        <Badge variant="light" color={color} circle>
          {count}
        </Badge>
      </Group>
      {children}
    </Stack>
  );
}

function StudentList({ students }: { students: StudentInfo[] }) {
  return (
    <ScrollArea.Autosize mah={160} type="auto">
      <List size="sm" spacing={4}>
        {students.map((s) => (
          <List.Item key={s.id}>
            {s.name}{' '}
            <Text span c="dimmed" size="sm">
              {s.email}
            </Text>
          </List.Item>
        ))}
      </List>
    </ScrollArea.Autosize>
  );
}

/** Outcome of "Add students": who was invited (not signed up yet), added, already in the class, or not added. */
export function AddStudentsResultModal({
  cls,
  result,
  onClose,
}: {
  cls: ClassSummary;
  result: AddStudentsResponse | null;
  onClose: () => void;
}) {
  const shown = useLatched(result);
  const changed = (shown?.added ?? []).filter((a) => !a.alreadyEnrolled);
  // Grouped by pending rather than `created`: an email another teacher already invited is added, but still pending.
  const invited = changed.filter((a) => a.pending || a.student.pending);
  const enrolled = changed.filter((a) => !(a.pending || a.student.pending));
  const already = (shown?.added ?? []).filter((a) => a.alreadyEnrolled);
  const errors = shown?.errors ?? [];

  const title =
    changed.length === 0
      ? 'No new students added'
      : `${changed.length} ${changed.length === 1 ? 'student' : 'students'} added to the class`;

  return (
    <Modal opened={result !== null} onClose={onClose} title={title} size="lg">
      <Stack gap="lg">
        {invited.length > 0 && (
          <Section title="Invited — waiting to sign up" count={invited.length} color="grape">
            <Text size="sm" c="dimmed">
              They're on your roster now, and you can already upload and grade work for them. When they create an
              account with this email, they're matched automatically and see the class and their work.
            </Text>
            <StudentList students={invited.map((a) => a.student)} />
            <Group>
              <CopyInstructionsButton cls={cls} />
            </Group>
          </Section>
        )}

        {enrolled.length > 0 && (
          <Section title="Added — already had an account" count={enrolled.length} color="teal">
            <Text size="sm" c="dimmed">
              They sign in with their own password and see the class right away.
            </Text>
            <StudentList students={enrolled.map((a) => a.student)} />
          </Section>
        )}

        {already.length > 0 && (
          <Section title="Already in this class" count={already.length} color="gray">
            <StudentList students={already.map((a) => a.student)} />
          </Section>
        )}

        {errors.length > 0 && (
          <Section title="Could not add" count={errors.length} color="red">
            <ScrollArea.Autosize mah={160} type="auto">
              <List size="sm" spacing={4}>
                {errors.map((e, i) => (
                  <List.Item key={`${e.email}-${i}`}>
                    <Text span fw={600} size="sm">
                      {e.email || e.name}
                    </Text>
                    <Text span c="red" size="sm">
                      {' '}
                      — {e.error}
                    </Text>
                  </List.Item>
                ))}
              </List>
            </ScrollArea.Autosize>
          </Section>
        )}

        <Group justify="flex-end">
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * One-time display of a password from "Reset password", or from "Create a temporary password" for a student who
 * hasn't signed up yet (`student` is the roster row from before, so `student.pending` tells which).
 */
export function TempPasswordModal({
  data,
  onClose,
}: {
  data: { student: StudentInfo; tempPassword: string } | null;
  onClose: () => void;
}) {
  const shown = useLatched(data);
  const wasPending = !!shown?.student.pending;
  return (
    // Shown only once: no Escape, close button or outside click; "I've saved the password" closes it.
    <Modal
      opened={data !== null}
      onClose={onClose}
      title={wasPending ? 'Temporary password created' : 'New temporary password'}
      closeOnClickOutside={false}
      closeOnEscape={false}
      withCloseButton={false}
    >
      {shown && (
        <Stack gap="md">
          {wasPending ? (
            <Text size="sm">
              Give this password to <b>{shown.student.name}</b>. Instead of signing up, they sign in at{' '}
              <Code>{loginUrl()}</Code> with <b>{shown.student.email}</b> and this password, and are asked to choose
              their own password right away.
            </Text>
          ) : (
            <Text size="sm">
              Give this password to <b>{shown.student.name}</b> ({shown.student.email}). They were signed out and will
              be asked to choose a new password after signing in at <Code>{loginUrl()}</Code>.
            </Text>
          )}
          <Paper withBorder p="md">
            <Group justify="space-between" wrap="nowrap">
              <Code fz="lg" fw={700} style={{ letterSpacing: 1 }}>
                {shown.tempPassword}
              </Code>
              <CopyButton value={shown.tempPassword} timeout={2000}>
                {({ copied, copy }) => (
                  <Button
                    size="xs"
                    variant="light"
                    color={copied ? 'teal' : undefined}
                    leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    onClick={copy}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Paper>
          <Text size="xs" c="dimmed">
            This password is shown only once. You can always reset it again.
          </Text>
          <Group justify="flex-end">
            <Button onClick={onClose} leftSection={<IconKey size={16} />}>
              I've saved the password
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
