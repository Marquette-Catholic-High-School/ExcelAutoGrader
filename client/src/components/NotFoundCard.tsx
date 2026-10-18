import type { ReactNode } from 'react';
import { Button, Card, EmptyState } from '@mantine/core';
import { Link } from 'react-router';
import { ApiRequestError } from '../api/client';

/** 404 (gone) or 403 (not yours / no longer enrolled): show a "not found" state instead of a retry button. */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 404 || err.status === 403);
}

/** Full-width "this doesn't exist" state for unknown or inaccessible classes and assignments. */
export function NotFoundCard({
  title,
  description,
  icon,
  home,
  homeLabel = 'Back to dashboard',
}: {
  title: string;
  description: ReactNode;
  icon: ReactNode;
  home: string;
  homeLabel?: string;
}) {
  return (
    <Card py={48}>
      <EmptyState variant="light" color="gray" size="lg" icon={icon} title={title} description={description}>
        <EmptyState.Actions>
          <Button component={Link} to={home}>
            {homeLabel}
          </Button>
        </EmptyState.Actions>
      </EmptyState>
    </Card>
  );
}
