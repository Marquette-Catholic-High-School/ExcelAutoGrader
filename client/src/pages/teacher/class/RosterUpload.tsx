import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, List, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconDownload, IconMailForward, IconUserCheck, IconUserPlus } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import type { RosterPreview, RosterPreviewRow } from '@shared/types';
import { saveBlob } from '../../../api/client';
import { endpoints } from '../../../api/endpoints';
import { FileDropzone } from '../../../components/FileDropzone';
import { BADGE_NO_SHRINK } from '../../../components/StatusBadges';
import { errorMessage, fieldErrors } from '../../../utils/errors';
import { nameFromEmail } from './parseStudentList';

type RowStatus = RosterPreviewRow['status'];

const TEMPLATE_CSV = 'First Name,Last Name,Email\r\n';

export function downloadRosterTemplate() {
  saveBlob(new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' }), 'class-roster-template.csv');
}

/** Rows that "Add students" will change (the rest are already in the class or can't be added). */
function isAddable(row: RosterPreviewRow) {
  return row.status === 'invite' || row.status === 'add';
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The uploaded roster file and the server's preview of it. Lives in the modal so switching tabs keeps it. */
export function useRosterImport(classId: number) {
  const [file, setFile] = useState<File | null>(null);
  const preview = useMutation({ mutationFn: (f: File) => endpoints.importRosterPreview(classId, f) });
  const error = preview.error ? (fieldErrors(preview.error).file ?? errorMessage(preview.error)) : null;
  return {
    file,
    preview: preview.data ?? null,
    loading: preview.isPending,
    error,
    choose(f: File) {
      setFile(f);
      preview.mutate(f);
    },
    /** Also drops a preview still in flight (reset detaches it from this component). */
    clear() {
      setFile(null);
      preview.reset();
    },
  };
}

export type RosterImport = ReturnType<typeof useRosterImport>;

const STATUS_BADGE: Record<Exclude<RowStatus, 'error'>, { label: string; color: string; icon?: typeof IconUserPlus }> =
  {
    invite: { label: 'Will be invited', color: 'grape', icon: IconMailForward },
    add: { label: 'Has an account — added now', color: 'teal', icon: IconUserCheck },
    already: { label: 'Already in class', color: 'gray' },
  };

function RowStatusCell({ row }: { row: RosterPreviewRow }) {
  if (row.status === 'error') {
    return (
      <Text size="sm" c="red" fw={500}>
        {row.error || "Can't be added"}
      </Text>
    );
  }
  const s = STATUS_BADGE[row.status];
  const Icon = s.icon;
  return (
    <Badge
      color={s.color}
      variant="light"
      size="sm"
      tt="none"
      leftSection={Icon ? <Icon size={12} /> : undefined}
      {...BADGE_NO_SHRINK}
    >
      {s.label}
    </Badge>
  );
}

function PreviewSummary({ preview }: { preview: RosterPreview }) {
  const count = (status: RowStatus) => preview.rows.filter((r) => r.status === status).length;
  const badges = [
    { n: count('invite'), text: (n: number) => `${n} will be invited`, color: 'grape' },
    { n: count('add'), text: (n: number) => `${plural(n, 'has', 'have')} an account`, color: 'teal' },
    { n: count('already'), text: (n: number) => `${n} already in class`, color: 'gray' },
    { n: count('error'), text: (n: number) => `${n} can't be added`, color: 'red' },
  ].filter((b) => b.n > 0);
  const { columns } = preview;
  return (
    <Stack gap={6}>
      <Group gap="xs" aria-live="polite">
        {badges.length === 0 ? (
          <Badge color="gray" variant="light" size="lg" tt="none">
            No students found
          </Badge>
        ) : (
          badges.map((b) => (
            <Badge key={b.color} color={b.color} variant="light" size="lg" tt="none">
              {b.text(b.n)}
            </Badge>
          ))
        )}
      </Group>
      <Text size="xs" c="dimmed">
        Emails from the “{columns.email}” column
        {columns.name
          ? `, names from “${columns.name}”.`
          : '. No name column was found, so each student keeps the name they sign up with.'}
      </Text>
    </Stack>
  );
}

function PreviewTable({ rows }: { rows: RosterPreviewRow[] }) {
  return (
    <Table.ScrollContainer minWidth={560} maxHeight={300}>
      <Table striped verticalSpacing={6} fz="sm" withTableBorder stickyHeader>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={56}>Row</Table.Th>
            <Table.Th>Name</Table.Th>
            <Table.Th>Email</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row, i) => (
            <Table.Tr key={`${row.line}-${i}`}>
              <Table.Td c="dimmed">{row.line}</Table.Td>
              <Table.Td>
                {row.name || (
                  <Text span size="sm" c="dimmed">
                    {row.email.includes('@') ? `${nameFromEmail(row.email)} (from email)` : '—'}
                  </Text>
                )}
              </Table.Td>
              <Table.Td style={{ wordBreak: 'break-all' }}>{row.email || '—'}</Table.Td>
              <Table.Td>
                <RowStatusCell row={row} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** "Upload a file" tab of Add students: drop a CSV/Excel roster, review the server's preview, then add. */
export function RosterUploadPanel({
  roster,
  adding,
  onAdd,
  onCancel,
}: {
  roster: RosterImport;
  adding: boolean;
  onAdd: (students: { name: string; email: string }[]) => void;
  onCancel: () => void;
}) {
  const { preview } = roster;
  const addable = preview ? preview.rows.filter(isAddable) : [];

  return (
    <Stack gap="md">
      <FileDropzone
        label="Class roster"
        description="A CSV or Excel file with an email column. Names are optional (first and last name columns work)."
        file={roster.file}
        onFile={roster.choose}
        onClear={roster.clear}
        loading={roster.loading}
        disabled={adding}
        error={roster.error}
      />
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text size="xs" c="dimmed">
          Students are matched automatically when they create an account with that email.
        </Text>
        <Anchor component="button" type="button" size="xs" onClick={downloadRosterTemplate}>
          <Group gap={4} component="span" wrap="nowrap">
            <IconDownload size={14} />
            Download a CSV template
          </Group>
        </Anchor>
      </Group>

      {preview && (
        <>
          <PreviewSummary preview={preview} />
          {preview.warnings.length > 0 && (
            <Alert color="yellow" variant="light" icon={<IconAlertTriangle />} title="Good to know" p="sm">
              <List size="sm" spacing={2}>
                {preview.warnings.map((w, i) => (
                  <List.Item key={i}>{w}</List.Item>
                ))}
              </List>
            </Alert>
          )}
          {preview.rows.length > 0 && <PreviewTable rows={preview.rows} />}
        </>
      )}

      <Group justify="flex-end" gap="sm">
        <Button variant="default" onClick={onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button
          onClick={() => onAdd(addable.map(({ name, email }) => ({ name, email })))}
          loading={adding}
          disabled={!preview || addable.length === 0 || roster.loading}
          leftSection={<IconUserPlus size={18} />}
        >
          {preview && addable.length > 0 ? `Add ${plural(addable.length, 'student', 'students')}` : 'Add students'}
        </Button>
      </Group>
    </Stack>
  );
}
