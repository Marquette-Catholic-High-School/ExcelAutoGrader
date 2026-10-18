import { notifications } from '@mantine/notifications';
import { ApiRequestError } from '../api/client';

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError || err instanceof Error) return err.message;
  return 'Something went wrong.';
}

/** Field errors from a 400 response, for `form.setErrors(fieldErrors(err))`. */
export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiRequestError && err.fields ? err.fields : {};
}

export function notifyError(err: unknown, title = 'Something went wrong') {
  notifications.show({ color: 'red', title, message: errorMessage(err) });
}

export function notifySuccess(message: string, title?: string) {
  notifications.show({ color: 'teal', title, message });
}
