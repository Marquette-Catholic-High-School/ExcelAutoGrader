import { useState, type ReactNode } from 'react';
import { Button, Group, Input, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconArrowBackUp, IconDownload, IconFileSpreadsheet, IconReplace, IconTrash } from '@tabler/icons-react';
import type { FileInfo } from '@shared/types';
import { FileDropzone } from '../../../components/FileDropzone';
import { formatFileSize } from '../../../utils/format';
import classes from './assignment.module.css';

export interface FileSlotProps {
  label: string;
  description?: string;
  /** The file already saved on the server (edit mode). */
  stored?: FileInfo | null;
  /** A newly chosen file that will be uploaded on save. */
  file: File | null;
  onFile: (file: File | null) => void;
  error?: ReactNode;
  required?: boolean;
  /** Offer "Remove" for the stored file. */
  removable?: boolean;
  removed?: boolean;
  onRemovedChange?: (removed: boolean) => void;
  onDownloadStored?: () => void;
}

/**
 * A single spreadsheet upload field that also understands an already-saved file:
 * shows the saved file with Download / Replace / Remove, or a dropzone for a new one.
 */
export function FileSlot({
  label,
  description,
  stored,
  file,
  onFile,
  error,
  required,
  removable,
  removed,
  onRemovedChange,
  onDownloadStored,
}: FileSlotProps) {
  const [replacing, setReplacing] = useState(false);
  const errorText = typeof error === 'string' ? error : undefined;

  if (stored && removed) {
    return (
      <Input.Wrapper label={label} description={description}>
        <Paper p="sm" radius="md" className={classes.removedFile} mt={6}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" c="dimmed" style={{ minWidth: 0, wordBreak: 'break-word' }}>
              <Text span td="line-through" inherit>
                {stored.name}
              </Text>{' '}
              will be removed when you save.
            </Text>
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconArrowBackUp size={14} />}
              onClick={() => onRemovedChange?.(false)}
            >
              Undo
            </Button>
          </Group>
        </Paper>
      </Input.Wrapper>
    );
  }

  if (stored && !file && !replacing) {
    return (
      <Input.Wrapper label={label} description={description} error={error} withAsterisk={required}>
        <Paper p="sm" radius="md" className={classes.storedFile} mt={6}>
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
              <ThemeIcon variant="light" size={38} radius="md">
                <IconFileSpreadsheet size={20} />
              </ThemeIcon>
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} truncate="end">
                  {stored.name}
                </Text>
                <Text size="xs" c="dimmed">
                  Saved · {formatFileSize(stored.size)}
                </Text>
              </Stack>
            </Group>
            <Group gap={6} wrap="nowrap">
              {onDownloadStored && (
                <Button size="xs" variant="subtle" leftSection={<IconDownload size={14} />} onClick={onDownloadStored}>
                  Download
                </Button>
              )}
              <Button
                size="xs"
                variant="default"
                leftSection={<IconReplace size={14} />}
                onClick={() => setReplacing(true)}
              >
                Replace
              </Button>
              {removable && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => onRemovedChange?.(true)}
                >
                  Remove
                </Button>
              )}
            </Group>
          </Group>
        </Paper>
      </Input.Wrapper>
    );
  }

  return (
    <Stack gap={6}>
      <FileDropzone
        label={label}
        required={required}
        description={description}
        file={file}
        onFile={(f) => onFile(f)}
        onClear={() => onFile(null)}
        error={errorText ?? null}
      />
      {error && !errorText && <Input.Error>{error}</Input.Error>}
      {stored && (
        <Group>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconArrowBackUp size={14} />}
            onClick={() => {
              onFile(null);
              setReplacing(false);
            }}
          >
            Keep the saved file ({stored.name})
          </Button>
        </Group>
      )}
    </Stack>
  );
}
