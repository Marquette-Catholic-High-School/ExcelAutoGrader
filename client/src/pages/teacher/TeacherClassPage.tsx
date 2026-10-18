import { Badge, Tabs } from '@mantine/core';
import { IconClipboardList, IconSettings, IconTable, IconUsers } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import type { ClassSummary } from '@shared/types';
import { endpoints, qk } from '../../api/endpoints';
import { isNotFoundError } from '../../components/NotFoundCard';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, PageLoader } from '../../components/QueryState';
import { parseId } from '../../utils/params';
import { usePageTitle } from '../../utils/usePageTitle';
import { AssignmentsPanel } from './class/AssignmentsPanel';
import { ClassNotFound } from './class/ClassNotFound';
import { GradebookPanel } from './class/GradebookPanel';
import { JoinCodeChip } from './class/JoinCode';
import { SettingsPanel } from './class/SettingsPanel';
import { StudentsPanel } from './class/StudentsPanel';

const TABS = ['assignments', 'students', 'gradebook', 'settings'] as const;
type ClassTab = (typeof TABS)[number];

function isClassTab(value: string | null): value is ClassTab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

function ClassView({ cls }: { cls: ClassSummary }) {
  usePageTitle(cls.name);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: ClassTab = isClassTab(requested) ? requested : 'assignments';

  function selectTab(value: string | null) {
    const next = isClassTab(value) ? value : 'assignments';
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        updated.set('tab', next);
        return updated;
      },
      { replace: true },
    );
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Dashboard', to: '/teacher' }, { label: cls.name }]}
        title={cls.name}
        subtitle={cls.description || undefined}
        badges={cls.joinCode ? <JoinCodeChip code={cls.joinCode} /> : undefined}
      />
      <Tabs value={tab} onChange={selectTab} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab
            value="assignments"
            leftSection={<IconClipboardList size={16} />}
            rightSection={
              <Badge size="xs" variant="light" circle>
                {cls.assignmentCount}
              </Badge>
            }
          >
            Assignments
          </Tabs.Tab>
          <Tabs.Tab
            value="students"
            leftSection={<IconUsers size={16} />}
            rightSection={
              <Badge size="xs" variant="light" circle>
                {cls.studentCount}
              </Badge>
            }
          >
            Students
          </Tabs.Tab>
          <Tabs.Tab value="gradebook" leftSection={<IconTable size={16} />}>
            Gradebook
          </Tabs.Tab>
          <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
            Settings
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="assignments">
          <AssignmentsPanel classId={cls.id} />
        </Tabs.Panel>
        <Tabs.Panel value="students">
          <StudentsPanel cls={cls} />
        </Tabs.Panel>
        <Tabs.Panel value="gradebook">
          <GradebookPanel classId={cls.id} />
        </Tabs.Panel>
        <Tabs.Panel value="settings">
          <SettingsPanel cls={cls} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

export function TeacherClassPage() {
  const classId = parseId(useParams().classId);
  const query = useQuery({
    queryKey: qk.class(classId ?? 0),
    queryFn: () => endpoints.getClass(classId ?? 0),
    enabled: classId !== null,
  });

  if (classId === null) return <ClassNotFound home="/teacher" />;
  if (query.isPending) return <PageLoader label="Loading class…" />;
  if (isNotFoundError(query.error)) return <ClassNotFound home="/teacher" />;
  if (query.error || !query.data) return <ErrorAlert error={query.error} onRetry={() => query.refetch()} />;
  return <ClassView key={query.data.id} cls={query.data} />;
}
