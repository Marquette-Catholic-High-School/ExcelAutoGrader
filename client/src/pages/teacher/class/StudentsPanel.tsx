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
  IconMailForward,
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
import { BADGE_NO_SHRINK, PendingBadge } from '../../../components/StatusBadges';
import { notifyError, notifySuccess } from '../../../utils/errors';
import { formatDateTime, fromNow } from '../../../utils/format';
import { AddStudentsModal } from './AddStudentsModal';
import { AddStudentsResultModal, TempPasswordModal } from './AddStudentsResultModal';
import { confirmAction } from './confirmAction';
import { CopyIconButton } from './JoinCode';
import { invalidateRoster } from './queries';
import { CopyInstructionsButton } from './SignUpInstructions';

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

const PENDING_ROW_TOOLTIP =
  'Matched automatically when they create an account with this email. You can already upload and grade work for them.';

function StatusBadge({ student }: { student: StudentInfo }) {
  if (student.pending) {
    return (
      <PendingBadge
        pending
        size="xs"
        label="Waiting for sign-up"
        tooltip={PENDING_ROW_TOOLTIP}
      />
    );
  }
  if (!student.mustChangePassword) return null;
  return (
    <Tooltip label="This student has not chosen their own password yet.">
      <Badge color="yellow" variant="light" size="xs" leftSection={<IconKey size={10} />} {...BADGE_NO_SHRINK}>
        Temporary password
      </Badge>
    </Tooltip>
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
  const resetNote = student.pending
    ? "Also invited to another teacher's class — the student can sign up with this email instead."
    : "Also in another teacher's class — the student can change it on their Account page.";
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <Avatar name={student.name} color="initials" radius="xl" size={32} />
          <Stack gap={2} align="flex-start">
            <Text fw={500} size="sm">
              {student.name}
            </Text>
            <StatusBadge student={student} />
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed" style={{ wordBreak: 'break-all' }}>
          {student.email}
        </Text>
      </Table.Td>
      <Table.Td>
        <Tooltip label={`${student.pending ? 'Added' : 'Joined'} ${formatDateTime(student.joinedAt)}`}>
          <Text size="sm" w="fit-content">
            {student.pending ? `Invited ${fromNow(student.joinedAt)}` : fromNow(student.joinedAt)}
          </Text>
        </Tooltip>
      </Table.Td>
      <Table.Td>
        <Menu position="bottom-end" withinPortal width={260}>
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
              {student.pending ? (
                <>
                  <Text size="sm">Create a temporary password</Text>
                  <Text size="xs" c="dimmed">
                    Lets them sign in without signing up
                  </Text>
                </>
              ) : (
                'Reset password'
              )}
            </Menu.Item>
            {!canReset && (
              // Outside the disabled item so it is not faded along with it.
              <Text id={resetNoteId} size="xs" c="dimmed" px="sm" pb={6}>
                {resetNote}
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

/** Shown while some students haven't signed up yet. */
function PendingInfo({ cls, count }: { cls: ClassSummary; count: number }) {
  return (
    <Alert variant="light" color="grape" icon={<IconMailForward />} p="sm">
      <Group justify="space-between" gap="sm" wrap="wrap">
        <Text size="sm" style={{ flex: '1 1 320px' }}>
          {count === 1 ? "1 invited student hasn't" : `${count} invited students haven't`} signed up yet. They're
          matched automatically when they create an account with the email you added, and you can upload work for
          them in the meantime.
        </Text>
        <CopyInstructionsButton cls={cls} />
      </Group>
    </Alert>
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
      // A pending student stops being pending, which the submissions tables and gradebook show too.
      invalidateRoster(qc, cls.id);
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
    if (student.pending) {
      confirmAction({
        title: `Create a temporary password for ${student.name}?`,
        message: `They can then sign in with ${student.email} and this password right away instead of signing up, and choose their own password after signing in. You'll see the password once so you can pass it on.`,
        confirmLabel: 'Create password',
        color: 'brand',
        action: () => resetPassword.mutateAsync(student),
      });
      return;
    }
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
      message: student.pending
        ? `They haven't signed up yet. Once removed, signing up with ${student.email} no longer adds them to this ` +
          'class. Any work you uploaded for them is kept and comes back if you add them again.'
        : 'They lose access to this class and its assignments. Their account and past submissions are kept, so if they rejoin later their work is still there.',
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
                  description="Add students by email (one at a time, a pasted list or a roster file). They're matched to their accounts automatically when they sign up with that email. Or share the join code above so they can join on their own."
                >
                  <EmptyState.Actions>{addButton}</EmptyState.Actions>
                </EmptyState>
              </Card>
            );
          }
          const visible = students.filter((s) => matches(s, search));
          const temporary = students.filter((s) => !s.pending && s.mustChangePassword).length;
          const pending = students.filter((s) => s.pending).length;
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
                  {pending > 0 && ` · ${pending} waiting for sign-up`}
                  {temporary > 0 && ` · ${temporary} still using a temporary password`}
                </Text>
              </Stack>
              {pending > 0 && <PendingInfo cls={cls} count={pending} />}
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
      <AddStudentsResultModal cls={cls} result={addResult} onClose={() => setAddResult(null)} />
      <TempPasswordModal data={resetResult} onClose={() => setResetResult(null)} />
    </Stack>
  );
}
