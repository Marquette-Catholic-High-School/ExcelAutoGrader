import { Button, CopyButton, type ButtonProps } from '@mantine/core';
import { IconCheck, IconClipboardCopy } from '@tabler/icons-react';
import type { ClassSummary } from '@shared/types';

/** Text a teacher can paste into an email or the class page to tell invited students how to sign up. */
export function signUpInstructions(cls: Pick<ClassSummary, 'name' | 'joinCode'>): string {
  const origin = window.location.origin;
  const lines = [
    `How to join ${cls.name} on Excel Autograder:`,
    '',
    `1. Open ${origin}/register`,
    '2. Choose "I\'m a student".',
    '3. Sign up with your school email, the same address your teacher used to add you to the class.',
    ...(cls.joinCode ? [`4. If you're asked for a class code, enter ${cls.joinCode}.`] : []),
    '',
    `You'll be placed in ${cls.name} automatically and see your assignments, including any work your teacher ` +
      'already uploaded for you.',
    `Already have an account? Just sign in at ${origin}/login.`,
  ];
  if (cls.joinCode) {
    lines.push(
      `Signing up with a different email? After signing up, choose "Join a class" on your dashboard and enter the ` +
        `code ${cls.joinCode}.`,
    );
  }
  return lines.join('\n');
}

/** "Copy sign-up instructions" button for the roster and the add-students result. */
export function CopyInstructionsButton({
  cls,
  ...buttonProps
}: { cls: Pick<ClassSummary, 'name' | 'joinCode'> } & ButtonProps) {
  return (
    <CopyButton value={signUpInstructions(cls)} timeout={2000}>
      {({ copied, copy }) => (
        <Button
          variant="light"
          size="xs"
          color={copied ? 'teal' : undefined}
          leftSection={copied ? <IconCheck size={14} /> : <IconClipboardCopy size={14} />}
          {...buttonProps}
          onClick={copy}
        >
          {copied ? 'Instructions copied' : 'Copy sign-up instructions'}
        </Button>
      )}
    </CopyButton>
  );
}
