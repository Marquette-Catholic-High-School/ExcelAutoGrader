import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  List,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { isEmail, useForm } from '@mantine/form';
import { IconAlertTriangle, IconClipboardText, IconUserPlus } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AddStudentsRequest, AddStudentsResponse } from '@shared/types';
import { endpoints } from '../../../api/endpoints';
import { fieldErrors, notifyError } from '../../../utils/errors';
import { MAX_STUDENTS_PER_REQUEST, nameFromEmail, parseStudentList, type ParseResult } from './parseStudentList';
import { invalidateRoster } from './queries';

type AddTab = 'one' | 'list';

const PASTE_PLACEHOLDER = [
  'Jane Doe, jane.doe@school.edu',
  'sam.lee@school.edu',
  'Alex Kim\talex.kim@school.edu',
].join('\n');

const PREVIEW_ROWS = 50;

function PastePreview({ parsed }: { parsed: ParseResult }) {
  const { students, issues } = parsed;
  return (
    <Stack gap="sm">
      <Group gap="xs" aria-live="polite">
        <Badge color={students.length > 0 ? 'teal' : 'gray'} variant="light" size="lg" tt="none">
          {students.length} {students.length === 1 ? 'student' : 'students'} ready
        </Badge>
        {issues.length > 0 && (
          <Badge color="red" variant="light" size="lg" tt="none">
            {issues.length} {issues.length === 1 ? 'line needs' : 'lines need'} attention
          </Badge>
        )}
      </Group>

      {students.length > MAX_STUDENTS_PER_REQUEST && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle />}>
          You can add up to {MAX_STUDENTS_PER_REQUEST} students at a time. Split the list and add it in parts.
        </Alert>
      )}

      {issues.length > 0 && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle />} title="These lines will be skipped">
          <ScrollArea.Autosize mah={140} type="auto">
            <List size="sm" spacing={4}>
              {issues.map((issue, i) => (
                <List.Item key={`${issue.line}-${i}`}>
                  <Text span fw={600} size="sm">
                    Line {issue.line}:
                  </Text>{' '}
                  {issue.error}
                </List.Item>
              ))}
            </List>
          </ScrollArea.Autosize>
        </Alert>
      )}

      {students.length > 0 && (
        <ScrollArea.Autosize mah={220} type="auto">
          <Table striped verticalSpacing={6} fz="sm" withTableBorder stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={60}>Line</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>Email</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {students.slice(0, PREVIEW_ROWS).map((s) => (
                <Table.Tr key={s.email}>
                  <Table.Td c="dimmed">{s.line}</Table.Td>
                  <Table.Td>
                    {s.name}
                    {s.derivedName && (
                      <Text span size="xs" c="dimmed" ml={6}>
                        (from email)
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td style={{ wordBreak: 'break-all' }}>{s.email}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {students.length > PREVIEW_ROWS && (
            <Text size="xs" c="dimmed" mt={6}>
              Showing the first {PREVIEW_ROWS} of {students.length}.
            </Text>
          )}
        </ScrollArea.Autosize>
      )}
    </Stack>
  );
}

/** Dialog for enrolling students by email: one at a time, or a list pasted from a spreadsheet. */
export function AddStudentsModal({
  classId,
  opened,
  onClose,
  onAdded,
}: {
  classId: number;
  opened: boolean;
  onClose: () => void;
  onAdded: (result: AddStudentsResponse) => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<AddTab>('one');
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseStudentList(text), [text]);

  const oneForm = useForm({
    mode: 'uncontrolled',
    initialValues: { name: '', email: '' },
    validate: {
      name: (value: string) => (value.trim().length > 100 ? 'Use 100 characters or fewer' : null),
      email: isEmail('Enter a valid email address'),
    },
  });

  function handleClose() {
    oneForm.reset();
    setText('');
    setTab('one');
    add.reset();
    onClose();
  }

  const add = useMutation({
    mutationFn: (body: AddStudentsRequest) => endpoints.addStudents(classId, body),
    onSuccess: (result) => {
      invalidateRoster(qc, classId);
      handleClose();
      onAdded(result);
    },
    onError: (err) => {
      const fields = fieldErrors(err);
      if (tab === 'one' && Object.keys(fields).length > 0) oneForm.setErrors(fields);
      else notifyError(err, 'Could not add students');
    },
  });

  /** User-initiated close (X, Escape, Cancel); ignored while the request is in flight. */
  function requestClose() {
    if (!add.isPending) handleClose();
  }

  const submitOne = oneForm.onSubmit((values) => {
    const email = values.email.trim().toLowerCase();
    add.mutate({ students: [{ email, name: values.name.trim() || nameFromEmail(email) }] });
  });

  const listCount = parsed.students.length;
  const tooMany = listCount > MAX_STUDENTS_PER_REQUEST;

  function submitList() {
    if (listCount === 0 || tooMany) return;
    add.mutate({ students: parsed.students.map(({ name, email }) => ({ name, email })) });
  }

  return (
    <Modal opened={opened} onClose={requestClose} title="Add students" size="lg">
      <Text size="sm" c="dimmed" mb="md">
        Students without an account get one with a temporary password, shown to you once after adding. Students who
        already have an account are simply enrolled.
      </Text>
      <Tabs value={tab} onChange={(value) => setTab((value as AddTab | null) ?? 'one')} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="one" leftSection={<IconUserPlus size={16} />}>
            Add one
          </Tabs.Tab>
          <Tabs.Tab value="list" leftSection={<IconClipboardText size={16} />}>
            Paste a list
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="one">
          <form onSubmit={submitOne} noValidate>
            <Stack gap="md">
              <TextInput
                label="Email"
                placeholder="jane.doe@school.edu"
                type="email"
                required
                data-autofocus
                key={oneForm.key('email')}
                {...oneForm.getInputProps('email')}
              />
              <TextInput
                label="Name"
                description="Leave blank to use the name from the email address"
                placeholder="Jane Doe"
                key={oneForm.key('name')}
                {...oneForm.getInputProps('name')}
              />
              <Group justify="flex-end" gap="sm">
                <Button variant="default" onClick={requestClose} disabled={add.isPending}>
                  Cancel
                </Button>
                <Button type="submit" loading={add.isPending} leftSection={<IconUserPlus size={18} />}>
                  Add student
                </Button>
              </Group>
            </Stack>
          </form>
        </Tabs.Panel>

        <Tabs.Panel value="list">
          <Stack gap="md">
            <Textarea
              label="Names and emails"
              description="One student per line. Copy name and email columns straight from Excel, or type “Jane Doe, jane@school.edu”. A line with only an email works too."
              placeholder={PASTE_PLACEHOLDER}
              autosize
              minRows={6}
              maxRows={12}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
              data-autofocus
            />
            {text.trim() && <PastePreview parsed={parsed} />}
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={requestClose} disabled={add.isPending}>
                Cancel
              </Button>
              <Button
                onClick={submitList}
                loading={add.isPending}
                disabled={listCount === 0 || tooMany}
                leftSection={<IconUserPlus size={18} />}
              >
                {listCount === 0
                  ? 'Add students'
                  : `Add ${listCount} ${listCount === 1 ? 'student' : 'students'}`}
                {parsed.issues.length > 0 && listCount > 0 ? ` (skip ${parsed.issues.length})` : ''}
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}
