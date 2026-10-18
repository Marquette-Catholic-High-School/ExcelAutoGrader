import { useCallback, useEffect, useRef } from 'react';
import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useBlocker, type BlockerFunction } from 'react-router';

interface GuardOptions {
  title?: string;
  message?: string;
}

const DEFAULT_TITLE = 'Discard unsaved changes?';
const DEFAULT_MESSAGE = 'You have changes that have not been saved yet. If you leave now they will be lost.';
/** One prompt at a time: Mantine ignores opening a modal whose id is already open. */
const MODAL_ID = 'unsaved-changes';

/**
 * Protects unsaved edits while `dirty` is true:
 * - warns before the tab is closed or reloaded,
 * - blocks in-app navigation to another page (links, breadcrumbs, sidebar, `navigate()`, browser Back/Forward)
 *   and asks for confirmation first,
 * - `guard(action)` runs `action` right away when clean, otherwise after the user confirms discarding their
 *   changes (for actions that discard the draft without leaving the page, and for explicit navigation buttons),
 * - `bypass(fn)` runs `fn` with the navigation block switched off, e.g. to leave the page after a save.
 */
export function useUnsavedChangesGuard(dirty: boolean, options: GuardOptions = {}) {
  const dirtyRef = useRef(dirty);
  const bypassRef = useRef(false);
  const promptOpenRef = useRef(false);
  const textRef = useRef({ title: DEFAULT_TITLE, message: DEFAULT_MESSAGE });

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    textRef.current = { title: options.title ?? DEFAULT_TITLE, message: options.message ?? DEFAULT_MESSAGE };
  }, [options.title, options.message]);

  /** Opens the confirm modal unless one is already showing; `onKeep` runs when it closes without discarding. */
  const confirm = useCallback((onDiscard: () => void, onKeep?: () => void) => {
    if (promptOpenRef.current) {
      onKeep?.();
      return;
    }
    promptOpenRef.current = true;
    let discarded = false;
    modals.openConfirmModal({
      modalId: MODAL_ID,
      title: textRef.current.title,
      children: <Text size="sm">{textRef.current.message}</Text>,
      labels: { confirm: 'Discard changes', cancel: 'Keep editing' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        discarded = true;
        onDiscard();
      },
      // Runs after onConfirm, and on Keep editing, Escape, the close button or a click outside.
      onClose: () => {
        promptOpenRef.current = false;
        if (!discarded) onKeep?.();
      },
    });
  }, []);

  const bypass = useCallback((fn: () => void) => {
    bypassRef.current = true;
    try {
      fn();
    } finally {
      // The router checks blockers synchronously when navigate() is called; re-arm once that has happened.
      window.setTimeout(() => {
        bypassRef.current = false;
      }, 0);
    }
  }, []);

  const guard = useCallback(
    (action: () => void) => {
      if (dirtyRef.current) confirm(() => bypass(action));
      else action();
    },
    [confirm, bypass],
  );

  // Only leaving the page counts: search-param changes on the same page keep the draft.
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && !bypassRef.current && currentLocation.pathname !== nextLocation.pathname,
    [],
  );
  const blocker = useBlocker(shouldBlock);

  // The blocked navigation (or history entry) waits until the teacher decides. `blocker` keeps the same identity
  // while blocked, so this prompts once per blocked navigation.
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    confirm(
      () => blocker.proceed(),
      () => blocker.reset(),
    );
  }, [blocker, confirm]);

  // Don't leave a prompt behind if the page goes away for another reason.
  useEffect(() => () => modals.close(MODAL_ID), []);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  return { guard, bypass };
}
