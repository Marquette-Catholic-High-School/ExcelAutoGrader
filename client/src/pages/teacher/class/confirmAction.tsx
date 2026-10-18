import type { ReactNode } from 'react';
import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';

/**
 * Confirmation dialog that stays open with a spinner while `action` runs, then closes.
 * Errors are expected to be reported by the caller (e.g. a mutation's onError); the dialog just closes.
 */
export function confirmAction({
  title,
  message,
  confirmLabel,
  color,
  action,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  color: string;
  action: () => Promise<unknown>;
}) {
  const modalId = modals.openConfirmModal({
    title,
    children: typeof message === 'string' ? <Text size="sm">{message}</Text> : message,
    labels: { confirm: confirmLabel, cancel: 'Cancel' },
    confirmProps: { color },
    closeOnConfirm: false,
    onConfirm: async () => {
      modals.updateModal({
        modalId,
        confirmProps: { color, loading: true },
        closeOnClickOutside: false,
        closeOnEscape: false,
      });
      try {
        await action();
      } catch {
        // reported by the caller
      } finally {
        modals.close(modalId);
      }
    },
  });
}
