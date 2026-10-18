import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <Center py={80}>
      <Stack align="center" gap="sm">
        <Title order={1}>404</Title>
        <Text c="dimmed">We couldn't find that page.</Text>
        <Button component={Link} to="/">
          Back to dashboard
        </Button>
      </Stack>
    </Center>
  );
}
