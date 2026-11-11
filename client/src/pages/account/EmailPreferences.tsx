import { Button, Card, Divider, Group, Stack, Switch, Text, Title } from '@mantine/core';
import { TimeInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import {
  IconAlertCircle,
  IconCircleCheck,
  IconClock,
  IconDeviceFloppy,
  IconMail,
  IconReportAnalytics,
  IconSend,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { EmailStatus, MyNotificationSettings, TestEmailResponse } from '@shared/types';
import { endpoints, qk } from '../../api/endpoints';
import { useUser } from '../../auth/AuthContext';
import { EmailNotConfiguredAlert, senderLabel, useEmailStatus } from '../../components/EmailStatus';
import { QueryState } from '../../components/QueryState';
import { errorMessage, fieldErrors, notifyError, notifySuccess } from '../../utils/errors';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

type DailyReportValues = Pick<MyNotificationSettings, 'dailyReport' | 'dailyReportTime' | 'skipEmptyReports'>;

function toDailyReportValues(s: MyNotificationSettings): DailyReportValues {
  return { dailyReport: s.dailyReport, dailyReportTime: s.dailyReportTime, skipEmptyReports: s.skipEmptyReports };
}

/** "07:00" → "7:00 AM" in the viewer's locale. */
function formatClockTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function useMyNotifications() {
  return useQuery({ queryKey: qk.myNotifications, queryFn: endpoints.getMyNotifications });
}

function DailyReportForm({ settings, status }: { settings: MyNotificationSettings; status: EmailStatus | undefined }) {
  const qc = useQueryClient();
  const form = useForm<DailyReportValues>({
    initialValues: toDailyReportValues(settings),
    validate: {
      dailyReportTime: (value, values) =>
        !values.dailyReport || TIME_PATTERN.test(value) ? null : 'Pick a time, like 07:00',
    },
  });

  const save = useMutation({
    mutationFn: (values: DailyReportValues) =>
      // While the report is off, an unfinished time is left as it was.
      endpoints.updateMyNotifications(
        TIME_PATTERN.test(values.dailyReportTime)
          ? values
          : { dailyReport: values.dailyReport, skipEmptyReports: values.skipEmptyReports },
      ),
    onSuccess: (updated) => {
      qc.setQueryData(qk.myNotifications, updated);
      const values = toDailyReportValues(updated);
      form.setInitialValues(values);
      form.setValues(values);
      form.resetDirty(values);
      notifySuccess(
        updated.dailyReport
          ? `Your daily report goes out at ${formatClockTime(updated.dailyReportTime)}.`
          : 'Daily report turned off.',
      );
    },
    onError: (err) => {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length > 0) form.setErrors(fields);
      else notifyError(err, 'Could not save your email settings');
    },
  });

  const on = form.values.dailyReport;
  const zone = status?.timeZone;

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))} noValidate>
      <Stack gap="md">
        <Switch
          label="Email me a daily report"
          description="New submissions in each of your classes, work waiting for grading, assignments due in the next week and who is still missing overdue work."
          {...form.getInputProps('dailyReport', { type: 'checkbox' })}
        />
        <TimeInput
          label="Send it at"
          description={zone ? `Time zone: ${zone} (set on the server)` : "In the server's time zone"}
          leftSection={<IconClock size={16} />}
          disabled={!on}
          maw={220}
          {...form.getInputProps('dailyReportTime')}
        />
        <Switch
          label="Skip days with nothing new"
          description="No email on days without new submissions."
          disabled={!on}
          {...form.getInputProps('skipEmptyReports', { type: 'checkbox' })}
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

/** "… sent to <address>" or the server's error, under the send buttons. */
function SendResult({
  what,
  mutation,
}: {
  /** "The test email" */
  what: string;
  mutation: UseMutationResult<TestEmailResponse, Error, void>;
}) {
  if (mutation.isSuccess) {
    return (
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconCircleCheck size={16} color="var(--mantine-color-teal-text)" style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="sm" c="teal" style={{ wordBreak: 'break-word' }}>
          {what} was sent to {mutation.data.to}. It can take a minute to arrive; check your spam folder if you don't
          see it.
        </Text>
      </Group>
    );
  }
  if (mutation.isError) {
    return (
      <Group gap={6} wrap="nowrap" align="flex-start" role="alert">
        <IconAlertCircle size={16} color="var(--mantine-color-red-text)" style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="sm" c="red" style={{ wordBreak: 'break-word' }}>
          {what} wasn't sent: {errorMessage(mutation.error)}
        </Text>
      </Group>
    );
  }
  return null;
}

function SendNowSection({ status }: { status: EmailStatus | undefined }) {
  const user = useUser();
  const test = useMutation<TestEmailResponse, Error, void>({ mutationFn: () => endpoints.sendTestEmail() });
  const report = useMutation<TestEmailResponse, Error, void>({ mutationFn: () => endpoints.sendDailyReportNow() });
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Emails come from {status ? senderLabel(status) : 'this server'} and go to {user.email}. Sending today's report
        now doesn't change the scheduled one.
      </Text>
      <Group gap="sm" wrap="wrap">
        <Button
          variant="default"
          leftSection={<IconSend size={18} />}
          loading={test.isPending}
          onClick={() => test.mutate()}
        >
          Send me a test email
        </Button>
        <Button
          variant="default"
          leftSection={<IconReportAnalytics size={18} />}
          loading={report.isPending}
          onClick={() => report.mutate()}
        >
          Send today's report now
        </Button>
      </Group>
      <SendResult what="The test email" mutation={test} />
      <SendResult what="Today's report" mutation={report} />
    </Stack>
  );
}

function TeacherEmailCard() {
  const query = useMyNotifications();
  const status = useEmailStatus().data;
  return (
    <Stack gap="lg">
      <EmailNotConfiguredAlert status={status} />
      <Card>
        <Group gap="sm" mb="xs">
          <IconMail size={20} color="var(--mantine-color-dimmed)" />
          <Title order={3} fz="h4">
            Daily report
          </Title>
        </Group>
        <Text size="sm" c="dimmed" mb="md">
          A summary of what happened in your classes, once a day. Which emails students get is set per class on its
          Settings tab.
        </Text>
        <QueryState query={query} loadingLabel="Loading email settings…">
          {(settings) => <DailyReportForm settings={settings} status={status} />}
        </QueryState>
        <Divider my="lg" />
        <SendNowSection status={status} />
      </Card>
    </Stack>
  );
}

function StudentEmailSwitch({ settings }: { settings: MyNotificationSettings }) {
  const user = useUser();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (emailOptOut: boolean) => endpoints.updateMyNotifications({ emailOptOut }),
    onSuccess: (updated) => {
      qc.setQueryData(qk.myNotifications, updated);
      notifySuccess(
        updated.emailOptOut
          ? "You won't get emails about your assignments anymore."
          : "You'll get emails about your assignments again.",
      );
    },
    onError: (err) => notifyError(err, 'Could not save your email settings'),
  });
  // Show the new position while it saves.
  const optedOut = save.isPending ? save.variables : settings.emailOptOut;
  const description =
    'A receipt each time work is turned in for you, and a reminder when an assignment is overdue, sent to ' +
    `${user.email}. Your teacher chooses which of these each class sends.`;
  return (
    <Switch
      label="Email me about my assignments"
      description={description}
      checked={!optedOut}
      disabled={save.isPending}
      onChange={(e) => save.mutate(!e.currentTarget.checked)}
    />
  );
}

function StudentEmailCard() {
  const query = useMyNotifications();
  return (
    <Card>
      <Group gap="sm" mb="md">
        <IconMail size={20} color="var(--mantine-color-dimmed)" />
        <Title order={3} fz="h4">
          Email
        </Title>
      </Group>
      <QueryState query={query} loadingLabel="Loading email settings…">
        {(settings) => <StudentEmailSwitch settings={settings} />}
      </QueryState>
    </Card>
  );
}

/** Account page: the daily report for teachers, the assignment-email switch for students. */
export function EmailPreferences() {
  const user = useUser();
  return user.role === 'teacher' ? <TeacherEmailCard /> : <StudentEmailCard />;
}
