import type { ReactNode, Ref } from 'react';
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Menu,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconDots, IconDownload, IconFileSpreadsheet, IconKey, IconUpload } from '@tabler/icons-react';
import type { AssignmentDetail, SubmissionDetail } from '@shared/types';
import { endpoints } from '../../../api/endpoints';
import { KeyWorkbookViewer, SubmissionWorkbookViewer, type CellFocus } from '../../../components/SpreadsheetViewer';
import { notifyError } from '../../../utils/errors';
import { formatFileSize } from '../../../utils/format';

export type WorkbookView = 'student' | 'key' | 'side';

const VIEWER_HEIGHT = 560;
const SIDE_HEIGHT = 460;

function PaneLabel({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <Group gap={6}>
      <ThemeIcon size="sm" variant="light" radius="sm">
        {icon}
      </ThemeIcon>
      <Text size="sm" fw={600}>
        {label}
      </Text>
    </Group>
  );
}

/** Student workbook / answer key / side-by-side viewer for the grading workspace. */
export function WorkbookPanel({
  assignment,
  submission,
  view,
  onViewChange,
  focus,
  onUploadNew,
  ref,
}: {
  assignment: AssignmentDetail;
  submission: SubmissionDetail;
  view: WorkbookView;
  onViewChange: (view: WorkbookView) => void;
  /** A cell to jump to, by KEY sheet name (SubmissionWorkbookViewer maps it to the student's matching sheet). */
  focus: CellFocus | null;
  onUploadNew: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const compact = useMediaQuery('(max-width: 36em)');
  const hasKey = !!assignment.key;
  const effectiveView: WorkbookView = hasKey ? view : 'student';
  const report = submission.report;

  const student = (height: number) => (
    <SubmissionWorkbookViewer
      submissionId={submission.id}
      report={report}
      height={height}
      focus={focus}
    />
  );
  const key = (height: number) => (
    <KeyWorkbookViewer assignmentId={assignment.id} report={report} height={height} focus={focus} />
  );

  return (
    <Card padding="md" ref={ref} style={{ scrollMarginTop: 76 }}>
      <Group justify="space-between" mb="md" gap="sm" wrap="wrap">
        {hasKey ? (
          <SegmentedControl
            value={effectiveView}
            onChange={(v) => onViewChange(v as WorkbookView)}
            aria-label="Choose which workbook to show"
            fullWidth={compact}
            w={compact ? '100%' : undefined}
            data={[
              { value: 'student', label: compact ? 'Student' : "Student's workbook" },
              { value: 'key', label: 'Answer key' },
              { value: 'side', label: compact ? 'Both' : 'Side by side' },
            ]}
          />
        ) : (
          <PaneLabel icon={<IconFileSpreadsheet size={14} />} label="Student's workbook" />
        )}
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" truncate="end" maw={220} title={submission.file.name} visibleFrom="sm">
            {submission.file.name} · {formatFileSize(submission.file.size)}
          </Text>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconDownload size={14} />}
            onClick={() => endpoints.downloadSubmission(submission.id).catch((e) => notifyError(e))}
          >
            Download original
          </Button>
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="default" size={30} aria-label="More file actions">
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconUpload size={16} />} onClick={onUploadNew}>
                Upload a new attempt on their behalf…
              </Menu.Item>
              {hasKey && (
                <Menu.Item
                  leftSection={<IconKey size={16} />}
                  onClick={() => endpoints.downloadKey(assignment.id).catch((e) => notifyError(e))}
                >
                  Download answer key
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      {effectiveView === 'student' && student(VIEWER_HEIGHT)}
      {effectiveView === 'key' && key(VIEWER_HEIGHT)}
      {effectiveView === 'side' && (
        <SimpleGrid type="container" cols={{ base: 1, '640px': 2 }} spacing="md">
          <Stack gap={6} style={{ minWidth: 0 }}>
            <PaneLabel icon={<IconFileSpreadsheet size={14} />} label="Student's workbook" />
            {student(SIDE_HEIGHT)}
          </Stack>
          <Stack gap={6} style={{ minWidth: 0 }}>
            <PaneLabel icon={<IconKey size={14} />} label="Answer key" />
            {key(SIDE_HEIGHT)}
          </Stack>
        </SimpleGrid>
      )}
    </Card>
  );
}
