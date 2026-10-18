import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Grid,
  Group,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconCalendarEvent,
  IconChevronRight,
  IconCircleCheck,
  IconClipboardList,
  IconPencil,
  IconPlus,
  IconSchool,
  IconUsers,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { AssignmentSummary, ClassSummary } from '@shared/types';
import { endpoints, qk } from '../../api/endpoints';
import { useUser } from '../../auth/AuthContext';
import { LateCountBadge, NeedsGradingCountBadge } from '../../components/AssignmentBadges';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, QueryState } from '../../components/QueryState';
import { fromNow, isPast } from '../../utils/format';
import { usePageTitle } from '../../utils/usePageTitle';
import { CreateClassModal } from './class/CreateClassModal';
import classes from './class/cards.module.css';

const ATTENTION_LIMIT = 8;
const UPCOMING_DAYS = 14;
const UPCOMING_LIMIT = 5;

/** "Ms. Rivera" stays whole; "Jordan Lee" becomes "Jordan". */
function greetingName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1 && /^(mr|mrs|ms|mx|dr|prof)\.?$/i.test(parts[0])) return name.trim();
  return parts[0] || name;
}

function StatCard({
  label,
  value,
  icon,
  color,
  hint,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  color: string;
  hint?: string;
}) {
  return (
    <Card padding="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            {label}
          </Text>
          <Text fz={28} fw={700} lh={1.2} component="div">
            {value}
          </Text>
          {hint && (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          )}
        </Stack>
        <ThemeIcon variant="light" color={color} size={40} radius="md" visibleFrom="xs" style={{ flexShrink: 0 }}>
          {icon}
        </ThemeIcon>
      </Group>
    </Card>
  );
}

function SummaryRow({
  classList,
  assignments,
}: {
  classList: ClassSummary[];
  assignments: AssignmentSummary[] | undefined;
}) {
  // A student in two classes counts twice, so this is enrollments rather than distinct students.
  const enrollments = classList.reduce((sum, c) => sum + c.studentCount, 0);
  const assignmentCount = classList.reduce((sum, c) => sum + c.assignmentCount, 0);
  const needsGrading = assignments?.reduce((sum, a) => sum + (a.counts?.needsGrading ?? 0), 0);
  return (
    <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md" mb="lg">
      <StatCard label="Classes" value={classList.length} icon={<IconSchool size={22} />} color="brand" />
      <StatCard
        label="Enrollments"
        value={enrollments}
        icon={<IconUsers size={22} />}
        color="blue"
        hint="Students counted once per class"
      />
      <StatCard label="Assignments" value={assignmentCount} icon={<IconClipboardList size={22} />} color="grape" />
      <StatCard
        label="Needs grading"
        value={needsGrading === undefined ? <Skeleton h={30} w={40} mt={4} /> : needsGrading}
        icon={<IconPencil size={22} />}
        color={needsGrading ? 'orange' : 'teal'}
        hint={needsGrading === 0 ? 'All caught up' : needsGrading ? 'Submissions waiting for you' : undefined}
      />
    </SimpleGrid>
  );
}

function AttentionRow({ a }: { a: AssignmentSummary }) {
  const needs = a.counts?.needsGrading ?? 0;
  // Only late work that still needs a score; graded late work needs no attention.
  const late = a.counts?.lateUngraded ?? a.counts?.late ?? 0;
  return (
    <UnstyledButton component={Link} to={`/teacher/assignments/${a.id}`} className={classes.row}>
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Stack gap={2} style={{ minWidth: 0, flex: '1 1 220px' }}>
          <Text fw={600} truncate>
            {a.title}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {a.className} · {isPast(a.dueAt) ? 'was due' : 'due'} {fromNow(a.dueAt)}
          </Text>
        </Stack>
        <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }} ml="auto">
          <NeedsGradingCountBadge count={needs} />
          <LateCountBadge count={late} />
          <IconChevronRight size={16} color="var(--mantine-color-dimmed)" />
        </Group>
      </Group>
    </UnstyledButton>
  );
}

function AttentionCard({ assignments }: { assignments: AssignmentSummary[] }) {
  // Late work is a subset of what needs grading (lateUngraded), so this also covers ungraded late work.
  const items = assignments
    .filter((a) => (a.counts?.needsGrading ?? 0) > 0)
    .sort((a, b) => (b.counts?.needsGrading ?? 0) - (a.counts?.needsGrading ?? 0) || a.dueAt.localeCompare(b.dueAt));
  const shown = items.slice(0, ATTENTION_LIMIT);
  return (
    <Card h="100%">
      <Group justify="space-between" mb="sm">
        <Title order={3} fz="h4">
          Needs your attention
        </Title>
        {items.length > 0 && (
          <Badge variant="light" color="orange">
            {items.length}
          </Badge>
        )}
      </Group>
      {items.length === 0 ? (
        <Group gap="sm" py="md" wrap="nowrap">
          <ThemeIcon color="teal" variant="light" size={36} radius="xl">
            <IconCircleCheck size={20} />
          </ThemeIcon>
          <Stack gap={0}>
            <Text fw={600}>You're all caught up</Text>
            <Text size="sm" c="dimmed">
              Nothing is waiting to be graded.
            </Text>
          </Stack>
        </Group>
      ) : (
        <Stack gap={2} mx="-md">
          {shown.map((a) => (
            <AttentionRow key={a.id} a={a} />
          ))}
          {items.length > shown.length && (
            <Text size="xs" c="dimmed" px="md" pt="xs">
              And {items.length - shown.length} more. Open a class to see all of its assignments.
            </Text>
          )}
        </Stack>
      )}
    </Card>
  );
}

function UpcomingCard({ assignments }: { assignments: AssignmentSummary[] }) {
  const horizon = Date.now() + UPCOMING_DAYS * 86_400_000;
  const items = assignments
    .filter((a) => !isPast(a.dueAt) && new Date(a.dueAt).getTime() <= horizon)
    .slice(0, UPCOMING_LIMIT);
  return (
    <Card h="100%">
      <Title order={3} fz="h4" mb="sm">
        Upcoming deadlines
      </Title>
      {items.length === 0 ? (
        <Group gap="sm" py="md" wrap="nowrap">
          <ThemeIcon color="gray" variant="light" size={36} radius="xl">
            <IconCalendarEvent size={20} />
          </ThemeIcon>
          <Text size="sm" c="dimmed">
            Nothing is due in the next {UPCOMING_DAYS} days.
          </Text>
        </Group>
      ) : (
        <Stack gap={2} mx="-md">
          {items.map((a) => {
            const submitted = a.counts?.submitted ?? 0;
            const total = a.counts?.students ?? 0;
            return (
              <UnstyledButton key={a.id} component={Link} to={`/teacher/assignments/${a.id}`} className={classes.row}>
                <Group justify="space-between" wrap="nowrap" gap="sm" mb={6}>
                  <Text fw={600} size="sm" truncate>
                    {a.title}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {fromNow(a.dueAt)}
                  </Text>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Progress
                    value={total > 0 ? (submitted / total) * 100 : 0}
                    size="sm"
                    style={{ flex: 1 }}
                    aria-label={`${submitted} of ${total} submitted`}
                  />
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {submitted}/{total} in
                  </Text>
                </Group>
              </UnstyledButton>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}

function ClassCard({ c }: { c: ClassSummary }) {
  return (
    <Card component={Link} to={`/teacher/classes/${c.id}`} className={classes.linkCard}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm" mb={6}>
        <Text fw={650} size="lg" lineClamp={2}>
          {c.name}
        </Text>
        {c.joinCode && (
          <Badge variant="default" tt="none" ff="monospace" style={{ flexShrink: 0 }} title="Join code">
            {c.joinCode}
          </Badge>
        )}
      </Group>
      <Text size="sm" c="dimmed" lineClamp={2} mb="md" style={{ flex: 1 }}>
        {c.description || 'No description'}
      </Text>
      <Group gap="lg">
        <Group gap={6}>
          <IconUsers size={16} color="var(--mantine-color-dimmed)" />
          <Text size="sm">
            {c.studentCount} {c.studentCount === 1 ? 'student' : 'students'}
          </Text>
        </Group>
        <Group gap={6}>
          <IconClipboardList size={16} color="var(--mantine-color-dimmed)" />
          <Text size="sm">
            {c.assignmentCount} {c.assignmentCount === 1 ? 'assignment' : 'assignments'}
          </Text>
        </Group>
      </Group>
    </Card>
  );
}

function NoClasses({ onCreate }: { onCreate: () => void }) {
  return (
    <Card py={48}>
      <EmptyState
        variant="light"
        size="lg"
        icon={<IconSchool size={32} />}
        title="Create your first class"
        description="Classes hold your students and assignments. Add students by email or share a join code, then post an assignment with its finished workbook and let the autograder do the checking."
      >
        <EmptyState.Actions>
          <Button size="md" leftSection={<IconPlus size={18} />} onClick={onCreate}>
            Create a class
          </Button>
        </EmptyState.Actions>
      </EmptyState>
    </Card>
  );
}

export function TeacherDashboard() {
  const user = useUser();
  usePageTitle('Dashboard');
  const [createOpen, setCreateOpen] = useState(false);
  const classList = useQuery({ queryKey: qk.classes, queryFn: endpoints.listClasses });
  const assignments = useQuery({ queryKey: qk.myAssignments, queryFn: endpoints.listMyAssignments });

  return (
    <>
      <PageHeader
        title={`Welcome back, ${greetingName(user.name)}`}
        subtitle="Here's what's happening across your classes."
        actions={
          <Button leftSection={<IconPlus size={18} />} onClick={() => setCreateOpen(true)}>
            New class
          </Button>
        }
      />

      <QueryState query={classList} loadingLabel="Loading your classes…">
        {(list) =>
          list.length === 0 ? (
            <NoClasses onCreate={() => setCreateOpen(true)} />
          ) : (
            <>
              <SummaryRow classList={list} assignments={assignments.data} />
              {assignments.error ? (
                <ErrorAlert
                  error={assignments.error}
                  title="Could not load assignments"
                  onRetry={() => assignments.refetch()}
                />
              ) : (
                <Grid gap="md" mb="xl">
                  <Grid.Col span={{ base: 12, md: 7 }}>
                    {assignments.data ? <AttentionCard assignments={assignments.data} /> : <Skeleton h={220} />}
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 5 }}>
                    {assignments.data ? <UpcomingCard assignments={assignments.data} /> : <Skeleton h={220} />}
                  </Grid.Col>
                </Grid>
              )}

              <Group justify="space-between" mb="sm" mt={assignments.error ? 'xl' : undefined}>
                <Title order={3} fz="h4">
                  Your classes
                </Title>
                <Text size="sm" c="dimmed">
                  {list.length} {list.length === 1 ? 'class' : 'classes'}
                </Text>
              </Group>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
                {list.map((c) => (
                  <ClassCard key={c.id} c={c} />
                ))}
              </SimpleGrid>
            </>
          )
        }
      </QueryState>

      <CreateClassModal opened={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
