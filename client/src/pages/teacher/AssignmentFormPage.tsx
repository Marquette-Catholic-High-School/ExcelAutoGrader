import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Accordion,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { useHotkeys } from '@mantine/hooks';
import {
  IconAdjustments,
  IconAlertCircle,
  IconCalendarDue,
  IconChecklist,
  IconDeviceFloppy,
  IconEye,
  IconFileDescription,
  IconFileSpreadsheet,
  IconInfoCircle,
  IconPencil,
  IconRefresh,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useNavigate, useParams } from 'react-router';
import { DEFAULT_GRADING_CONFIG, type AssignmentDetail, type GradingConfig, type GradingMode } from '@shared/types';
import { endpoints, qk, type AssignmentFormPayload } from '../../api/endpoints';
import { isNotFoundError } from '../../components/NotFoundCard';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, PageLoader } from '../../components/QueryState';
import { errorMessage, fieldErrors, notifyError, notifySuccess } from '../../utils/errors';
import { parseId } from '../../utils/params';
import { usePageTitle } from '../../utils/usePageTitle';
import { AssignmentNotFound } from './assignment/AssignmentNotFound';
import { invalidateAssignment } from './assignment/cache';
import {
  DUE_DISPLAY_FORMAT,
  defaultDueDate,
  endOfDayIn,
  isValidPickerValue,
  isoToPicker,
  pickerToIso,
} from './assignment/dates';
import { FileSlot } from './assignment/FileSlot';
import { GradingConfigFields, MAX_TOLERANCE, gradingConfigSummary } from './assignment/GradingConfigFields';
import { GradingModeCards } from './assignment/GradingModeCards';
import { KeyPreviewCard, type KeyPreviewInput } from './assignment/KeyPreviewCard';
import { ShortcutHint } from './assignment/ShortcutHint';
import { useUnsavedChangesGuard } from './assignment/useUnsavedChangesGuard';
import { ClassNotFound } from './class/ClassNotFound';
import classes from './assignment/assignment.module.css';

interface FormValues {
  title: string;
  description: string;
  /** Local "YYYY-MM-DD HH:mm:ss" picker value. */
  dueAt: string | null;
  points: number | string;
  gradingMode: GradingMode;
  config: GradingConfig;
}

const MISSING_KEY_MESSAGE =
  'Upload the finished workbook (answer key) so the autograder has something to compare against.';
const KEY_DESCRIPTION =
  "Your completed copy with every answer filled in. Each student's workbook is compared to it cell by cell.";
const FORM_FIELDS = ['title', 'description', 'dueAt', 'points'] as const;

/** Computed when the form opens (not at import time), so the presets stay right in a tab left open overnight. */
function duePresets() {
  return [
    { value: endOfDayIn(1), label: 'Tomorrow, 11:59 PM' },
    { value: endOfDayIn(3), label: 'In 3 days' },
    { value: endOfDayIn(7), label: 'In 1 week' },
    { value: endOfDayIn(14), label: 'In 2 weeks' },
  ];
}

function initialValues(existing?: AssignmentDetail): FormValues {
  if (!existing) {
    return {
      title: '',
      description: '',
      dueAt: defaultDueDate(),
      points: 100,
      gradingMode: 'auto',
      config: { ...DEFAULT_GRADING_CONFIG, ranges: [] },
    };
  }
  const config = { ...DEFAULT_GRADING_CONFIG, ...existing.gradingConfig };
  return {
    title: existing.title,
    description: existing.description,
    dueAt: isoToPicker(existing.dueAt),
    points: existing.points,
    gradingMode: existing.gradingMode,
    config: { ...config, ranges: [...config.ranges] },
  };
}

/**
 * The options that affect scores. The student-visibility switches only change what students see, so the server
 * doesn't re-grade for them (server/src/services/config.ts gradingRulesChanged).
 */
function scoringRules({ showDetailsToStudents: _details, showExpectedToStudents: _expected, ...rules }: GradingConfig) {
  return rules;
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : value.trim() === '' ? NaN : Number(value);
}

/** Scroll the first invalid field (or flagged section) into view once the DOM shows the errors. */
function scrollToFirstError(delay = 60) {
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid-section="true"]');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (el.matches('input, textarea, button')) el.focus({ preventScroll: true });
  }, delay);
}

function SectionHeading({ icon, title, children }: { icon: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start" mb="md">
      <ThemeIcon variant="light" size={36} radius="md">
        {icon}
      </ThemeIcon>
      <Stack gap={2} style={{ flex: 1 }}>
        <Title order={3} fz="h4">
          {title}
        </Title>
        {children && (
          <Text size="sm" c="dimmed">
            {children}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function AssignmentForm({
  classId,
  className,
  existing,
}: {
  classId: number;
  className: string;
  existing?: AssignmentDetail;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isEdit = existing !== undefined;
  const storedKey = existing?.key ?? null;
  const storedTemplate = existing?.template ?? null;

  const form = useForm<FormValues>({
    initialValues: initialValues(existing),
    validate: {
      title: (v) => {
        const t = v.trim();
        if (!t) return 'Give the assignment a title.';
        return t.length > 200 ? 'Keep the title under 200 characters.' : null;
      },
      description: (v) => (v.length > 10_000 ? 'Instructions can be at most 10,000 characters.' : null),
      dueAt: (v) => (isValidPickerValue(v) ? null : 'Choose when the assignment is due.'),
      points: (v) => {
        const n = toNumber(v);
        if (!Number.isFinite(n) || n <= 0) return 'Points must be more than 0.';
        return n > 10_000 ? 'Points can be at most 10,000.' : null;
      },
      // Grading options are only sent (and shown) in auto mode, so they never block saving a manual assignment.
      config: {
        ranges: (ranges, values) =>
          values.gradingMode === 'auto' && values.config.scope === 'ranges' && ranges.length === 0
            ? 'Add at least one range, e.g. Sheet1!B2:D10.'
            : null,
        numericTolerance: (v, values) => {
          if (values.gradingMode !== 'auto') return null;
          if (!Number.isFinite(v) || v < 0) return 'Tolerance must be 0 or more.';
          return v > MAX_TOLERANCE ? 'Tolerance can be at most 1,000,000,000.' : null;
        },
      },
    },
  });

  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [removeTemplate, setRemoveTemplate] = useState(false);
  const [fileErrors, setFileErrors] = useState<{ keyFile?: string; templateFile?: string }>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [missingKey, setMissingKey] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState<string | null>(null);
  const presets = useMemo(duePresets, []);

  const values = form.getValues();
  const initial = form.getInitialValues();
  const isAuto = values.gradingMode === 'auto';
  const hasTemplate = !!templateFile || (!!storedTemplate && !removeTemplate);
  const dirty = form.isDirty() || !!keyFile || !!templateFile || removeTemplate;
  const { guard, bypass } = useUnsavedChangesGuard(dirty, {
    message: isEdit
      ? 'Your changes to this assignment have not been saved. Leave without saving?'
      : 'This assignment has not been created yet. Leave and lose what you entered?',
  });

  const previewInput: KeyPreviewInput | null =
    isAuto && (keyFile || storedKey)
      ? {
          config: values.config,
          keyFile,
          templateFile,
          assignmentId: existing?.id,
          ignoreStoredTemplate: removeTemplate && !templateFile,
        }
      : null;
  const activePreviewErrors = previewInput ? previewErrors : {};

  const keyError = fileErrors.keyFile ?? (missingKey ? MISSING_KEY_MESSAGE : undefined);
  const templateError = fileErrors.templateFile ?? activePreviewErrors.templateFile;
  const rangesError =
    form.errors['config.ranges'] ?? (values.config.scope === 'ranges' ? activePreviewErrors.gradingConfig : undefined);

  const setMode = (mode: GradingMode) => {
    form.setFieldValue('gradingMode', mode);
    if (mode === 'manual') {
      setMissingKey(false);
      setFileErrors((e) => ({ ...e, keyFile: undefined }));
    }
  };

  const patchConfig = (patch: Partial<GradingConfig>) => {
    form.setFieldValue('config', { ...form.getValues().config, ...patch });
    setConfigError(null);
    if (patch.ranges) form.clearFieldError('config.ranges');
  };

  const handleKeyFile = (file: File | null) => {
    setKeyFile(file);
    setMissingKey(false);
    setFileErrors((e) => ({ ...e, keyFile: undefined }));
  };

  const handleTemplateFile = (file: File | null) => {
    setTemplateFile(file);
    if (file) setRemoveTemplate(false);
    setFileErrors((e) => ({ ...e, templateFile: undefined }));
  };

  /**
   * Puts each server field error next to its field. Errors for fields that are not on screen right now (the answer
   * key and grading options are hidden in manual mode) go into the alert above the save bar instead, so a failed
   * save is never silent.
   */
  const applyServerErrors = (err: unknown) => {
    const fields = fieldErrors(err);
    const auto = form.getValues().gradingMode === 'auto';
    const formErrors: Record<string, string> = {};
    for (const name of FORM_FIELDS) if (fields[name]) formErrors[name] = fields[name];
    form.setErrors(formErrors);
    const shown = new Set<string>(Object.keys(formErrors));
    const keyFileError = auto ? fields.keyFile : undefined;
    setFileErrors({ keyFile: keyFileError, templateFile: fields.templateFile });
    if (keyFileError) {
      shown.add('keyFile');
      if (!keyFile && !storedKey) setMissingKey(true);
    }
    if (fields.templateFile) shown.add('templateFile');
    if (auto && fields.gradingConfig) {
      shown.add('gradingConfig');
      setConfigError(fields.gradingConfig);
      setOptionsOpen('options');
    }
    const unshown = Object.entries(fields)
      .filter(([name]) => !shown.has(name))
      .map(([, message]) => message);
    if (unshown.length > 0) setSubmitError(unshown.join(' '));
    else if (shown.size === 0) setSubmitError(errorMessage(err));
    scrollToFirstError(shown.has('gradingConfig') ? 260 : 60);
  };

  const save = useMutation({
    mutationFn: (payload: AssignmentFormPayload) =>
      existing ? endpoints.updateAssignment(existing.id, payload) : endpoints.createAssignment(classId, payload),
    onSuccess: async (saved) => {
      await invalidateAssignment(qc, classId, saved.id);
      qc.setQueryData(qk.assignment(saved.id), saved);
      notifySuccess(
        existing ? 'Your changes are saved.' : `“${saved.title}” is ready for students.`,
        existing ? 'Assignment updated' : 'Assignment created',
      );
      // Saved: leave without the unsaved-changes prompt.
      bypass(() => navigate(`/teacher/assignments/${saved.id}`));
    },
    onError: applyServerErrors,
  });

  const handleSubmit = (event?: FormEvent) => {
    event?.preventDefault();
    if (save.isPending) return;
    setSubmitError(null);
    const { hasErrors, errors } = form.validate();
    const v = form.getValues();
    const keyMissing = v.gradingMode === 'auto' && !keyFile && !storedKey;
    setMissingKey(keyMissing);
    const optionsError = !!errors['config.ranges'] || !!errors['config.numericTolerance'];
    if (optionsError) setOptionsOpen('options');
    if (hasErrors || keyMissing) {
      scrollToFirstError(optionsError ? 260 : 60);
      return;
    }
    save.mutate({
      title: v.title.trim(),
      description: v.description,
      // Keep the exact stored timestamp when the teacher didn't touch the date (the picker drops milliseconds).
      dueAt: existing && v.dueAt === initial.dueAt ? existing.dueAt : pickerToIso(v.dueAt as string),
      points: toNumber(v.points),
      gradingMode: v.gradingMode,
      // Manual grading doesn't use the options (they're hidden), so don't send them: the server then keeps the
      // stored ones (edit) or uses the defaults (create), and hidden settings can't block the save.
      gradingConfig: v.gradingMode === 'auto' ? v.config : undefined,
      keyFile: v.gradingMode === 'auto' ? keyFile : null,
      templateFile,
      removeTemplate: isEdit && removeTemplate && !templateFile,
    });
  };

  useHotkeys([['mod+Enter', () => handleSubmit()]], []);

  const cancelTarget = existing ? `/teacher/assignments/${existing.id}` : `/teacher/classes/${classId}`;
  const dueChanged = isEdit && values.dueAt !== initial.dueAt;
  const dueInPast = isValidPickerValue(values.dueAt) && dayjs(values.dueAt).isBefore(dayjs());

  const gradingChanged =
    isEdit &&
    (!!keyFile ||
      !!templateFile ||
      removeTemplate ||
      values.gradingMode !== initial.gradingMode ||
      toNumber(values.points) !== toNumber(initial.points) ||
      JSON.stringify(scoringRules(values.config)) !== JSON.stringify(scoringRules(initial.config)));
  const submittedCount = existing?.counts?.submitted;
  const hasSubmissions = submittedCount === undefined || submittedCount > 0;
  const submissionsLabel =
    submittedCount === undefined
      ? 'every existing submission'
      : `every submission from the ${submittedCount} student${submittedCount === 1 ? '' : 's'} who turned work in`;

  let saveBarStatus: string;
  if (save.isPending) saveBarStatus = gradingChanged && isAuto ? 'Saving and re-grading submissions…' : 'Saving…';
  else if (isEdit) saveBarStatus = dirty ? 'You have unsaved changes.' : 'No changes yet.';
  else if (!isAuto) saveBarStatus = 'Graded manually in the built-in viewer.';
  else if (keyFile) saveBarStatus = `Autograded against ${keyFile.name}.`;
  else saveBarStatus = 'Autograded — the answer key is still needed.';

  return (
    <Box maw={920} mx="auto">
      <PageHeader
        crumbs={
          existing
            ? [
                { label: className, to: `/teacher/classes/${classId}` },
                { label: existing.title, to: `/teacher/assignments/${existing.id}` },
                { label: 'Edit' },
              ]
            : [{ label: className, to: `/teacher/classes/${classId}` }, { label: 'New assignment' }]
        }
        title={existing ? 'Edit assignment' : 'New assignment'}
        subtitle={
          existing
            ? 'Changes apply right away. Students keep their submissions.'
            : 'Describe the task, set a due date, and choose how it will be graded.'
        }
      />

      <form onSubmit={handleSubmit} noValidate>
        <Stack gap="lg">
          <Card>
            <SectionHeading icon={<IconFileDescription size={20} />} title="Details" />
            <Stack gap="md">
              <TextInput
                label="Title"
                placeholder="e.g. Monthly budget with SUM and AVERAGE"
                withAsterisk
                maxLength={200}
                data-autofocus
                {...form.getInputProps('title')}
              />
              <Textarea
                label="Instructions"
                description="Shown to students on the assignment page."
                placeholder="What should students build? Which sheets and cells should they fill in?"
                autosize
                minRows={3}
                maxRows={14}
                {...form.getInputProps('description')}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                <DateTimePicker
                  label="Due"
                  withAsterisk
                  placeholder="Pick a date and time"
                  valueFormat={DUE_DISPLAY_FORMAT}
                  leftSection={<IconCalendarDue size={18} />}
                  timePickerProps={{ format: '12h' }}
                  presets={presets}
                  description="Students can still upload after this, but late work is flagged."
                  {...form.getInputProps('dueAt')}
                />
                <NumberInput
                  label="Points"
                  withAsterisk
                  description="Autograde scores are scaled to this total."
                  min={0}
                  max={10_000}
                  step={1}
                  decimalScale={2}
                  allowNegative={false}
                  {...form.getInputProps('points')}
                />
              </SimpleGrid>
              {(dueInPast || dueChanged) && (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <IconInfoCircle
                    size={16}
                    color="var(--mantine-color-dimmed)"
                    style={{ flexShrink: 0, marginTop: 2 }}
                  />
                  <Text size="xs" c="dimmed">
                    {dueInPast && 'This due date is in the past, so new submissions will be marked late. '}
                    {dueChanged && 'Late flags on existing submissions will update to match the new due date.'}
                  </Text>
                </Group>
              )}
            </Stack>
          </Card>

          <Card>
            <SectionHeading icon={<IconChecklist size={20} />} title="How should this be graded?">
              Choose how student workbooks are scored. You can change this later.
            </SectionHeading>
            <Stack gap="lg">
              <GradingModeCards value={values.gradingMode} onChange={setMode} />

              {isAuto ? (
                <Stack gap="md" data-invalid-section={keyError ? 'true' : undefined}>
                  <FileSlot
                    label="Answer key — the finished workbook"
                    description={KEY_DESCRIPTION}
                    stored={storedKey}
                    file={keyFile}
                    onFile={handleKeyFile}
                    error={keyError}
                    required
                    onDownloadStored={
                      existing ? () => endpoints.downloadKey(existing.id).catch((e) => notifyError(e)) : undefined
                    }
                  />
                  {missingKey && (
                    <Alert
                      color="orange"
                      variant="light"
                      icon={<IconAlertCircle />}
                      title="An answer key is needed to autograde"
                    >
                      <Stack gap="sm" align="flex-start">
                        <Text size="sm">
                          The autograder compares every submission with your finished workbook. Don't have one ready?
                          You can grade this assignment by hand instead and add a key later.
                        </Text>
                        <Button
                          size="xs"
                          color="orange"
                          variant="filled"
                          leftSection={<IconPencil size={14} />}
                          onClick={() => setMode('manual')}
                        >
                          Grade manually instead
                        </Button>
                      </Stack>
                    </Alert>
                  )}
                  {previewInput && <KeyPreviewCard input={previewInput} onFieldErrors={setPreviewErrors} />}
                  <Accordion variant="contained" radius="md" value={optionsOpen} onChange={setOptionsOpen}>
                    <Accordion.Item value="options">
                      <Accordion.Control icon={<IconAdjustments size={18} />}>
                        <Text fw={600} size="sm">
                          Grading options
                        </Text>
                        <Text size="xs" c="dimmed">
                          {gradingConfigSummary(values.config)}
                        </Text>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="md" pt="xs">
                          {configError && (
                            <Alert color="red" variant="light" icon={<IconAlertCircle />}>
                              {configError}
                            </Alert>
                          )}
                          <GradingConfigFields
                            config={values.config}
                            onChange={patchConfig}
                            hasTemplate={hasTemplate}
                            rangesError={rangesError}
                            toleranceError={form.errors['config.numericTolerance']}
                          />
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                </Stack>
              ) : (
                <Alert color="indigo" variant="light" icon={<IconEye />} title="You'll grade each submission yourself">
                  <Text size="sm">
                    Students' uploaded workbooks open in the built-in spreadsheet viewer, right next to a score and
                    feedback box, so you can grade them without downloading anything.
                    {storedKey &&
                      ` Your answer key (${storedKey.name}) is kept, so you can switch back to autograding at any time.`}
                    {!storedKey &&
                      keyFile &&
                      ' The answer key you picked will only be uploaded if you switch back to autograding.'}
                  </Text>
                </Alert>
              )}
            </Stack>
          </Card>

          <Card>
            <SectionHeading
              icon={<IconFileSpreadsheet size={20} />}
              title={
                <Group gap={8} component="span">
                  Starter file
                  <Badge variant="light" color="gray" size="sm">
                    Optional
                  </Badge>
                </Group>
              }
            >
              A workbook students download to start from — for example with the data and headings already in place.
            </SectionHeading>
            <FileSlot
              label="Starter file (template)"
              description="Students see a download button for this file on the assignment page."
              stored={storedTemplate}
              file={templateFile}
              onFile={handleTemplateFile}
              error={templateError}
              removable
              removed={removeTemplate}
              onRemovedChange={setRemoveTemplate}
              onDownloadStored={
                existing ? () => endpoints.downloadTemplate(existing.id).catch((e) => notifyError(e)) : undefined
              }
            />
          </Card>

          {gradingChanged && hasSubmissions && (isAuto || initial.gradingMode === 'auto') && (
            <Alert color="yellow" variant="light" icon={<IconRefresh />} title="Existing submissions will be updated">
              {isAuto
                ? `Saving will re-run the autograder on ${submissionsLabel} with the updated answer key and ` +
                  'settings. Scores you entered yourself are kept.'
                : 'Switching to manual grading removes the autograde scores from existing submissions, so you can ' +
                  'grade them by hand. Your answer key is kept so you can switch back.'}
            </Alert>
          )}

          {submitError && (
            <Alert
              color="red"
              variant="light"
              icon={<IconAlertCircle />}
              title="Couldn't save the assignment"
              withCloseButton
              onClose={() => setSubmitError(null)}
              data-invalid-section="true"
            >
              {submitError}
            </Alert>
          )}

          <Paper withBorder shadow="md" p="sm" px="md" className={classes.saveBar}>
            <Group justify="space-between" wrap="wrap" gap="sm">
              <Text size="sm" c="dimmed">
                {saveBarStatus}
              </Text>
              <Group gap="sm">
                <ShortcutHint keys={['mod', 'Enter']} visibleFrom="sm" />
                <Button variant="default" onClick={() => guard(() => navigate(cancelTarget))} disabled={save.isPending}>
                  Cancel
                </Button>
                <Button type="submit" loading={save.isPending} leftSection={<IconDeviceFloppy size={18} />}>
                  {isEdit ? 'Save changes' : 'Create assignment'}
                </Button>
              </Group>
            </Group>
          </Paper>
        </Stack>
      </form>
    </Box>
  );
}

function CreateAssignment({ classId }: { classId: number }) {
  const classQ = useQuery({ queryKey: qk.class(classId), queryFn: () => endpoints.getClass(classId) });
  usePageTitle('New assignment');
  if (classQ.isPending) return <PageLoader label="Loading class…" />;
  if (isNotFoundError(classQ.error)) return <ClassNotFound home="/teacher" />;
  if (classQ.error || !classQ.data) return <ErrorAlert error={classQ.error} onRetry={() => classQ.refetch()} />;
  return <AssignmentForm classId={classQ.data.id} className={classQ.data.name} />;
}

function EditAssignment({ assignmentId }: { assignmentId: number }) {
  const assignmentQ = useQuery({
    queryKey: qk.assignment(assignmentId),
    queryFn: () => endpoints.getAssignment(assignmentId),
    // Don't swap the form's source data mid-edit.
    staleTime: Infinity,
    refetchOnMount: 'always',
  });
  usePageTitle(assignmentQ.data ? `Edit ${assignmentQ.data.title}` : 'Edit assignment');
  // The form copies its initial values once, so wait for the fresh copy instead of starting from cached data.
  if (assignmentQ.isPending || (!assignmentQ.isFetchedAfterMount && assignmentQ.isFetching)) {
    return <PageLoader label="Loading assignment…" />;
  }
  if (isNotFoundError(assignmentQ.error)) return <AssignmentNotFound />;
  if (assignmentQ.error || !assignmentQ.data) {
    return <ErrorAlert error={assignmentQ.error} onRetry={() => assignmentQ.refetch()} />;
  }
  const a = assignmentQ.data;
  return <AssignmentForm classId={a.classId} className={a.className} existing={a} />;
}

/** Create (/teacher/classes/:classId/assignments/new) or edit (/teacher/assignments/:assignmentId/edit). */
export function AssignmentFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const params = useParams();
  if (mode === 'create') {
    const classId = parseId(params.classId);
    if (classId === null) return <ClassNotFound home="/teacher" />;
    return <CreateAssignment key={classId} classId={classId} />;
  }
  const assignmentId = parseId(params.assignmentId);
  if (assignmentId === null) return <AssignmentNotFound />;
  return <EditAssignment key={assignmentId} assignmentId={assignmentId} />;
}
