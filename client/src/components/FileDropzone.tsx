import { useEffect, useId, useState } from 'react';
import { ActionIcon, Group, Input, LoadingOverlay, Paper, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { Dropzone, type FileRejection } from '@mantine/dropzone';
import { IconFileSpreadsheet, IconUpload, IconX } from '@tabler/icons-react';
import { formatFileSize } from '../utils/format';

/** Accepted spreadsheet extensions (mirrors server/src/uploads.ts). */
export const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.csv', '.ods'];
export const MAX_UPLOAD_MB = 25;

const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** MIME types plus extensions: some browsers report spreadsheets with an empty or generic MIME type. */
const ACCEPT = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'],
  'application/vnd.ms-excel': ['.xls'],
  'text/csv': ['.csv'],
  'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
};

const TYPES_HINT = 'Excel (.xlsx, .xlsm, .xls), CSV or OpenDocument (.ods)';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** Same extension rule as the server, so a file with a spreadsheet MIME type but an odd extension is caught early. */
function validateSpreadsheet(file: File) {
  if (!file || typeof file.name !== 'string') return null;
  if (!SPREADSHEET_EXTENSIONS.includes(extensionOf(file.name))) {
    return { code: 'file-invalid-type', message: 'Not a spreadsheet' };
  }
  if (file.size === 0) return { code: 'file-too-small', message: 'The file is empty' };
  return null;
}

function rejectionMessage(rejections: FileRejection[]): string {
  if (rejections.length !== 1 || rejections[0].errors.some((e) => e.code === 'too-many-files')) {
    return 'Please choose just one file.';
  }
  const { file, errors } = rejections[0];
  switch (errors[0]?.code) {
    case 'file-invalid-type':
      return `“${file.name}” isn't a spreadsheet. Choose an ${TYPES_HINT} file.`;
    case 'file-too-large':
      return `“${file.name}” is ${formatFileSize(file.size)} — files can be up to ${MAX_UPLOAD_MB} MB.`;
    case 'file-too-small':
      return `“${file.name}” is empty. Save your workbook in Excel and try again.`;
    default:
      return errors[0]?.message || `“${file.name}” can't be uploaded.`;
  }
}

export interface FileDropzoneProps {
  /** Called with the single accepted file. Rejected files show an inline error instead. */
  onFile: (file: File) => void;
  /** Currently selected file: shows its name/size with a remove button instead of the drop area. */
  file?: File | null;
  onClear?: () => void;
  label?: string;
  description?: string;
  /** Spinner overlay while uploading. */
  loading?: boolean;
  disabled?: boolean;
  /** External error (e.g. from the server) shown under the dropzone. */
  error?: string | null;
  /** Smaller variant for use inside tables/modals. */
  compact?: boolean;
  /** Shows a required asterisk next to the label. */
  required?: boolean;
}

/** Drag-and-drop (or click to browse) for one spreadsheet file, built on @mantine/dropzone. */
export function FileDropzone({
  onFile,
  file,
  onClear,
  label,
  description,
  loading = false,
  disabled = false,
  error,
  compact = false,
  required,
}: FileDropzoneProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [rejection, setRejection] = useState<string | null>(null);
  const message = error || rejection;

  useEffect(() => {
    if (file) setRejection(null);
  }, [file]);

  const iconSize = compact ? 30 : 46;
  const hasHeader = !!(label || description);

  const content = file ? (
    <Paper
      withBorder
      p={compact ? 'xs' : 'sm'}
      pos="relative"
      style={message ? { borderColor: 'var(--mantine-color-error)' } : undefined}
    >
      <LoadingOverlay visible={loading} loaderProps={{ size: 'sm' }} overlayProps={{ radius: 'md', blur: 1 }} />
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon size={compact ? 32 : 40} variant="light" radius="md">
          <IconFileSpreadsheet size={compact ? 18 : 22} />
        </ThemeIcon>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={500} truncate="end" title={file.name}>
            {file.name}
          </Text>
          <Text size="xs" c="dimmed">
            {formatFileSize(file.size)}
          </Text>
        </div>
        {onClear && (
          <Tooltip label="Remove file">
            <ActionIcon
              variant="subtle"
              color="gray"
              size={compact ? 'md' : 'lg'}
              onClick={() => {
                setRejection(null);
                onClear();
              }}
              disabled={loading || disabled}
              aria-label={`Remove ${file.name}`}
            >
              <IconX size={18} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Paper>
  ) : (
    <Dropzone
      onDrop={(files) => {
        setRejection(null);
        if (files[0]) onFile(files[0]);
      }}
      onReject={(rejections) => setRejection(rejectionMessage(rejections))}
      accept={ACCEPT}
      validator={validateSpreadsheet}
      maxSize={MAX_UPLOAD_BYTES}
      maxFiles={1}
      multiple={false}
      loading={loading}
      disabled={disabled}
      p={compact ? 'sm' : 'xl'}
      aria-label={label ? undefined : 'Upload a spreadsheet'}
      aria-disabled={disabled || undefined}
      inputProps={{
        id: inputId,
        'aria-invalid': message ? true : undefined,
        'aria-describedby': message ? errorId : undefined,
      }}
      style={{
        ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : null),
        ...(message ? { borderColor: 'var(--mantine-color-error)' } : null),
      }}
    >
      <Group
        justify="center"
        gap={compact ? 'sm' : 'lg'}
        wrap="nowrap"
        mih={compact ? 44 : 110}
        style={{ pointerEvents: 'none' }}
      >
        <Dropzone.Accept>
          <IconUpload size={iconSize} stroke={1.5} color="var(--mantine-color-brand-filled)" style={{ flexShrink: 0 }} />
        </Dropzone.Accept>
        <Dropzone.Reject>
          <IconX size={iconSize} stroke={1.5} color="var(--mantine-color-red-6)" style={{ flexShrink: 0 }} />
        </Dropzone.Reject>
        <Dropzone.Idle>
          <IconFileSpreadsheet
            size={iconSize}
            stroke={1.5}
            color="var(--mantine-color-dimmed)"
            style={{ flexShrink: 0 }}
          />
        </Dropzone.Idle>
        <div style={{ minWidth: 0 }}>
          <Text size={compact ? 'sm' : 'lg'} fw={500}>
            <Dropzone.Idle>
              <span>
                {compact ? 'Drop a spreadsheet or click to browse' : 'Drag a spreadsheet here or click to browse'}
              </span>
            </Dropzone.Idle>
            <Dropzone.Accept>
              <span>Drop to add this file</span>
            </Dropzone.Accept>
            <Dropzone.Reject>
              <span>Only one spreadsheet file can be added</span>
            </Dropzone.Reject>
          </Text>
          <Text size={compact ? 'xs' : 'sm'} c="dimmed" mt={compact ? 2 : 6}>
            {TYPES_HINT} · up to {MAX_UPLOAD_MB} MB
          </Text>
        </div>
      </Group>
    </Dropzone>
  );

  return (
    <Input.Wrapper
      id={inputId}
      label={label}
      description={description}
      error={message}
      errorProps={{ id: errorId }}
      withAsterisk={required}
      labelElement={file ? 'div' : 'label'}
    >
      <div style={{ marginTop: hasHeader ? 6 : 0 }}>{content}</div>
    </Input.Wrapper>
  );
}
