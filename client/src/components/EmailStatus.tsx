import { Alert, Code } from '@mantine/core';
import { IconMailOff } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { EmailStatus } from '@shared/types';
import { endpoints, qk } from '../api/endpoints';

/** Whether this server can send email, its sender and time zone. */
export function useEmailStatus() {
  return useQuery({ queryKey: qk.emailStatus, queryFn: endpoints.getEmailStatus });
}

/** "Podner's Excel <noreply@mchstech.org>" */
export function senderLabel(status: EmailStatus): string {
  return `${status.fromName} <${status.fromAddress}>`;
}

/** Yellow notice while the server has no Cloudflare API token; renders nothing once email works (or while loading). */
export function EmailNotConfiguredAlert({ status }: { status: EmailStatus | undefined }) {
  if (!status || status.configured) return null;
  return (
    <Alert color="yellow" variant="light" icon={<IconMailOff />} title="Email isn't set up on this server yet">
      Settings are saved, but nothing is sent until the Cloudflare API token is added (run the update script or{' '}
      <Code>npm run email-setup</Code> on the server).
    </Alert>
  );
}
