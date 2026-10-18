import type { ReactNode } from 'react';
import { Alert, Button, Center, Loader, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconAlertCircle, IconPlugConnectedX, IconRefresh } from '@tabler/icons-react';
import { errorMessage } from '../utils/errors';

/** Full-area loader for pages and panels. */
export function PageLoader({ label }: { label?: string }) {
  return (
    <Center py="xl">
      <Stack align="center" gap="xs">
        <Loader />
        {label && <span style={{ color: 'var(--mantine-color-dimmed)' }}>{label}</span>}
      </Stack>
    </Center>
  );
}

export function ErrorAlert({ error, onRetry, title = 'Could not load this' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <Alert color="red" icon={<IconAlertCircle />} title={title}>
      <Stack gap="xs" align="flex-start">
        <span>{errorMessage(error)}</span>
        {onRetry && (
          <Button size="xs" variant="white" color="red" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

/**
 * Renders loader / error / children for a TanStack query result.
 *   <QueryState query={q}>{(data) => <List items={data} />}</QueryState>
 */
export function QueryState<T>({
  query,
  children,
  loadingLabel,
}: {
  query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown };
  children: (data: T) => ReactNode;
  loadingLabel?: string;
}) {
  if (query.isPending) return <PageLoader label={loadingLabel} />;
  if (query.error || query.data === undefined) return <ErrorAlert error={query.error} onRetry={() => query.refetch()} />;
  return <>{children(query.data)}</>;
}

/**
 * Full-page card for when the saved session can't be checked because the server is unreachable. The session is
 * kept; the caller retries automatically and `onRetry` checks again right away.
 */
export function ServerUnreachable({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <Center mih="100vh" px="md" py="xl">
      <Paper withBorder shadow="sm" p={{ base: 'lg', xs: 'xl' }} w="100%" maw={440}>
        <Stack align="center" gap="md" ta="center">
          <ThemeIcon size={52} radius="xl" variant="light" color="orange" aria-hidden>
            <IconPlugConnectedX size={28} />
          </ThemeIcon>
          <Stack gap={6} role="alert">
            <Title order={2} fz="h3">
              Can't reach the server
            </Title>
            <Text size="sm" c="dimmed">
              {message}
            </Text>
            <Text size="sm">
              You're still signed in. This page keeps trying and continues as soon as the server answers.
            </Text>
          </Stack>
          <Button onClick={onRetry} loading={retrying} leftSection={<IconRefresh size={18} />}>
            Retry
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
