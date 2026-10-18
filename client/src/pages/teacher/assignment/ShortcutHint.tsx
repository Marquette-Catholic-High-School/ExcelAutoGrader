import { Fragment } from 'react';
import { Kbd, Text, type TextProps } from '@mantine/core';
import { useOs } from '@mantine/hooks';

/** "⌘" on Apple platforms, "Ctrl" elsewhere. */
export function useModKeyLabel(): string {
  const os = useOs();
  return os === 'macos' || os === 'ios' ? '⌘' : 'Ctrl';
}

/** Renders a keyboard shortcut such as ["mod", "Enter"] as <Kbd> keys. */
export function ShortcutHint({ keys, ...props }: { keys: string[] } & TextProps) {
  const mod = useModKeyLabel();
  return (
    <Text span size="xs" c="dimmed" {...props}>
      {keys.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && ' + '}
          <Kbd size="xs">{k === 'mod' ? mod : k}</Kbd>
        </Fragment>
      ))}
    </Text>
  );
}
