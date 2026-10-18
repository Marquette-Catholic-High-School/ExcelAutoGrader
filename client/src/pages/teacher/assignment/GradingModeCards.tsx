import type { ReactNode } from 'react';
import { Badge, Group, Radio, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconPencil, IconRobot } from '@tabler/icons-react';
import type { GradingMode } from '@shared/types';
import classes from './assignment.module.css';

function ModeCard({
  value,
  icon,
  color,
  title,
  badge,
  children,
}: {
  value: GradingMode;
  icon: ReactNode;
  color: string;
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Radio.Card value={value} radius="md" className={classes.modeCard} aria-label={title}>
      <Group wrap="nowrap" align="flex-start" gap="md">
        <Radio.Indicator mt={4} />
        <ThemeIcon size={42} radius="md" variant="light" color={color}>
          {icon}
        </ThemeIcon>
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Group gap={8} wrap="wrap">
            <Text fw={650} size="md">
              {title}
            </Text>
            {badge}
          </Group>
          <Text size="sm" c="dimmed">
            {children}
          </Text>
        </Stack>
      </Group>
    </Radio.Card>
  );
}

/** The two large "How should this be graded?" choices. */
export function GradingModeCards({ value, onChange }: { value: GradingMode; onChange: (mode: GradingMode) => void }) {
  return (
    <Radio.Group value={value} onChange={(v) => onChange(v as GradingMode)} aria-label="How should this be graded?">
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <ModeCard
          value="auto"
          icon={<IconRobot size={24} />}
          color="brand"
          title="Autograde with an answer key"
          badge={
            <Badge size="sm" variant="light" color="brand">
              Recommended
            </Badge>
          }
        >
          Upload the finished workbook. Every submission is scored the moment it is uploaded, cell by cell, and you
          can still adjust any score.
        </ModeCard>
        <ModeCard value="manual" icon={<IconPencil size={24} />} color="indigo" title="Grade manually">
          No answer key needed. Open each student's workbook in the built-in viewer and enter a score and feedback
          yourself.
        </ModeCard>
      </SimpleGrid>
    </Radio.Group>
  );
}
