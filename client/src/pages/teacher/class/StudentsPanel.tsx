import { useId, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Code,
  EmptyState,
  Group,
  Menu,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import {
  IconDots,
  IconKey,
  IconSearch,
  IconUserMinus,
  IconUserPlus,
  IconUsers,
  IconUsersGroup,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddStudentsResponse, ClassSummary, StudentInfo } from '@shared/types';
import { ApiRequestError } from '../../../api/client';
import { endpoints, qk } from '../../../api/endpoints';
import { QueryState } from '../../../components/QueryState';
import { notifyError, notifySuccess } from '../../../utils/errors';
import { formatDateTime, fromNow } from '../../../utils/format';
import { AddStudentsModal } from './AddStudentsModal';
import { AddStudentsResultModal, TempPasswordModal } from './AddStudentsResultModal';
import { confirmAction } from './confirmAction';
import { CopyIconButton } from './JoinCode';
import { invalidateRoster } from './queries';

function JoinCodeInfo({ cls }: { cls: ClassSummary }) {
  if (!cls.joinCode) return null;
  return (
    <Alert
      variant="light"
      color="brand"
      icon={<IconUsersGroup />}
      title={
        <Group gap={6} component="span">
          Students can join on their own with code
          <Code fz="sm" fw={700} style={{ letterSpacing: 1.5 }}>
            {cls.joinCode}
          </Code>
          <CopyIconButton value={cls.joinCode} label="Copy join code" />
        </Group>
      }
    >
      They create a student account at <Code>{window.location.origin}/register</Code>, choose “Join a class” on their
      dashboard and enter the code. You can change the code on the Settings tab.
    </Alert>
  );
}

function StudentRow({
  student,
  onReset,
  onRemove,
}: {
  student: StudentInfo;
  onReset: (s: StudentInfo) => void;
  onRemove: (s: StudentInfo) => void;
}) {
  const resetNoteId = useId();
  // Only roster rows carry the flag; a missing value means the reset is allowed.
  const canReset = student.canResetPassword !== false;
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <Avatar name={student.name} color="initials" radius="xl" size={32} />
          <Stack gap={2}>
            <Text fw={500} size="sm">
              {student.name}
            </Text>
            {student.mustChangePassword && (
              <Tooltip label="This student has not chosen their own password yet.">
                <Badge color="yellow" variant="light" size="xs" leftSection={<IconKey size={10} />} w="fit-content">
                  Temporary password
                </Badge>
              </Tooltip>
            )}
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed" style={{ wordBreak: 'break-all' }}>
          {student.email}
        </Text>
      </Table.Td>
      <Table.Td>
        <Tooltip label={formatDateTime(student.joinedAt)}>
          <Text size="sm" w="fit-content">
            {fromNow(student.joinedAt)}
          </Text>
        </Tooltip>
      </Table.Td>
      <Table.Td>
        <Menu position="bottom-end" withinPortal width={240}>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${student.name}`}>
              <IconDots size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconKey size={16} />}
              disabled={!canReset}
              aria-describedby={canReset ? undefined : resetNoteId}
              onClick={() => onReset(student)}
            >
              Reset password
            </Menu.Item>
            {!canReset && (
              // Outside the disabled item so it is not faded along with it.
              <Text id={resetNoteId} size="xs" c="dimmed" px="sm" pb={6}>
                Also in another teacher's class — the student can change it on their Account page.
              </Text>
            )}
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<IconUserMinus size={16} />} onClick={() => onRemove(student)}>
              Remove from class
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Table.Td>
    </Table.Tr>
  );
}

function matches(s: StudentInfo, search: string) {
  const q = search.trim().toLowerCase();
  return !q || s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q);
}

export function StudentsPanel({ cls }: { cls: ClassSummary }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.students(cls.id), queryFn: () => endpoints.listStudents(cls.id) });
  const [addOpen, setAddOpen] = useState(false);
  const [addResult, setAddResult] = useState<AddStudentsResponse | null>(null);
  const [resetResult, setResetResult] = useState<{ student: StudentInfo; tempPassword: string } | null>(null);
  const [search, setSearch] = useState('');

  const resetPassword = useMutation({
    mutationFn: (s: StudentInfo) => endpoints.resetStudentPassword(cls.id, s.id),
    onSuccess: (res, student) => {
      void qc.invalidateQueries({ queryKey: qk.students(cls.id) });
      setResetResult({ student, tempPassword: res.tempPassword });
    },
    onError: (err) => {
      notifyError(err, 'Could not reset the password');
      // Not allowed (e.g. they just joined another teacher's class): refresh so the menu explains why.
      if (err instanceof ApiRequestError && err.status === 403) {
        void qc.invalidateQueries({ queryKey: qk.students(cls.id) });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (s: StudentInfo) => endpoints.removeStudent(cls.id, s.id),
    onSuccess: (_res, student) => {
      invalidateRoster(qc, cls.id);
      notifySuccess(`${student.name} was removed from ${cls.name}.`);
    },
    onError: (err) => notifyError(err, 'Could not remove the student'),
  });

  function confirmReset(student: StudentInfo) {
    confirmAction({
      title: `Reset ${student.name}'s password?`,
      message:
        "A new temporary password replaces their current one and they are signed out everywhere. You'll see the new password once so you can pass it on.",
      confirmLabel: 'Reset password',
      color: 'orange',
      action: () => resetPassword.mutateAsync(student),
    });
  }

  function confirmRemove(student: StudentInfo) {
    confirmAction({
      title: `Remove ${student.name} from ${cls.name}?`,
      message:
        'They lose access to this class and its assignments. Their account and past submissions are kept, so if they rejoin later their work is still there.',
      confirmLabel: 'Remove student',
      color: 'red',
      action: () => remove.mutateAsync(student),
    });
  }

  const addButton = (
    <Button leftSection={<IconUserPlus size={18} />} onClick={() => setAddOpen(true)}>
      Add students
    </Button>
  );

  return (
    <Stack gap="md">
      <JoinCodeInfo cls={cls} />

      <QueryState query={query} loadingLabel="Loading students…">
        {(students) => {
          if (students.length === 0) {
            return (
              <Card py="xl">
                <EmptyState
                  variant="light"
                  size="md"
                  icon={<IconUsers size={32} />}
                  title="No students yet"
                  description="Add students by email and we'll create their accounts with temporary passwords, or share the join code above so they can sign up and join on their own."
                >
                  <EmptyState.Actions>{addButton}</EmptyState.Actions>
                </EmptyState>
              </Card>
            );
          }
          const visible = students.filter((s) => matches(s, search));
          const temporary = students.filter((s) => s.mustChangePassword).length;
          return (
            <>
              <Stack gap={6}>
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <TextInput
                    placeholder="Search by name or email"
                    aria-label="Search students"
                    leftSection={<IconSearch size={16} />}
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    w={{ base: '100%', xs: 300 }}
                  />
                  {addButton}
                </Group>
                <Text size="sm" c="dimmed">
                  {students.length} {students.length === 1 ? 'student' : 'students'}
                  {temporary > 0 && ` · ${temporary} still using a temporary password`}
                </Text>
              </Stack>
              <Card p={0}>
                <Table.ScrollContainer minWidth={620}>
                  <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Email</Table.Th>
                        <Table.Th>Joined</Table.Th>
                        <Table.Th w={56}>
                          <VisuallyHidden>Actions</VisuallyHidden>
                        </Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {visible.map((s) => (
                        <StudentRow key={s.id} student={s} onReset={confirmReset} onRemove={confirmRemove} />
                      ))}
                      {visible.length === 0 && (
                        <Table.Tr>
                          <Table.Td colSpan={4}>
                            <Text size="sm" c="dimmed" ta="center" py="md">
                              No students match “{search.trim()}”.
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Card>
            </>
          );
        }}
      </QueryState>

      <AddStudentsModal
        classId={cls.id}
        opened={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(result) => setAddResult(result)}
      />
      <AddStudentsResultModal result={addResult} onClose={() => setAddResult(null)} />
      <TempPasswordModal data={resetResult} onClose={() => setResetResult(null)} />
    </Stack>
  );
}
