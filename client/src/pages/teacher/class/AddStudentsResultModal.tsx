import type { ReactNode } from 'react';
import {
  Alert,
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
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconCopy, IconKey } from '@tabler/icons-react';
import type { AddedStudentResult, AddStudentsResponse, StudentInfo } from '@shared/types';
import { CopyIconButton } from './JoinCode';
import { useLatched } from './useLatched';

function loginUrl() {
  return `${window.location.origin}/login`;
}

/** Tab-separated so it reads fine as text and also pastes cleanly into Excel. */
function passwordsAsText(rows: AddedStudentResult[]): string {
  const lines = rows.map((r) => [r.student.name, r.student.email, r.tempPassword ?? ''].join('\t'));
  return ['Name\tEmail\tTemporary password', ...lines].join('\n');
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

function CreatedAccounts({ rows }: { rows: AddedStudentResult[] }) {
  return (
    <Section title="New accounts" count={rows.length} color="teal">
      <Alert color="yellow" variant="light" icon={<IconAlertTriangle />} title="Copy these passwords now">
        Temporary passwords are shown only once. Students sign in at <Code>{loginUrl()}</Code> and are asked to
        choose their own password right away. If one gets lost, use “Reset password” on the Students tab.
      </Alert>
      <Group justify="flex-end">
        <CopyButton value={passwordsAsText(rows)} timeout={2000}>
          {({ copied, copy }) => (
            <Button
              size="xs"
              variant={copied ? 'light' : 'filled'}
              color={copied ? 'teal' : undefined}
              leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              onClick={copy}
            >
              {copied ? 'Copied' : 'Copy all as text'}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Paper withBorder>
        <Table.ScrollContainer minWidth={520} maxHeight={300}>
          <Table verticalSpacing={6} fz="sm" stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Email</Table.Th>
                <Table.Th>Temporary password</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.student.id}>
                  <Table.Td>{r.student.name}</Table.Td>
                  <Table.Td c="dimmed">{r.student.email}</Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Code fz="sm">{r.tempPassword}</Code>
                      {r.tempPassword && (
                        <CopyIconButton value={r.tempPassword} label={`Copy ${r.student.name}'s password`} />
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
    </Section>
  );
}

/** Outcome of "Add students": new accounts (with one-time passwords), enrolled accounts, skips and errors. */
export function AddStudentsResultModal({
  result,
  onClose,
}: {
  result: AddStudentsResponse | null;
  onClose: () => void;
}) {
  const shown = useLatched(result);
  const added = shown?.added ?? [];
  const created = added.filter((a) => a.created);
  const enrolled = added.filter((a) => !a.created && !a.alreadyEnrolled);
  const already = added.filter((a) => a.alreadyEnrolled);
  const errors = shown?.errors ?? [];
  const changed = created.length + enrolled.length;
  const hasPasswords = created.length > 0;

  const title =
    changed === 0
      ? 'No new students added'
      : `${changed} ${changed === 1 ? 'student' : 'students'} added to the class`;

  // One-time passwords can't be shown again, so only the explicit button below closes the dialog then.
  return (
    <Modal
      opened={result !== null}
      onClose={onClose}
      title={title}
      size="xl"
      closeOnClickOutside={!hasPasswords}
      closeOnEscape={!hasPasswords}
      withCloseButton={!hasPasswords}
    >
      <Stack gap="lg">
        {hasPasswords && <CreatedAccounts rows={created} />}

        {enrolled.length > 0 && (
          <Section title="Existing accounts enrolled" count={enrolled.length} color="blue">
            <Text size="sm" c="dimmed">
              These students already had an account. They sign in with their own password.
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
          <Button onClick={onClose} leftSection={hasPasswords ? <IconKey size={16} /> : undefined}>
            {hasPasswords ? "I've saved the passwords" : 'Done'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** One-time display of a password generated by "Reset password". */
export function TempPasswordModal({
  data,
  onClose,
}: {
  data: { student: StudentInfo; tempPassword: string } | null;
  onClose: () => void;
}) {
  const shown = useLatched(data);
  return (
    // Shown only once: no Escape, close button or outside click; "I've saved the password" closes it.
    <Modal
      opened={data !== null}
      onClose={onClose}
      title="New temporary password"
      closeOnClickOutside={false}
      closeOnEscape={false}
      withCloseButton={false}
    >
      {shown && (
        <Stack gap="md">
          <Text size="sm">
            Give this password to <b>{shown.student.name}</b> ({shown.student.email}). They were signed out and will be
            asked to choose a new password after signing in at <Code>{loginUrl()}</Code>.
          </Text>
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
