/**
 * Assignment-level summary badges shared by the teacher and student pages. The per-submission LATE flag is
 * LateBadge / LateAlert in StatusBadges.tsx; these summarize a whole assignment.
 */
import { Badge, type MantineSize } from '@mantine/core';
import { IconClock, IconClockExclamation, IconPencil } from '@tabler/icons-react';
import { BADGE_NO_SHRINK } from './StatusBadges';

/** The assignment's due date has passed (uploads are still accepted, and flagged late). */
export function PastDueBadge({ size = 'sm' }: { size?: MantineSize }) {
  return (
    <Badge color="red" variant="light" size={size} leftSection={<IconClock size={12} />} {...BADGE_NO_SHRINK}>
      Past due
    </Badge>
  );
}

/** "3 late": students whose latest submission came in after the due date. Renders nothing for 0. */
export function LateCountBadge({ count, size = 'md' }: { count: number; size?: MantineSize }) {
  if (count <= 0) return null;
  return (
    <Badge
      color="red"
      variant="light"
      size={size}
      leftSection={<IconClockExclamation size={12} />}
      {...BADGE_NO_SHRINK}
    >
      {count} late
    </Badge>
  );
}

/** "2 to grade": latest submissions still waiting for a score. Renders nothing for 0. */
export function NeedsGradingCountBadge({ count, size = 'md' }: { count: number; size?: MantineSize }) {
  if (count <= 0) return null;
  return (
    <Badge color="orange" variant="light" size={size} leftSection={<IconPencil size={12} />} {...BADGE_NO_SHRINK}>
      {count} to grade
    </Badge>
  );
}
