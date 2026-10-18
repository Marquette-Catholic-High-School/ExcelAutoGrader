import { Card, Group, Text } from '@mantine/core';
import { IconClipboardList, IconUser } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { ClassSummary } from '@shared/types';
import classes from './items.module.css';

export function StudentClassCard({ c }: { c: ClassSummary }) {
  return (
    <Card component={Link} to={`/student/classes/${c.id}`} className={classes.linkCard} padding="md">
      <Text fw={650} size="lg" lineClamp={2} mb={4}>
        {c.name}
      </Text>
      <Group gap={6} mb="xs">
        <IconUser size={14} color="var(--mantine-color-dimmed)" />
        <Text size="sm" c="dimmed">
          {c.teacherName}
        </Text>
      </Group>
      {c.description && (
        <Text size="sm" c="dimmed" lineClamp={2} mb="sm">
          {c.description}
        </Text>
      )}
      <Group gap={6} mt="auto">
        <IconClipboardList size={16} color="var(--mantine-color-dimmed)" />
        <Text size="sm">
          {c.assignmentCount} {c.assignmentCount === 1 ? 'assignment' : 'assignments'}
        </Text>
      </Group>
    </Card>
  );
}
