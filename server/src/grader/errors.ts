/** Thrown for unreadable/corrupt/password-protected files. `message` is shown to users verbatim. */
export class WorkbookReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookReadError';
  }
}

export const MESSAGES = {
  unreadable: 'This file could not be opened as a spreadsheet. Save it as .xlsx and try again.',
  password:
    'This workbook is password-protected. Remove the password in Excel (File > Info > Protect Workbook), ' +
    'save it, and upload it again.',
  empty: 'This file is empty. Save your workbook as .xlsx and upload it again.',
  noSheets: 'This file does not contain any sheets. Save it as .xlsx and try again.',
  missing: 'This file is missing from the server. Upload it again.',
  tooLarge:
    'This workbook is too large to grade (it has more than 2,000,000 filled cells). Delete unused rows and ' +
    'columns, save it, and upload it again.',
  wrongFormat(ext: string): string {
    return (
      `This file is not a valid ${ext} workbook (it may have been renamed from another format). ` +
      'Open it in Excel, save it as .xlsx, and try again.'
    );
  },
};
