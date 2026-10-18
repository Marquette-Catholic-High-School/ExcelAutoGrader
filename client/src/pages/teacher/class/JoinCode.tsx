import { ActionIcon, Badge, CopyButton, Text, Tooltip, type MantineSize } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';

/** Copy-to-clipboard icon button for a short value such as a join code or a temporary password. */
export function CopyIconButton({ value, label, size = 'sm' }: { value: string; label: string; size?: MantineSize }) {
  return (
    <CopyButton value={value} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copied' : label}>
          <ActionIcon
            variant="subtle"
            color={copied ? 'teal' : 'gray'}
            size={size}
            onClick={copy}
            aria-label={copied ? 'Copied' : label}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}

/** "Join code ABC123 [copy]" chip for the class header. */
export function JoinCodeChip({ code }: { code: string }) {
  return (
    <Badge
      size="xl"
      variant="light"
      color="gray"
      tt="none"
      fw={500}
      pr={4}
      rightSection={<CopyIconButton value={code} label="Copy join code" size="sm" />}
    >
      Join code{' '}
      <Text span ff="monospace" fw={700} fz="sm" style={{ letterSpacing: 1.5 }}>
        {code}
      </Text>
    </Badge>
  );
}
