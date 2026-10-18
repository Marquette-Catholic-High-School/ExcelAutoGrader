import { useState, type ReactNode } from 'react';
import { Alert, Anchor, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { isEmail, isNotEmpty, useForm } from '@mantine/form';
import { IconAlertCircle, IconLogin } from '@tabler/icons-react';
import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { BrandMark } from '../../components/AppLayout';
import { errorMessage, fieldErrors } from '../../utils/errors';
import { usePageTitle } from '../../utils/usePageTitle';

/** Centered, branded card shared by the sign-in and sign-up pages. */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Center mih="100vh" px="md" py="xl">
      <Stack w="100%" maw={440} gap="lg">
        <Stack align="center" gap={8}>
          <BrandMark size={52} />
          <Text fw={700} size="xl">
            Excel Autograder
          </Text>
        </Stack>
        <Paper withBorder shadow="sm" p={{ base: 'lg', xs: 'xl' }}>
          <Title order={2} ta="center" fz="h3">
            {title}
          </Title>
          <Text c="dimmed" size="sm" ta="center" mt={4} mb="lg">
            {subtitle}
          </Text>
          {children}
        </Paper>
        {footer}
      </Stack>
    </Center>
  );
}

/** One-line reminder that teachers can create student accounts, shown under both auth cards. */
export function TeacherCreatedAccountNote() {
  return (
    <Text size="xs" c="dimmed" ta="center" px="md">
      Students: your teacher may have already created an account for you. Sign in with your school email and the
      temporary password they gave you.
    </Text>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  usePageTitle('Sign in');

  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { email: '', password: '' },
    validate: {
      email: isEmail('Enter a valid email address'),
      password: isNotEmpty('Enter your password'),
    },
  });

  async function handleSubmit(values: { email: string; password: string }) {
    setError(null);
    try {
      // The guest-only route guard sees the new user and redirects (to the page the user wanted, if any).
      await login({ email: values.email.trim(), password: values.password });
    } catch (err) {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length > 0) form.setErrors(fields);
      else setError(errorMessage(err));
    }
  }

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to see your classes and assignments."
      footer={
        <Stack gap="sm">
          <Text size="sm" ta="center">
            New here?{' '}
            <Anchor component={Link} to="/register" fw={600}>
              Create an account
            </Anchor>
          </Text>
          <TeacherCreatedAccountNote />
        </Stack>
      }
    >
      <form onSubmit={form.onSubmit(handleSubmit)} noValidate>
        <Stack gap="md">
          {error && (
            <Alert color="red" variant="light" icon={<IconAlertCircle />} title="Could not sign in">
              {error}
            </Alert>
          )}
          <TextInput
            label="Email"
            placeholder="you@school.edu"
            type="email"
            autoComplete="email"
            autoFocus
            required
            key={form.key('email')}
            {...form.getInputProps('email')}
          />
          <PasswordInput
            label="Password"
            placeholder="Your password"
            autoComplete="current-password"
            required
            key={form.key('password')}
            {...form.getInputProps('password')}
          />
          <Button type="submit" fullWidth size="md" loading={form.submitting} leftSection={<IconLogin size={18} />}>
            Sign in
          </Button>
        </Stack>
      </form>
    </AuthCard>
  );
}
