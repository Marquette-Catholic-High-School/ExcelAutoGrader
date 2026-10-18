import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  DataList,
  Grid,
  Group,
  PasswordInput,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { isNotEmpty, matchesField, useForm } from '@mantine/form';
import { IconKey, IconShieldLock } from '@tabler/icons-react';
import { useLocation, useNavigate } from 'react-router';
import { endpoints } from '../api/endpoints';
import { useAuth, useUser } from '../auth/AuthContext';
import { homeFor, safeFrom } from '../auth/redirect';
import { PageHeader } from '../components/PageHeader';
import { fieldErrors, notifyError, notifySuccess } from '../utils/errors';
import { formatDateTime } from '../utils/format';
import { usePageTitle } from '../utils/usePageTitle';

interface PasswordValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

function ChangePasswordCard() {
  const user = useUser();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const temporary = user.mustChangePassword;

  const form = useForm<PasswordValues>({
    mode: 'uncontrolled',
    initialValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    validate: {
      currentPassword: isNotEmpty(temporary ? 'Enter your temporary password' : 'Enter your current password'),
      newPassword: (value, values) => {
        if (value.length < 8) return 'Use at least 8 characters';
        return value === values.currentPassword ? 'Choose a password different from the current one' : null;
      },
      confirmPassword: matchesField('newPassword', 'Passwords do not match'),
    },
  });

  async function handleSubmit(values: PasswordValues) {
    try {
      const res = await endpoints.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      setUser(res.user);
      form.reset();
      notifySuccess('Use your new password the next time you sign in.', 'Password changed');
      // The route guard kept this user here; continue to the page they were trying to open.
      if (temporary) navigate(safeFrom(location.state, res.user) ?? homeFor(res.user.role), { replace: true });
    } catch (err) {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length > 0) form.setErrors(fields);
      else notifyError(err, 'Could not change your password');
    }
  }

  return (
    <Card>
      <Group gap="sm" mb="xs">
        <IconKey size={20} color="var(--mantine-color-dimmed)" />
        <Title order={3} fz="h4">
          {temporary ? 'Choose your password' : 'Change password'}
        </Title>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        {temporary
          ? 'Enter the temporary password from your teacher, then pick a new one only you know.'
          : "Pick a strong password you don't use on any other site."}
      </Text>
      <form onSubmit={form.onSubmit(handleSubmit)} noValidate>
        <Stack gap="md">
          <PasswordInput
            label={temporary ? 'Temporary password' : 'Current password'}
            autoComplete="current-password"
            required
            key={form.key('currentPassword')}
            {...form.getInputProps('currentPassword')}
          />
          <PasswordInput
            label="New password"
            description="At least 8 characters"
            autoComplete="new-password"
            required
            key={form.key('newPassword')}
            {...form.getInputProps('newPassword')}
          />
          <PasswordInput
            label="Confirm new password"
            autoComplete="new-password"
            required
            key={form.key('confirmPassword')}
            {...form.getInputProps('confirmPassword')}
          />
          <Group justify="flex-end">
            <Button type="submit" loading={form.submitting} leftSection={<IconShieldLock size={18} />}>
              {temporary ? 'Save my password' : 'Update password'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

function ProfileCard() {
  const user = useUser();
  return (
    <Card>
      <Group gap="md" mb="lg" wrap="nowrap">
        <Avatar name={user.name} color="initials" radius="xl" size={56} />
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text fw={650} size="lg" truncate>
            {user.name}
          </Text>
          <Badge variant="light" tt="capitalize" w="fit-content">
            {user.role}
          </Badge>
        </Stack>
      </Group>
      <DataList orientation="vertical" gap="md">
        <DataList.Item>
          <DataList.ItemLabel>Email</DataList.ItemLabel>
          <DataList.ItemValue style={{ wordBreak: 'break-all' }}>{user.email}</DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel>Member since</DataList.ItemLabel>
          <DataList.ItemValue>{formatDateTime(user.createdAt)}</DataList.ItemValue>
        </DataList.Item>
      </DataList>
    </Card>
  );
}

export function AccountPage() {
  const user = useUser();
  usePageTitle('Account');
  return (
    <>
      <PageHeader
        title="Account"
        subtitle="Your profile and sign-in details."
        crumbs={[{ label: 'Dashboard', to: homeFor(user.role) }, { label: 'Account' }]}
      />
      {user.mustChangePassword && (
        <Alert color="yellow" icon={<IconKey />} title="You are using a temporary password" mb="lg" maw={960}>
          Your teacher set up this account for you. Choose your own password below to finish setting it up; the rest
          of the app opens as soon as it is saved.
        </Alert>
      )}
      <Grid maw={960} gap="lg">
        <Grid.Col span={{ base: 12, md: 5 }} order={{ base: 2, md: 1 }}>
          <ProfileCard />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }} order={{ base: 1, md: 2 }}>
          <ChangePasswordCard />
        </Grid.Col>
      </Grid>
    </>
  );
}
