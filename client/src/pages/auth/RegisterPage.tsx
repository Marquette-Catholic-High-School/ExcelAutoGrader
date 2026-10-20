import { useState } from 'react';
import { Alert, Anchor, Button, PasswordInput, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { hasLength, isEmail, useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconUserPlus } from '@tabler/icons-react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { Role } from '@shared/types';
import { ApiRequestError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, fieldErrors } from '../../utils/errors';
import { usePageTitle } from '../../utils/usePageTitle';
import { AuthCard, TeacherCreatedAccountNote } from './LoginPage';

interface RegisterValues {
  role: Role;
  name: string;
  email: string;
  password: string;
  /** Asked for only after the server says the email belongs to an invited student (join_code_required). */
  joinCode: string;
}

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'teacher', label: "I'm a teacher" },
  { value: 'student', label: "I'm a student" },
];

const ROLE_HINT: Record<Role, string> = {
  teacher: 'Create classes, post assignments with an answer key, and let the autograder check the work.',
  student: "Join your teacher's class with a 6-character code and get instant feedback on your workbooks.",
};

const CODE_HINT = "Your teacher added this email to a class. Enter the class's 6-character code to confirm it's you.";

/** Router state for links to /register, such as the login page's "Create your account" (kept out of the URL). */
export interface RegisterPrefill {
  email?: string;
}

function isRole(value: string | null): value is Role {
  return value === 'teacher' || value === 'student';
}

/** Welcome for a student whose teacher had already added their email to classes. */
function notifyClaimedClasses(name: string, classNames: string[]) {
  const firstName = name.split(/\s+/)[0] || name;
  const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(classNames);
  notifications.show({
    color: 'teal',
    title: `Welcome, ${firstName}!`,
    message: `You're already in ${list}. Your classes and assignments are ready.`,
    autoClose: 10_000,
  });
}

export function RegisterPage() {
  const { register } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [askCode, setAskCode] = useState(false);
  // Prefilled from links such as the login page's "Create your account" (?role=student, email in router state).
  const [params] = useSearchParams();
  const roleParam = params.get('role');
  const prefill = (useLocation().state ?? {}) as RegisterPrefill;
  usePageTitle('Create an account');

  const form = useForm<RegisterValues>({
    initialValues: {
      role: isRole(roleParam) ? roleParam : 'teacher',
      name: '',
      email: typeof prefill.email === 'string' ? prefill.email.trim() : '',
      password: '',
      joinCode: '',
    },
    validate: {
      name: (value) => {
        const name = value.trim();
        if (!name) return 'Enter your name';
        return name.length > 100 ? 'Use 100 characters or fewer' : null;
      },
      email: isEmail('Enter a valid email address'),
      password: hasLength({ min: 8 }, 'Use at least 8 characters'),
    },
  });

  async function handleSubmit(values: RegisterValues) {
    setError(null);
    try {
      // The guest-only route guard sees the new user and redirects to their dashboard.
      const { user, claimedClasses } = await register({
        ...values,
        name: values.name.trim(),
        email: values.email.trim(),
        joinCode: values.joinCode.trim() || undefined,
      });
      if (claimedClasses.length > 0) notifyClaimedClasses(user.name, claimedClasses);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'join_code_required') setAskCode(true);
      const fields = fieldErrors(err);
      if (Object.keys(fields).length > 0) form.setErrors(fields);
      else setError(errorMessage(err));
    }
  }

  const role = form.values.role;

  return (
    <AuthCard
      title="Create your account"
      subtitle="Pick your role to get started. It only takes a minute."
      footer={
        <Stack gap="sm">
          <Text size="sm" ta="center">
            Already have an account?{' '}
            <Anchor component={Link} to="/login" fw={600}>
              Sign in
            </Anchor>
          </Text>
          <TeacherCreatedAccountNote page="register" />
        </Stack>
      }
    >
      <form onSubmit={form.onSubmit(handleSubmit)} noValidate>
        <Stack gap="md">
          {error && (
            <Alert color="red" variant="light" icon={<IconAlertCircle />} title="Could not create your account">
              {error}
            </Alert>
          )}
          <Stack gap={6}>
            <SegmentedControl<Role>
              fullWidth
              size="md"
              aria-label="Account type"
              data={ROLE_OPTIONS}
              value={role}
              onChange={(value) => form.setFieldValue('role', value)}
            />
            <Text size="xs" c="dimmed" ta="center" aria-live="polite">
              {ROLE_HINT[role]}
            </Text>
            {role === 'student' && (
              <Text size="xs" ta="center" fw={500}>
                Added by your teacher? Sign up with the same email (and your class code, if asked) and you'll be
                placed in your classes automatically.
              </Text>
            )}
          </Stack>
          <TextInput
            label="Full name"
            placeholder={role === 'teacher' ? 'Ms. Rivera' : 'Jordan Lee'}
            autoComplete="name"
            autoFocus
            required
            {...form.getInputProps('name')}
          />
          <TextInput
            label="Email"
            placeholder="you@school.edu"
            type="email"
            autoComplete="email"
            required
            {...form.getInputProps('email')}
          />
          {role === 'student' && askCode && (
            <TextInput
              label="Class code"
              description={CODE_HINT}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              // Mounts after the server asks for the code, so this moves the cursor to it.
              autoFocus
              required
              styles={{ input: { textTransform: 'uppercase', fontFamily: 'var(--mantine-font-family-monospace)' } }}
              {...form.getInputProps('joinCode')}
            />
          )}
          <PasswordInput
            label="Password"
            description="At least 8 characters"
            placeholder="Choose a password"
            autoComplete="new-password"
            required
            {...form.getInputProps('password')}
          />
          <Button type="submit" fullWidth size="md" loading={form.submitting} leftSection={<IconUserPlus size={18} />}>
            {role === 'teacher' ? 'Create teacher account' : 'Create student account'}
          </Button>
        </Stack>
      </form>
    </AuthCard>
  );
}
