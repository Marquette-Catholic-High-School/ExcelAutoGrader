import { useState, type ReactNode } from 'react';
import { Alert, Anchor, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { isEmail, isNotEmpty, useForm } from '@mantine/form';
import { IconAlertCircle, IconLogin, IconMailForward, IconUserPlus } from '@tabler/icons-react';
import { Link } from 'react-router';
import { ApiRequestError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { BrandMark } from '../../components/AppLayout';
import { errorMessage, fieldErrors } from '../../utils/errors';
import { usePageTitle } from '../../utils/usePageTitle';
import type { RegisterPrefill } from './RegisterPage';

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

/** Reminder for students whose teacher added them by email or gave them a temporary password (under both cards). */
export function TeacherCreatedAccountNote({ page }: { page: 'login' | 'register' }) {
  return (
    <Text size="xs" c="dimmed" ta="center" px="md">
      {page === 'login'
        ? 'Students: if your teacher added you by email, choose “Create an account” and sign up with that email. ' +
          'Got a temporary password from your teacher? Sign in with it here.'
        : 'Students: got a temporary password from your teacher? Sign in with it instead of creating an account.'}
    </Text>
  );
}

/** Login with an email a teacher added that has no account yet: point the student to sign-up with that email. */
function NeedsSignupAlert({ email }: { email: string }) {
  // The email travels in router state, not the URL, so it stays out of the browser history.
  const signupState: RegisterPrefill = { email };
  return (
    <Alert color="grape" variant="light" icon={<IconMailForward />} title="Create your account first">
      <Stack gap="sm" align="flex-start">
        <Text size="sm">
          Your teacher added <b>{email}</b> to a class, but there's no account for it yet. Sign up with this email and
          you'll be placed in your classes automatically.
        </Text>
        <Button
          component={Link}
          to="/register?role=student"
          state={signupState}
          size="sm"
          leftSection={<IconUserPlus size={16} />}
        >
          Create your account
        </Button>
      </Stack>
    </Alert>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [signupEmail, setSignupEmail] = useState<string | null>(null);
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
    setSignupEmail(null);
    const email = values.email.trim();
    try {
      // The guest-only route guard sees the new user and redirects (to the page the user wanted, if any).
      await login({ email, password: values.password });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'needs_signup') {
        setSignupEmail(email);
        return;
      }
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
          <TeacherCreatedAccountNote page="login" />
        </Stack>
      }
    >
      <form onSubmit={form.onSubmit(handleSubmit)} noValidate>
        <Stack gap="md">
          {signupEmail && <NeedsSignupAlert email={signupEmail} />}
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
