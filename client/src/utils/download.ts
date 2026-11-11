import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import { notifyError } from './errors';

/**
 * Tracks one file download for a button's loading state; a failure shows an error notification.
 *   const pdf = useDownload(() => endpoints.downloadGradebookPdf(classId), 'Could not export the gradebook');
 *   <Button loading={pdf.pending} onClick={pdf.start}>Export PDF</Button>
 */
export function useDownload(download: () => Promise<void>, errorTitle: string) {
  const [pending, setPending] = useState(false);
  async function start() {
    setPending(true);
    try {
      await download();
    } catch (err) {
      notifyError(err, errorTitle);
    } finally {
      setPending(false);
    }
  }
  return { pending, start };
}

/**
 * For downloads started from a menu, which closes on click and so can't show a spinner: a loading notification
 * stays up while the server prepares the file, and turns into an error notification if it fails.
 */
export async function downloadWithProgress(
  message: string,
  download: () => Promise<void>,
  errorTitle: string,
): Promise<void> {
  const id = notifications.show({
    loading: true,
    title: 'Preparing PDF…',
    message,
    autoClose: false,
    allowClose: false,
  });
  try {
    await download();
  } catch (err) {
    notifyError(err, errorTitle);
  } finally {
    notifications.hide(id);
  }
}
