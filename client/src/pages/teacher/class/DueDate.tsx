import { Stack, Text, Tooltip } from '@mantine/core';
import { formatDateTime, fromNow, isPast } from '../../../utils/format';

/** Due date with a relative hint underneath; red once the due date has passed. */
export function DueDate({ dueAt, size = 'sm' }: { dueAt: string; size?: 'xs' | 'sm' }) {
  const past = isPast(dueAt);
  return (
    <Stack gap={0}>
      <Text size={size} c={past ? 'red' : undefined} fw={500} style={{ whiteSpace: 'nowrap' }}>
        {formatDateTime(dueAt)}
      </Text>
      <Tooltip label={past ? 'The due date has passed. Late uploads are still accepted.' : 'Time until due'}>
        <Text size="xs" c={past ? 'red' : 'dimmed'} w="fit-content">
          {past ? `Was due ${fromNow(dueAt)}` : `Due ${fromNow(dueAt)}`}
        </Text>
      </Tooltip>
    </Stack>
  );
}
