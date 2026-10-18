import type { ReactNode } from 'react';
import { Anchor, Breadcrumbs, Group, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router';

export interface Crumb {
  label: string;
  to?: string;
}

/** Consistent page title row: breadcrumbs, title, optional subtitle and right-aligned actions. */
export function PageHeader({
  title,
  subtitle,
  crumbs,
  actions,
  badges,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  badges?: ReactNode;
}) {
  return (
    <Stack gap={6} mb="lg">
      {crumbs && crumbs.length > 0 && (
        <Breadcrumbs separatorMargin={6} fz="sm">
          {crumbs.map((c, i) =>
            c.to ? (
              <Anchor key={i} component={Link} to={c.to} fz="sm">
                {c.label}
              </Anchor>
            ) : (
              <Text key={i} fz="sm" c="dimmed">
                {c.label}
              </Text>
            ),
          )}
        </Breadcrumbs>
      )}
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        {/* The 260px basis makes wide actions wrap below the title instead of squeezing it into a sliver. */}
        <Stack gap={4} style={{ minWidth: 0, flex: '1 1 260px' }}>
          <Group gap="sm" wrap="wrap">
            <Title order={2} style={{ wordBreak: 'break-word' }}>
              {title}
            </Title>
            {badges}
          </Group>
          {subtitle && (
            <Text c="dimmed" size="sm">
              {subtitle}
            </Text>
          )}
        </Stack>
        {actions && <Group gap="sm">{actions}</Group>}
      </Group>
    </Stack>
  );
}
