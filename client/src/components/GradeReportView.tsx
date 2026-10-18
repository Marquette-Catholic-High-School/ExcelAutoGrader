import { useMemo, useState } from 'react';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  List,
  Progress,
  RingProgress,
  SegmentedControl,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconInfoCircle } from '@tabler/icons-react';
import type { CellPrimitive, CellResult, GradeReport, SheetReport } from '@shared/types';
import { scoreColor } from '../utils/format';
import { FAIL_REASON_LABEL, formatDisplayValue, formatValue, formulaText } from './viewer/cellFormat';

export interface GradeReportViewProps {
  report: GradeReport;
  /** Show the Expected column (teachers: true; students: per studentVisibility.showExpectedToStudents). */
  showExpected?: boolean;
  /** Row click, e.g. to focus that cell in a SpreadsheetViewer. `sheet` is the KEY sheet name. */
  onCellClick?: (sheet: string, address: string) => void;
  /** Header of the submitted-value column. Default "Student's answer" (use "Your answer" on student pages). */
  answerLabel?: string;
}

type Filter = 'incorrect' | 'all';

/** Rows rendered per sheet before "Show more" (keeps 1000+ cell reports responsive). */
const PAGE_SIZE = 100;

function percentOf(correct: number, total: number): number {
  return total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Autograde report: summary (x of y cells correct + progress bar), warnings, then one section per sheet
 * with a table of cells (address, status, expected, student value, formula) and an "only incorrect" filter.
 */
export function GradeReportView({
  report,
  showExpected = true,
  onCellClick,
  answerLabel = "Student's answer",
}: GradeReportViewProps) {
  const incorrect = report.total - report.correct;
  const [filter, setFilter] = useState<Filter>(incorrect > 0 ? 'incorrect' : 'all');
  const pct = report.total > 0 ? Math.round(report.fraction * 1000) / 10 : 0;
  // Expected values may have been stripped by the server for students; hide the column when nothing is left.
  const expectedVisible = useMemo(
    () =>
      showExpected &&
      report.sheets.some((s) =>
        s.cells.some((c) => c.expected !== undefined || c.expectedText !== undefined || !!c.expectedFormula),
      ),
    [report, showExpected],
  );
  const defaultOpen = useMemo(() => {
    const withErrors = report.sheets.filter((s) => s.correct < s.total).map((s) => s.keySheet);
    return withErrors.length > 0 ? withErrors : report.sheets.slice(0, 1).map((s) => s.keySheet);
  }, [report]);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center" wrap="wrap" gap="md">
        <Group gap="md" wrap="nowrap">
          <RingProgress
            size={84}
            thickness={8}
            roundCaps
            sections={[{ value: pct, color: scoreColor(pct) }]}
            label={
              <Text ta="center" fw={700} size="sm">
                {pct}%
              </Text>
            }
            aria-label={`${pct}% of checked cells are correct`}
          />
          <div>
            <Text fw={700} size="lg">
              {report.correct.toLocaleString()} of {plural(report.total, 'cell')} correct
            </Text>
            <Text size="sm" c="dimmed">
              {report.total === 0
                ? 'The answer key had no cells to check.'
                : incorrect === 0
                  ? 'Every checked cell matches the answer key.'
                  : `${plural(incorrect, 'cell')} to fix`}
              {report.sheets.length > 0 && ` · ${plural(report.sheets.length, 'sheet')} checked`}
            </Text>
          </div>
        </Group>
        {report.total > 0 && (
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            data={[
              { value: 'incorrect', label: `Incorrect only (${incorrect.toLocaleString()})` },
              { value: 'all', label: `All cells (${report.total.toLocaleString()})` },
            ]}
            aria-label="Which cells to list"
          />
        )}
      </Group>

      {report.warnings.length > 0 && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle />} title="Notes from the autograder">
          <List size="sm" spacing={4}>
            {report.warnings.map((w, i) => (
              <List.Item key={i}>{w}</List.Item>
            ))}
          </List>
        </Alert>
      )}

      {report.sheets.length > 0 && (
        <Accordion multiple variant="separated" defaultValue={defaultOpen} keepMounted={false} order={4}>
          {report.sheets.map((sheet) => (
            <Accordion.Item key={sheet.keySheet} value={sheet.keySheet}>
              <Accordion.Control>
                <SheetHeader sheet={sheet} />
              </Accordion.Control>
              <Accordion.Panel>
                <SheetCells
                  key={filter}
                  sheet={sheet}
                  filter={filter}
                  showExpected={expectedVisible}
                  answerLabel={answerLabel}
                  onCellClick={onCellClick}
                />
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}
    </Stack>
  );
}

function SheetHeader({ sheet }: { sheet: SheetReport }) {
  const pct = percentOf(sheet.correct, sheet.total);
  const allCorrect = sheet.correct === sheet.total;
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm" pr="xs">
      <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
        <Text fw={600} truncate="end">
          {sheet.keySheet}
        </Text>
        {sheet.studentSheet === null ? (
          <Badge color="red" variant="light" size="sm">
            Sheet missing
          </Badge>
        ) : (
          sheet.studentSheet !== sheet.keySheet && (
            <Text size="xs" c="dimmed">
              matched to “{sheet.studentSheet}”
            </Text>
          )
        )}
      </Group>
      <Group gap="sm" wrap="nowrap">
        <Progress w={90} size="sm" value={pct} color={scoreColor(pct)} visibleFrom="xs" aria-hidden />
        <Badge variant="light" color={allCorrect ? 'teal' : 'red'} style={{ flexShrink: 0 }}>
          {sheet.correct.toLocaleString()} / {sheet.total.toLocaleString()}
        </Badge>
      </Group>
    </Group>
  );
}

function SheetCells({
  sheet,
  filter,
  showExpected,
  answerLabel,
  onCellClick,
}: {
  sheet: SheetReport;
  filter: Filter;
  showExpected: boolean;
  answerLabel: string;
  onCellClick?: (sheet: string, address: string) => void;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const rows = useMemo(() => (filter === 'incorrect' ? sheet.cells.filter((c) => !c.correct) : sheet.cells), [
    sheet,
    filter,
  ]);

  const missingNote = sheet.studentSheet === null && (
    <Alert color="red" variant="light" icon={<IconInfoCircle />} mb="sm" p="xs">
      The submitted workbook has no sheet named “{sheet.keySheet}”, so every cell on it was marked incorrect. Check the
      sheet's name (tabs at the bottom in Excel).
    </Alert>
  );

  if (rows.length === 0) {
    return (
      <>
        {missingNote}
        <Group gap={6} py={4}>
          <IconCircleCheck size={18} color="var(--mantine-color-teal-6)" />
          <Text size="sm" c="dimmed">
            {sheet.total === 0 ? 'No cells were checked on this sheet.' : 'Every checked cell on this sheet is correct.'}
          </Text>
        </Group>
      </>
    );
  }

  const visible = rows.length > limit ? rows.slice(0, limit) : rows;
  const remaining = rows.length - visible.length;

  return (
    <>
      {missingNote}
      <Table.ScrollContainer minWidth={showExpected ? 620 : 460} type="native">
        <Table verticalSpacing={6} fz="sm" highlightOnHover={!!onCellClick}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={96}>Cell</Table.Th>
              <Table.Th w={170}>Result</Table.Th>
              {showExpected && <Table.Th>Expected</Table.Th>}
              <Table.Th>{answerLabel}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visible.map((cell) => (
              <CellRow
                key={cell.address}
                cell={cell}
                sheet={sheet.keySheet}
                tint={filter === 'all' && !cell.correct}
                showExpected={showExpected}
                onCellClick={onCellClick}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {remaining > 0 && (
        <Group justify="center" gap="sm" mt="sm">
          <Text size="xs" c="dimmed">
            Showing {visible.length.toLocaleString()} of {rows.length.toLocaleString()}
          </Text>
          <Button variant="light" size="compact-sm" onClick={() => setLimit((n) => n + PAGE_SIZE * 2)}>
            Show {Math.min(remaining, PAGE_SIZE * 2).toLocaleString()} more
          </Button>
          {remaining > PAGE_SIZE * 2 && (
            <Button variant="subtle" size="compact-sm" onClick={() => setLimit(rows.length)}>
              Show all
            </Button>
          )}
        </Group>
      )}
    </>
  );
}

function CellRow({
  cell,
  sheet,
  tint,
  showExpected,
  onCellClick,
}: {
  cell: CellResult;
  sheet: string;
  tint: boolean;
  showExpected: boolean;
  onCellClick?: (sheet: string, address: string) => void;
}) {
  const label = cell.correct ? 'Correct' : cell.reason ? FAIL_REASON_LABEL[cell.reason] : 'Incorrect';
  return (
    <Table.Tr
      onClick={onCellClick ? () => onCellClick(sheet, cell.address) : undefined}
      style={onCellClick ? { cursor: 'pointer' } : undefined}
      bg={tint ? 'var(--mantine-color-red-light)' : undefined}
    >
      <Table.Td>
        {onCellClick ? (
          <UnstyledButton aria-label={`Show ${cell.address} in the workbook`}>
            <Code fz="sm" fw={600}>
              {cell.address}
            </Code>
          </UnstyledButton>
        ) : (
          <Code fz="sm" fw={600}>
            {cell.address}
          </Code>
        )}
      </Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          {cell.correct ? (
            <IconCircleCheck size={18} color="var(--mantine-color-teal-6)" style={{ flexShrink: 0 }} aria-hidden />
          ) : (
            <IconCircleX size={18} color="var(--mantine-color-red-6)" style={{ flexShrink: 0 }} aria-hidden />
          )}
          <Text size="sm" fw={500} c={cell.correct ? 'teal' : 'red'}>
            {label}
          </Text>
        </Group>
      </Table.Td>
      {showExpected && (
        <Table.Td>
          <CellValue value={cell.expected} text={cell.expectedText} formula={cell.expectedFormula} />
        </Table.Td>
      )}
      <Table.Td>
        <CellValue value={cell.actual} text={cell.actualText} formula={cell.actualFormula} />
      </Table.Td>
    </Table.Tr>
  );
}

/**
 * A value as the workbook displays it ("31.8%", "10/16/2026") when the report has the formatted text; the raw
 * value ("0.3183") is then in the hover title. Older reports without the text show the raw value.
 */
function CellValue({ value, text, formula }: { value: CellPrimitive | undefined; text?: string; formula?: string }) {
  const hasValue = value !== undefined || text !== undefined;
  if (!hasValue && !formula) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  const raw = formatValue(value);
  const shown = formatDisplayValue(value, text);
  const empty = value === null && text === undefined;
  return (
    <div style={{ minWidth: 0 }}>
      {hasValue && (
        <Text
          size="sm"
          c={empty ? 'dimmed' : undefined}
          fs={empty ? 'italic' : undefined}
          title={value !== undefined && shown !== raw ? `Stored value: ${raw}` : undefined}
          style={{ wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}
        >
          {shown}
        </Text>
      )}
      {formula && (
        <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
          {formulaText(formula)}
        </Text>
      )}
    </div>
  );
}
