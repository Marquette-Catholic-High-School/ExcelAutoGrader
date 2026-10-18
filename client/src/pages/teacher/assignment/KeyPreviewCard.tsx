import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Code, Group, List, Loader, Paper, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconFileAlert, IconListCheck, IconTable } from '@tabler/icons-react';
import type { GradingConfig, KeyPreview } from '@shared/types';
import { endpoints } from '../../../api/endpoints';
import { errorMessage, fieldErrors } from '../../../utils/errors';

export interface KeyPreviewInput {
  config: GradingConfig;
  /** A newly chosen key file; when absent the server uses the stored key of `assignmentId`. */
  keyFile: File | null;
  templateFile: File | null;
  /** Edit mode: lets the server fall back to the stored key/template. */
  assignmentId?: number;
  /** The teacher is removing the stored template in the form. */
  ignoreStoredTemplate?: boolean;
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; data?: KeyPreview }
  | { status: 'success'; data: KeyPreview }
  | { status: 'error'; error: unknown };

const DEBOUNCE_MS = 400;

function plural(n: number, word: string) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Debounced POST /api/grader/preview for the given input. Responses for superseded inputs are ignored.
 * Reports server field errors (keyFile / templateFile / gradingConfig) through onFieldErrors, or {} on success.
 */
function useKeyPreview(input: KeyPreviewInput, onFieldErrors?: (fields: Record<string, string>) => void) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const callbackRef = useRef(onFieldErrors);
  const { keyFile, templateFile, assignmentId, ignoreStoredTemplate } = input;
  const configJson = JSON.stringify(input.config);
  const needsRanges = input.config.scope === 'ranges' && input.config.ranges.length === 0;

  useEffect(() => {
    callbackRef.current = onFieldErrors;
  });

  useEffect(() => {
    if (needsRanges) {
      setState({ status: 'idle' });
      callbackRef.current?.({});
      return;
    }
    let stale = false;
    setState((prev) => ({ status: 'loading', data: 'data' in prev ? prev.data : undefined }));
    const timer = window.setTimeout(() => {
      const config = JSON.parse(configJson) as GradingConfig;
      endpoints
        .previewKey({ config, keyFile, templateFile, assignmentId, ignoreStoredTemplate })
        .then((data) => {
          if (stale) return;
          setState({ status: 'success', data });
          callbackRef.current?.({});
        })
        .catch((error: unknown) => {
          if (stale) return;
          setState({ status: 'error', error });
          callbackRef.current?.(fieldErrors(error));
        });
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [configJson, keyFile, templateFile, assignmentId, ignoreStoredTemplate, needsRanges]);

  return state;
}

function PreviewSummary({ preview }: { preview: KeyPreview }) {
  const graded = preview.sheets.filter((s) => s.gradedCells > 0);
  const skipped = preview.sheets.filter((s) => s.gradedCells === 0);

  if (preview.totalCells === 0) {
    return (
      <Alert color="red" variant="light" icon={<IconFileAlert />} title="Nothing would be graded">
        With these settings no cells in your answer key would be checked. Make sure the key has the answers filled
        in, or change which cells are checked under Grading options.
      </Alert>
    );
  }

  return (
    <Stack gap="sm">
      <Text size="sm">
        The autograder will check <strong>{plural(preview.totalCells, 'cell')}</strong> on{' '}
        <strong>{plural(graded.length, 'sheet')}</strong> ({preview.formulaCells.toLocaleString()} with formulas).
      </Text>
      <Stack gap={8}>
        {graded.map((sheet) => {
          const more = sheet.gradedCells - sheet.sampleAddresses.length;
          return (
            <Group key={sheet.name} gap="xs" wrap="nowrap" align="flex-start">
              <IconTable size={16} style={{ flexShrink: 0, marginTop: 3 }} color="var(--mantine-color-dimmed)" />
              <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} style={{ wordBreak: 'break-word' }}>
                  {sheet.name}
                </Text>
                <Badge variant="light" size="sm">
                  {plural(sheet.gradedCells, 'cell')}
                </Badge>
                {sheet.sampleAddresses.map((address) => (
                  <Code key={address} fz="xs">
                    {address}
                  </Code>
                ))}
                {more > 0 && (
                  <Text size="xs" c="dimmed">
                    +{more.toLocaleString()} more
                  </Text>
                )}
              </Group>
            </Group>
          );
        })}
      </Stack>
      {skipped.length > 0 && (
        <Text size="xs" c="dimmed">
          Nothing to check on: {skipped.map((s) => s.name).join(', ')}
        </Text>
      )}
      {preview.warnings.length > 0 && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle />} title="Worth a look" p="sm">
          <List size="sm" spacing={4}>
            {preview.warnings.map((w, i) => (
              <List.Item key={i}>{w}</List.Item>
            ))}
          </List>
        </Alert>
      )}
    </Stack>
  );
}

function PreviewError({ error }: { error: unknown }) {
  const message = errorMessage(error);
  const extra = Object.values(fieldErrors(error)).filter((m) => m !== message);
  return (
    <Alert color="red" variant="light" icon={<IconFileAlert />} title="The autograder can't use this yet">
      <Stack gap={4}>
        <Text size="sm">{message}</Text>
        {extra.map((m, i) => (
          <Text key={i} size="sm">
            {m}
          </Text>
        ))}
      </Stack>
    </Alert>
  );
}

/** Live "what will be graded" summary for the answer key + options currently in the form. */
export function KeyPreviewCard({
  input,
  onFieldErrors,
}: {
  input: KeyPreviewInput;
  onFieldErrors?: (fields: Record<string, string>) => void;
}) {
  const state = useKeyPreview(input, onFieldErrors);
  const data = state.status === 'success' || state.status === 'loading' ? state.data : undefined;

  return (
    <Paper withBorder p="md" radius="md" aria-live="polite" aria-busy={state.status === 'loading'}>
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Group gap={8} wrap="nowrap">
          <ThemeIcon variant="light" size="md" radius="md">
            <IconListCheck size={16} />
          </ThemeIcon>
          <Text fw={600} size="sm">
            Autograder preview
          </Text>
        </Group>
        {state.status === 'loading' && (
          <Group gap={6} wrap="nowrap">
            <Loader size={14} />
            <Text size="xs" c="dimmed">
              {data ? 'Updating…' : 'Reading your answer key…'}
            </Text>
          </Group>
        )}
      </Group>

      {state.status === 'idle' && (
        <Text size="sm" c="dimmed">
          Add at least one range under Grading options to see which cells will be checked.
        </Text>
      )}
      {state.status === 'error' && <PreviewError error={state.error} />}
      {data && <PreviewSummary preview={data} />}
      {state.status === 'loading' && !data && (
        <Stack gap={8}>
          <Skeleton h={14} w="70%" />
          <Skeleton h={14} w="45%" />
          <Skeleton h={14} w="55%" />
        </Stack>
      )}
    </Paper>
  );
}
