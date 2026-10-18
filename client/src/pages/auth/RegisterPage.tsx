import { useState } from 'react';
import { Alert, Anchor, Button, PasswordInput, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { hasLength, isEmail, useForm } from '@mantine/form';
import { IconAlertCircle, IconUserPlus } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { Role } from '@shared/types';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, fieldErrors } from '../../utils/errors';
import { usePageTitle } from '../../utils/usePageTitle';
import { AuthCard, TeacherCreatedAccountNote } from './LoginPage';

interface RegisterValues {
  role: Role;
  name: string;
  email: string;
  password: string;
}

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'teacher', label: "I'm a teacher" },
  { value: 'student', label: "I'm a student" },
];

const ROLE_HINT: Record<Role, string> = {
  teacher: 'Create classes, post assignments with an answer key, and let the autograder check the work.',
  student: "Join your teacher's class with a 6-character code and get instant feedback on your workbooks.",
};

export function RegisterPage() {
  const { register } = useAuth();
  const [error, setError] = useState<string | null>(null);
  usePageTitle('Create an account');

  const form = useForm<RegisterValues>({
    initialValues: { role: 'teacher', name: '', email: '', password: '' },
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
      await register({ ...values, name: values.name.trim(), email: values.email.trim() });
    } catch (err) {
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
          <TeacherCreatedAccountNote />
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
