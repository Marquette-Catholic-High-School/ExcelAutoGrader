import { useEffect } from 'react';

const APP_TITLE = 'Excel Autograder';

/** Sets the browser tab title while the page is mounted and restores the app title afterwards. */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_TITLE}` : APP_TITLE;
  }, [title]);
  useEffect(
    () => () => {
      document.title = APP_TITLE;
    },
    [],
  );
}
