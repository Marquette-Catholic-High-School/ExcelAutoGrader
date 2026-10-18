import type { ReactNode } from 'react';
import { Card, EmptyState, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconClipboardList } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { AssignmentSummary, ClassSummary } from '@shared/types';
import { endpoints, qk } from '../../api/endpoints';
import { isNotFoundError } from '../../components/NotFoundCard';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, PageLoader, QueryState } from '../../components/QueryState';
import { formatScore, isPast, percent, scoreTextColor } from '../../utils/format';
import { parseId } from '../../utils/params';
import { usePageTitle } from '../../utils/usePageTitle';
import { ClassNotFound } from '../teacher/class/ClassNotFound';
import { StudentAssignmentItem } from './dashboard/StudentAssignmentItem';

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card padding="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text fz={26} fw={700} lh={1.3} component="div">
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Card>
  );
}

/** Same rule as the teacher's gradebook total: graded work only. */
function gradeSoFar(list: AssignmentSummary[]) {
  let earned = 0;
  let possible = 0;
  for (const a of list) {
    const score = a.mine?.finalScore;
    if (a.mine?.status !== 'graded' || score === null || score === undefined) continue;
    earned += score;
    possible += a.points;
  }
  return { earned, possible, pct: possible > 0 ? percent(earned, possible) : null };
}

function Summary({ list }: { list: AssignmentSummary[] }) {
  const turnedIn = list.filter((a) => a.mine?.status === 'submitted' || a.mine?.status === 'graded').length;
  const missing = list.filter((a) => a.mine?.status === 'missing').length;
  const grade = gradeSoFar(list);
  return (
    <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="md" mb="lg">
      <Stat label="Turned in" value={`${turnedIn} / ${list.length}`} hint="assignments submitted" />
      <Stat
        label="Missing"
        value={<Text span inherit c={missing > 0 ? 'red' : undefined}>{missing}</Text>}
        hint={missing > 0 ? 'Late uploads are still accepted' : 'Nothing overdue'}
      />
      <Stat
        label="Grade so far"
        value={
          grade.pct === null ? (
            '—'
          ) : (
            <Text span inherit c={scoreTextColor(grade.pct)}>
              {grade.pct}%
            </Text>
          )
        }
        hint={
          grade.pct === null
            ? 'No graded work yet'
            : `${formatScore(grade.earned)} of ${formatScore(grade.possible)} points on graded work`
        }
      />
    </SimpleGrid>
  );
}

function AssignmentGroup({ title, items }: { title: string; items: AssignmentSummary[] }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Title order={3} fz="h4">
          {title}
        </Title>
        <Text size="sm" c="dimmed">
          {items.length}
        </Text>
      </Group>
      <Stack gap={2} mx="-md">
        {items.map((a) => (
          <StudentAssignmentItem key={a.id} a={a} showClass={false} showMode />
        ))}
      </Stack>
    </Card>
  );
}

function Assignments({ classId }: { classId: number }) {
  const query = useQuery({
    queryKey: qk.classAssignments(classId),
    queryFn: () => endpoints.listClassAssignments(classId),
  });
  return (
    <QueryState query={query} loadingLabel="Loading assignments…">
      {(list) => {
        if (list.length === 0) {
          return (
            <Card py={48}>
              <EmptyState
                variant="light"
                size="md"
                icon={<IconClipboardList size={32} />}
                title="No assignments yet"
                description="Your teacher hasn't posted any assignments in this class. Check back soon."
              />
            </Card>
          );
        }
        const upcoming = list.filter((a) => !isPast(a.dueAt));
        const past = list.filter((a) => isPast(a.dueAt)).reverse();
        return (
          <>
            <Summary list={list} />
            <Stack gap="md">
              <AssignmentGroup title="Upcoming" items={upcoming} />
              <AssignmentGroup title="Past due date" items={past} />
            </Stack>
          </>
        );
      }}
    </QueryState>
  );
}

function ClassHeader({ cls }: { cls: ClassSummary }) {
  usePageTitle(cls.name);
  return (
    <PageHeader
      crumbs={[{ label: 'Dashboard', to: '/student' }, { label: cls.name }]}
      title={cls.name}
      subtitle={
        <>
          Taught by {cls.teacherName}
          {cls.description && (
            <Text span display="block" mt={4} size="sm" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
              {cls.description}
            </Text>
          )}
        </>
      }
    />
  );
}

export function StudentClassPage() {
  const classId = parseId(useParams().classId);
  const query = useQuery({
    queryKey: qk.class(classId ?? 0),
    queryFn: () => endpoints.getClass(classId ?? 0),
    enabled: classId !== null,
  });
  const notFound = (
    <ClassNotFound
      home="/student"
      description="This class may have been deleted, you may no longer be enrolled, or the link is not quite right."
    />
  );

  if (classId === null) return notFound;
  if (query.isPending) return <PageLoader label="Loading class…" />;
  if (isNotFoundError(query.error)) return notFound;
  if (query.error || !query.data) return <ErrorAlert error={query.error} onRetry={() => query.refetch()} />;
  return (
    <>
      <ClassHeader cls={query.data} />
      <Assignments classId={query.data.id} />
    </>
  );
}
