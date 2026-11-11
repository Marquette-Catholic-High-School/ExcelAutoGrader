import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Group,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconDeviceFloppy, IconInbox, IconInfoCircle, IconMail, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClassNotificationSettings, EmailKind, EmailLogEntry, EmailState } from '@shared/types';
import { endpoints, qk, type ClassNotificationsUpdate } from '../../../api/endpoints';
import { EmailNotConfiguredAlert, senderLabel, useEmailStatus } from '../../../components/EmailStatus';
import { QueryState } from '../../../components/QueryState';
import { BADGE_NO_SHRINK } from '../../../components/StatusBadges';
import { fieldErrors, notifyError, notifySuccess } from '../../../utils/errors';
import { formatDateTime } from '../../../utils/format';

const LOG_LIMIT = 100;
const LOG_POLL_MS = 10_000;
/** Lines the reminder options up with the text of the switch above them (38px track + 12px gap). */
const UNDER_SWITCH = { base: 0, sm: 50 };

/** Same ranges as the server validates (docs/API.md, ClassNotificationSettings). */
const LIMITS = {
  firstReminderAfterHours: { min: 0, max: 168 },
  reminderIntervalDays: { min: 1, max: 14 },
  maxReminders: { min: 1, max: 10 },
} as const;
type NumberField = keyof typeof LIMITS;
const NUMBER_FIELDS = Object.keys(LIMITS) as NumberField[];

/** NumberInput reports '' while the box is empty, hence the string. */
type FormValues = Omit<ClassNotificationSettings, 'remindersSince' | NumberField> &
  Record<NumberField, number | string>;

function toFormValues(s: ClassNotificationSettings): FormValues {
  return {
    submissionReceipts: s.submissionReceipts,
    overdueReminders: s.overdueReminders,
    firstReminderAfterHours: s.firstReminderAfterHours,
    reminderIntervalDays: s.reminderIntervalDays,
    maxReminders: s.maxReminders,
    includePendingStudents: s.includePendingStudents,
  };
}

/** Reminder timing is only checked while reminders are on; when they're off, unfinished numbers are left out. */
function toUpdate(values: FormValues): ClassNotificationsUpdate {
  const body: ClassNotificationsUpdate = {
    submissionReceipts: values.submissionReceipts,
    overdueReminders: values.overdueReminders,
    includePendingStudents: values.includePendingStudents,
  };
  for (const field of NUMBER_FIELDS) {
    const value = values[field];
    if (typeof value === 'number') body[field] = value;
  }
  return body;
}

function wholeNumberRule(field: NumberField) {
  const { min, max } = LIMITS[field];
  return (value: number | string, values: FormValues) => {
    if (!values.overdueReminders) return null;
    const ok = typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
    return ok ? null : `Enter a whole number from ${min} to ${max}`;
  };
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The reminder schedule in one sentence, or null while a number is unfinished. */
function reminderSummary(values: FormValues): string | null {
  const { firstReminderAfterHours: hours, reminderIntervalDays: days, maxReminders: max } = values;
  if (typeof hours !== 'number' || typeof days !== 'number' || typeof max !== 'number') return null;
  const first = hours === 0 ? 'as soon as the assignment is overdue' : `${plural(hours, 'hour')} after the due date`;
  if (max === 1) return `A student who hasn't submitted gets one reminder, ${first}.`;
  return (
    `A student who hasn't submitted gets the first reminder ${first}, then one every ` +
    `${days === 1 ? 'day' : plural(days, 'day')}, up to ${max} reminders in all.`
  );
}

function NotificationSettingsForm({ classId, settings }: { classId: number; settings: ClassNotificationSettings }) {
  const qc = useQueryClient();
  const form = useForm<FormValues>({
    initialValues: toFormValues(settings),
    validate: {
      firstReminderAfterHours: wholeNumberRule('firstReminderAfterHours'),
      reminderIntervalDays: wholeNumberRule('reminderIntervalDays'),
      maxReminders: wholeNumberRule('maxReminders'),
    },
  });

  const save = useMutation({
    mutationFn: (values: FormValues) => endpoints.updateClassNotifications(classId, toUpdate(values)),
    onSuccess: (updated) => {
      qc.setQueryData(qk.classNotifications(classId), updated);
      const values = toFormValues(updated);
      form.setInitialValues(values);
      form.setValues(values);
      form.resetDirty(values);
      notifySuccess('Email settings saved.');
    },
    onError: (err) => {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length > 0) form.setErrors(fields);
      else notifyError(err, 'Could not save the email settings');
    },
  });

  const remindersOn = form.values.overdueReminders;
  const summary = remindersOn ? reminderSummary(form.values) : null;

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))} noValidate>
      <Stack gap="lg">
        <Switch
          label="Send submission receipts"
          description="Each time work is turned in (by the student, or by you for them), the student gets an email with the time, attempt number, late flag and autograde score."
          {...form.getInputProps('submissionReceipts', { type: 'checkbox' })}
        />

        <Stack gap="sm">
          <Switch
            label="Remind students about overdue work"
            description="Students who haven't submitted an assignment get reminders after its due date. They stop as soon as the student submits; late work is still accepted."
            {...form.getInputProps('overdueReminders', { type: 'checkbox' })}
          />
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" pl={UNDER_SWITCH}>
            <NumberInput
              label="First reminder"
              description="Hours after the due date (0–168)"
              disabled={!remindersOn}
              min={LIMITS.firstReminderAfterHours.min}
              max={LIMITS.firstReminderAfterHours.max}
              allowDecimal={false}
              allowNegative={false}
              {...form.getInputProps('firstReminderAfterHours')}
            />
            <NumberInput
              label="Then every"
              description="Days between reminders (1–14)"
              disabled={!remindersOn}
              min={LIMITS.reminderIntervalDays.min}
              max={LIMITS.reminderIntervalDays.max}
              allowDecimal={false}
              allowNegative={false}
              {...form.getInputProps('reminderIntervalDays')}
            />
            <NumberInput
              label="At most"
              description="Per student and assignment (1–10)"
              disabled={!remindersOn}
              min={LIMITS.maxReminders.min}
              max={LIMITS.maxReminders.max}
              allowDecimal={false}
              allowNegative={false}
              {...form.getInputProps('maxReminders')}
            />
          </SimpleGrid>
          {summary && (
            <Text size="sm" pl={UNDER_SWITCH}>
              {summary}
            </Text>
          )}
          <Group gap={6} wrap="nowrap" align="flex-start" pl={UNDER_SWITCH}>
            <IconInfoCircle size={16} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0, marginTop: 2 }} />
            <Text size="xs" c="dimmed">
              Reminders only cover assignments due after {formatDateTime(settings.remindersSince)}, so students are
              never emailed about work that was already overdue before email was set up for this class.
            </Text>
          </Group>
        </Stack>

        <Switch
          label="Include students who haven't signed up"
          description="Invited students who haven't created their account yet get these emails too, with steps for signing up."
          {...form.getInputProps('includePendingStudents', { type: 'checkbox' })}
        />

        <Group justify="flex-end" gap="sm">
          <Button variant="default" disabled={!form.isDirty() || save.isPending} onClick={() => form.reset()}>
            Discard changes
          </Button>
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!form.isDirty()}
            leftSection={<IconDeviceFloppy size={18} />}
          >
            Save changes
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function NotificationSettingsCard({ classId }: { classId: number }) {
  const query = useQuery({
    queryKey: qk.classNotifications(classId),
    queryFn: () => endpoints.getClassNotifications(classId),
  });
  const status = useEmailStatus().data;
  return (
    <Card>
      <Group gap="sm" mb={4}>
        <IconMail size={20} color="var(--mantine-color-dimmed)" />
        <Title order={3} fz="h4">
          Email notifications
        </Title>
      </Group>
      <Text size="sm" c="dimmed" mb="lg">
        Choose which emails students in this class get
        {status ? ` from ${senderLabel(status)}` : ''}. Students can turn them off for themselves on their Account
        page.
      </Text>
      <QueryState query={query} loadingLabel="Loading email settings…">
        {(settings) => <NotificationSettingsForm classId={classId} settings={settings} />}
      </QueryState>
    </Card>
  );
}

const KIND_BADGES: Record<EmailKind, { label: string; color: string }> = {
  receipt: { label: 'Receipt', color: 'blue' },
  overdue: { label: 'Overdue reminder', color: 'orange' },
  daily_report: { label: 'Daily report', color: 'grape' },
  test: { label: 'Test', color: 'gray' },
};

const STATE_BADGES: Record<EmailState, { label: string; color: string }> = {
  sent: { label: 'Sent', color: 'teal' },
  queued: { label: 'Queued', color: 'gray' },
  failed: { label: 'Failed', color: 'red' },
};

function EmailStateCell({ entry }: { entry: EmailLogEntry }) {
  const retrying = entry.state === 'queued' && entry.attempts > 0;
  const badge = STATE_BADGES[entry.state];
  return (
    <Stack gap={4} align="flex-start">
      <Badge variant="light" color={retrying ? 'yellow' : badge.color} size="sm" {...BADGE_NO_SHRINK}>
        {retrying ? `Retrying (${plural(entry.attempts, 'attempt')})` : badge.label}
      </Badge>
      {entry.error && (
        <Tooltip label={entry.error} multiline w={340}>
          <Text
            size="xs"
            c={entry.state === 'failed' ? 'red' : 'dimmed'}
            lineClamp={2}
            style={{ wordBreak: 'break-word' }}
          >
            {entry.error}
          </Text>
        </Tooltip>
      )}
    </Stack>
  );
}

function EmailTime({ entry }: { entry: EmailLogEntry }) {
  const label = entry.sentAt
    ? `Queued ${formatDateTime(entry.createdAt)} · sent ${formatDateTime(entry.sentAt)}`
    : `Queued ${formatDateTime(entry.createdAt)}`;
  return (
    <Tooltip label={label}>
      <Text size="sm" w="fit-content">
        {formatDateTime(entry.sentAt ?? entry.createdAt)}
      </Text>
    </Tooltip>
  );
}

function EmailLogTable({ entries }: { entries: EmailLogEntry[] }) {
  return (
    <Table.ScrollContainer minWidth={720}>
      <Table verticalSpacing="sm" horizontalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={170}>Time</Table.Th>
            <Table.Th>Email</Table.Th>
            <Table.Th>To</Table.Th>
            <Table.Th w={190}>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((e) => {
            const kind = KIND_BADGES[e.kind];
            return (
              <Table.Tr key={e.id}>
                <Table.Td>
                  <EmailTime entry={e} />
                </Table.Td>
                <Table.Td>
                  <Stack gap={4} align="flex-start">
                    <Badge variant="light" color={kind.color} size="xs" {...BADGE_NO_SHRINK}>
                      {kind.label}
                    </Badge>
                    <Text size="sm" style={{ wordBreak: 'break-word' }}>
                      {e.subject}
                    </Text>
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{e.toName}</Text>
                  <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                    {e.toAddress}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <EmailStateCell entry={e} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function EmailLogCard({ classId }: { classId: number }) {
  const query = useQuery({
    queryKey: qk.classEmails(classId),
    queryFn: () => endpoints.listClassEmails(classId, LOG_LIMIT),
    // Follow queued messages until the background sender has dealt with them.
    refetchInterval: (q) => (q.state.data?.some((e) => e.state === 'queued') ? LOG_POLL_MS : false),
  });
  return (
    <Card>
      <Group justify="space-between" wrap="wrap" gap="sm" mb={4}>
        <Title order={3} fz="h4">
          Email log
        </Title>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconRefresh size={14} />}
          loading={query.isFetching && !query.isPending}
          onClick={() => query.refetch()}
        >
          Refresh
        </Button>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Receipts and reminders sent for this class, newest first.
      </Text>
      <QueryState query={query} loadingLabel="Loading email log…">
        {(entries) =>
          entries.length === 0 ? (
            <EmptyState
              variant="light"
              size="sm"
              icon={<IconInbox size={28} />}
              title="No emails yet"
              description="Receipts and overdue reminders for this class will be listed here once they go out."
            />
          ) : (
            <>
              <EmailLogTable entries={entries} />
              {entries.length >= LOG_LIMIT && (
                <>
                  <Divider my="xs" />
                  <Text size="xs" c="dimmed">
                    Showing the latest {LOG_LIMIT} emails.
                  </Text>
                </>
              )}
            </>
          )
        }
      </QueryState>
    </Card>
  );
}

/** Settings tab: the class's email settings and log, with a notice when the server can't send email yet. */
export function EmailSettingsSection({ classId }: { classId: number }) {
  const status = useEmailStatus();
  return (
    <>
      <EmailNotConfiguredAlert status={status.data} />
      <NotificationSettingsCard classId={classId} />
      <EmailLogCard classId={classId} />
    </>
  );
}
