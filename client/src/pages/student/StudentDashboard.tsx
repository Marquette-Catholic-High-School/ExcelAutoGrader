import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Grid,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconDoorEnter, IconMoodHappy, IconSchool } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { AssignmentSummary } from '@shared/types';
import { endpoints, qk } from '../../api/endpoints';
import { useUser } from '../../auth/AuthContext';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, QueryState } from '../../components/QueryState';
import { usePageTitle } from '../../utils/usePageTitle';
import { JoinClassModal } from './dashboard/JoinClassModal';
import { isDueSoon, StudentAssignmentItem } from './dashboard/StudentAssignmentItem';
import { StudentClassCard } from './dashboard/StudentClassCard';

const RECENT_GRADED = 5;

function byDue(a: AssignmentSummary, b: AssignmentSummary) {
  return a.dueAt.localeCompare(b.dueAt);
}

function bySubmittedDesc(a: AssignmentSummary, b: AssignmentSummary) {
  return (b.mine?.submittedAt ?? '').localeCompare(a.mine?.submittedAt ?? '');
}

function Section({
  title,
  count,
  color,
  note,
  children,
  accent,
}: {
  title: string;
  count: number;
  color: string;
  note?: ReactNode;
  children: ReactNode;
  accent?: string;
}) {
  return (
    <Card style={accent ? { borderColor: accent } : undefined}>
      <Group justify="space-between" mb={note ? 4 : 'sm'}>
        <Title order={3} fz="h4" c={color === 'red' ? 'red' : undefined}>
          {title}
        </Title>
        <Badge variant="light" color={color}>
          {count}
        </Badge>
      </Group>
      {note}
      <Stack gap={2} mx="-md">
        {children}
      </Stack>
    </Card>
  );
}

function AssignmentSections({ list }: { list: AssignmentSummary[] }) {
  const todo = list.filter((a) => a.mine?.status === 'not_submitted').sort(byDue);
  const missing = list.filter((a) => a.mine?.status === 'missing').sort(byDue);
  const waiting = list.filter((a) => a.mine?.status === 'submitted').sort(bySubmittedDesc);
  const graded = list.filter((a) => a.mine?.status === 'graded').sort(bySubmittedDesc).slice(0, RECENT_GRADED);
  const dueSoon = todo.filter((a) => isDueSoon(a.dueAt)).length;

  return (
    <Stack gap="md">
      <Section
        title="To do"
        count={todo.length}
        color={dueSoon > 0 ? 'orange' : 'brand'}
        note={
          dueSoon > 0 ? (
            <Text size="sm" c="orange" fw={500} mb="sm">
              {dueSoon} {dueSoon === 1 ? 'assignment is' : 'assignments are'} due in the next 48 hours.
            </Text>
          ) : undefined
        }
      >
        {todo.length === 0 ? (
          <Group gap="sm" px="md" py="sm" wrap="nowrap">
            <ThemeIcon color="teal" variant="light" radius="xl" size={36}>
              <IconMoodHappy size={20} />
            </ThemeIcon>
            <Text size="sm" c="dimmed">
              Nothing to do right now. New assignments from your teachers show up here.
            </Text>
          </Group>
        ) : (
          todo.map((a) => <StudentAssignmentItem key={a.id} a={a} />)
        )}
      </Section>

      {missing.length > 0 && (
        <Section
          title="Missing / overdue"
          count={missing.length}
          color="red"
          accent="var(--mantine-color-red-light-color)"
          note={
            <Group gap={6} mb="sm" wrap="nowrap" align="flex-start">
              <IconAlertTriangle
                size={16}
                color="var(--mantine-color-red-light-color)"
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <Text size="sm" c="dimmed">
                The due date has passed, but late work is still accepted. Upload it as soon as you can; it will be
                marked late.
              </Text>
            </Group>
          }
        >
          {missing.map((a) => (
            <StudentAssignmentItem key={a.id} a={a} />
          ))}
        </Section>
      )}

      {waiting.length > 0 && (
        <Section
          title="Waiting for your teacher"
          count={waiting.length}
          color="blue"
          note={
            <Text size="sm" c="dimmed" mb="sm">
              Submitted and waiting to be graded.
            </Text>
          }
        >
          {waiting.map((a) => (
            <StudentAssignmentItem key={a.id} a={a} />
          ))}
        </Section>
      )}

      {graded.length > 0 && (
        <Section title="Recently graded" count={graded.length} color="teal">
          {graded.map((a) => (
            <StudentAssignmentItem key={a.id} a={a} />
          ))}
        </Section>
      )}
    </Stack>
  );
}

function NotInAnyClass({ onJoin }: { onJoin: () => void }) {
  return (
    <Card py={48}>
      <EmptyState
        variant="light"
        size="lg"
        icon={<IconSchool size={32} />}
        title="Join your first class"
        description="Your teacher will give you a 6-character class code. Enter it to see your assignments and upload your work."
      >
        <EmptyState.Actions>
          <Button size="md" leftSection={<IconDoorEnter size={18} />} onClick={onJoin}>
            Join a class
          </Button>
        </EmptyState.Actions>
      </EmptyState>
    </Card>
  );
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

export function StudentDashboard() {
  const user = useUser();
  usePageTitle('Dashboard');
  const [joinOpen, setJoinOpen] = useState(false);
  const classList = useQuery({ queryKey: qk.classes, queryFn: endpoints.listClasses });
  const assignments = useQuery({ queryKey: qk.myAssignments, queryFn: endpoints.listMyAssignments });

  return (
    <>
      <PageHeader
        title={`Hi, ${firstName(user.name)}`}
        subtitle="Here's what's due and how your work is going."
        actions={
          <Button leftSection={<IconDoorEnter size={18} />} onClick={() => setJoinOpen(true)}>
            Join a class
          </Button>
        }
      />

      <QueryState query={classList} loadingLabel="Loading your classes…">
        {(list) =>
          list.length === 0 ? (
            <NotInAnyClass onJoin={() => setJoinOpen(true)} />
          ) : (
            <Grid gap="lg">
              <Grid.Col span={{ base: 12, md: 8 }}>
                {assignments.isPending ? (
                  <Stack gap="md">
                    <Skeleton h={160} />
                    <Skeleton h={120} />
                  </Stack>
                ) : assignments.error || !assignments.data ? (
                  <ErrorAlert
                    error={assignments.error}
                    title="Could not load your assignments"
                    onRetry={() => assignments.refetch()}
                  />
                ) : (
                  <AssignmentSections list={assignments.data} />
                )}
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 4 }}>
                <Group justify="space-between" mb="sm">
                  <Title order={3} fz="h4">
                    Your classes
                  </Title>
                  <Text size="sm" c="dimmed">
                    {list.length}
                  </Text>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2, md: 1 }} spacing="md">
                  {list.map((c) => (
                    <StudentClassCard key={c.id} c={c} />
                  ))}
                </SimpleGrid>
              </Grid.Col>
            </Grid>
          )
        }
      </QueryState>

      <JoinClassModal opened={joinOpen} onClose={() => setJoinOpen(false)} />
    </>
  );
}
