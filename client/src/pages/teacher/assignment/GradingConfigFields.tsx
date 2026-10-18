import { useState, type FocusEvent, type ReactNode } from 'react';
import { Divider, Input, NumberInput, SegmentedControl, Stack, Switch, TagsInput, Text } from '@mantine/core';
import type { GradingConfig, GradingScope } from '@shared/types';

const SCOPE_OPTIONS: { value: GradingScope; label: string }[] = [
  { value: 'all', label: 'Every filled cell' },
  { value: 'formulas', label: 'Only formula cells' },
  { value: 'ranges', label: 'Specific ranges' },
];

const SCOPE_HELP: Record<GradingScope, string> = {
  all: 'Every cell that has a value or formula in your answer key is checked.',
  formulas: 'Only cells that contain a formula in your answer key are checked. Labels and inputs are ignored.',
  ranges: 'Only cells inside the ranges you list are checked (empty cells in the key are skipped).',
};

const RANGES_HELP =
  'Press Enter after each range. Use Sheet1!B2:D10, or B2:D10 for the first sheet. Single cells like Totals!F5 work too.';
const TOLERANCE_HELP =
  'Numbers within this difference count as correct (0.01 ignores rounding in cents). For percentage cells it is ' +
  'in percentage points (0.01 = ±0.01%), and time cells must match to the second.';
/** Same limit as the server (grader/config.ts MAX_TOLERANCE). */
export const MAX_TOLERANCE = 1_000_000_000;
/** Above this, almost any number "matches"; worth a heads-up. */
const LOOSE_TOLERANCE = 1;

/** One-line summary for the collapsed "Grading options" header. */
export function gradingConfigSummary(config: GradingConfig): string {
  const parts = [SCOPE_OPTIONS.find((o) => o.value === config.scope)?.label ?? ''];
  if (config.scope === 'ranges' && config.ranges.length > 0) {
    parts[0] += ` (${config.ranges.length})`;
  }
  parts.push(`±${config.numericTolerance}`);
  if (config.requireFormulas) parts.push('formulas required');
  if (!config.caseSensitive) parts.push('ignores case');
  if (config.showExpectedToStudents) parts.push('answers shown to students');
  else if (!config.showDetailsToStudents) parts.push('details hidden from students');
  return parts.join(' · ');
}

function OptionSwitch({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      label={label}
      description={description}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.checked)}
    />
  );
}

export interface GradingConfigFieldsProps {
  config: GradingConfig;
  onChange: (patch: Partial<GradingConfig>) => void;
  /** Whether a starter template is (or will be) attached. */
  hasTemplate: boolean;
  rangesError?: ReactNode;
  toleranceError?: ReactNode;
}

/**
 * The tolerance box keeps its own text while the teacher types: Mantine reports unfinished numbers such as "0.",
 * "0.0" or "" as strings, and feeding a coerced number back would reformat the field mid-edit (0.01 → Backspace →
 * "0.0" would become 0, then typing 5 would give 5). Only complete numbers reach the config.
 */
function ToleranceInput({
  value,
  onChange,
  error,
}: {
  value: number;
  onChange: (value: number) => void;
  error?: ReactNode;
}) {
  const [input, setInput] = useState<number | string>(value);
  const [synced, setSynced] = useState(value);
  const [blurError, setBlurError] = useState<string | null>(null);

  // A new value from outside (form reset, a different assignment): show it.
  if (value !== synced) {
    setSynced(value);
    if (input !== value) setInput(value);
  }

  // Leaving the field ends the edit: commit what was typed ("5." means 5), but never turn an empty or invalid
  // entry into 0. Those go back to the last valid tolerance, with a note saying so.
  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    const text = event.currentTarget.value.trim();
    const typed = text === '' ? NaN : Number(text);
    if (Number.isFinite(typed) && typed >= 0) {
      const committed = Math.min(typed, MAX_TOLERANCE);
      setInput(committed);
      if (committed !== value) onChange(committed);
    } else {
      setInput(value);
      setBlurError(`Enter a number (0 means an exact match). Kept ${value}.`);
    }
  };

  return (
    <NumberInput
      label="Numeric tolerance"
      description={
        <>
          {TOLERANCE_HELP}
          {value > LOOSE_TOLERANCE && (
            <Text span inherit fw={600} display="block" mt={4}>
              That's a very loose tolerance: numbers up to {value.toLocaleString()} away from the answer count as
              correct.
            </Text>
          )}
        </>
      }
      value={input}
      onChange={(v) => {
        setInput(v);
        setBlurError(null);
        if (typeof v === 'number') onChange(v);
      }}
      onBlur={handleBlur}
      min={0}
      max={MAX_TOLERANCE}
      step={0.01}
      decimalScale={6}
      allowNegative={false}
      styles={{ wrapper: { maxWidth: 240 } }}
      error={error ?? blurError}
    />
  );
}

/** Autograder options: what is checked, how values are compared and what students see. */
export function GradingConfigFields({
  config,
  onChange,
  hasTemplate,
  rangesError,
  toleranceError,
}: GradingConfigFieldsProps) {
  return (
    <Stack gap="lg">
      <Stack gap={6}>
        <Input.Label>Which cells are checked</Input.Label>
        <SegmentedControl
          data={SCOPE_OPTIONS}
          value={config.scope}
          onChange={(v) => onChange({ scope: v as GradingScope })}
          fullWidth
          aria-label="Which cells are checked"
        />
        <Text size="xs" c="dimmed">
          {SCOPE_HELP[config.scope]}
        </Text>
        {config.scope === 'ranges' && (
          <TagsInput
            label="Ranges to check"
            description={RANGES_HELP}
            placeholder="Sheet1!B2:D10"
            value={config.ranges}
            onChange={(ranges) => onChange({ ranges: ranges.map((r) => r.trim()).filter(Boolean) })}
            splitChars={[',', ';']}
            clearable
            error={rangesError}
            mt="xs"
          />
        )}
      </Stack>

      <ToleranceInput
        value={config.numericTolerance}
        onChange={(numericTolerance) => onChange({ numericTolerance })}
        error={toleranceError}
      />

      <Divider label="Comparing answers" labelPosition="left" />
      <Stack gap="md">
        <OptionSwitch
          label="Require formulas where the key uses formulas"
          description="A typed-in number is marked wrong if your key calculates that cell with a formula."
          checked={config.requireFormulas}
          onChange={(requireFormulas) => onChange({ requireFormulas })}
        />
        <OptionSwitch
          label="Ignore case"
          description={'Text answers match regardless of capitalization ("total" = "Total").'}
          checked={!config.caseSensitive}
          onChange={(ignoreCase) => onChange({ caseSensitive: !ignoreCase })}
        />
        <OptionSwitch
          label="Ignore extra spaces"
          description="Leading, trailing and repeated spaces in text answers are ignored."
          checked={config.ignoreWhitespace}
          onChange={(ignoreWhitespace) => onChange({ ignoreWhitespace })}
        />
        <OptionSwitch
          label="Skip cells already filled in the starter file"
          description={
            hasTemplate
              ? "Students don't get credit for content you gave them in the starter file."
              : 'Attach a starter file below to use this option.'
          }
          checked={hasTemplate && config.excludeTemplateCells}
          disabled={!hasTemplate}
          onChange={(excludeTemplateCells) => onChange({ excludeTemplateCells })}
        />
      </Stack>

      <Divider label="What students see" labelPosition="left" />
      <Stack gap="md">
        <OptionSwitch
          label="Show students which cells were wrong"
          description="Students see a cell-by-cell report with their score."
          checked={config.showDetailsToStudents}
          onChange={(showDetailsToStudents) =>
            onChange(
              showDetailsToStudents
                ? { showDetailsToStudents }
                : { showDetailsToStudents, showExpectedToStudents: false },
            )
          }
        />
        <OptionSwitch
          label="Show students the expected answers"
          description={
            config.showDetailsToStudents
              ? 'The report also shows the correct value or formula for every cell.'
              : 'Turn on the cell-by-cell report first.'
          }
          checked={config.showDetailsToStudents && config.showExpectedToStudents}
          disabled={!config.showDetailsToStudents}
          onChange={(showExpectedToStudents) => onChange({ showExpectedToStudents })}
        />
      </Stack>
    </Stack>
  );
}
