import { useState } from 'react';
import { Box, Button, Card, Collapse, Group, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconDownload, IconKey } from '@tabler/icons-react';
import type { AssignmentDetail } from '@shared/types';
import { endpoints } from '../../../api/endpoints';
import { KeyWorkbookViewer } from '../../../components/SpreadsheetViewer';
import { notifyError } from '../../../utils/errors';
import { formatFileSize } from '../../../utils/format';

/** Collapsible answer key viewer. The workbook is only fetched the first time it is opened. */
export function AnswerKeySection({ assignment }: { assignment: AssignmentDetail }) {
  const [opened, setOpened] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const key = assignment.key;
  if (!key) return null;

  const toggle = () => {
    setOpened((o) => !o);
    setEverOpened(true);
  };

  return (
    <Card padding={0}>
      <Group justify="space-between" wrap="nowrap" pr="md">
        <UnstyledButton
          onClick={toggle}
          aria-expanded={opened}
          aria-controls="answer-key-viewer"
          p="md"
          style={{ flex: 1, minWidth: 0 }}
        >
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" size={36} radius="md">
              <IconKey size={18} />
            </ThemeIcon>
            <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
              <Text fw={600} size="sm">
                Answer key
              </Text>
              <Text size="xs" c="dimmed" truncate="end">
                {key.name} · {formatFileSize(key.size)} · {opened ? 'Click to hide' : 'Click to view'}
              </Text>
            </Stack>
            <IconChevronDown
              size={18}
              style={{
                transform: opened ? 'rotate(180deg)' : undefined,
                transition: 'transform 150ms ease',
                flexShrink: 0,
              }}
            />
          </Group>
        </UnstyledButton>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconDownload size={14} />}
          onClick={() => endpoints.downloadKey(assignment.id).catch((e) => notifyError(e))}
        >
          Download
        </Button>
      </Group>
      <Collapse expanded={opened} id="answer-key-viewer">
        <Box px="md" pb="md">
          {everOpened && <KeyWorkbookViewer assignmentId={assignment.id} height={460} />}
        </Box>
      </Collapse>
    </Card>
  );
}
