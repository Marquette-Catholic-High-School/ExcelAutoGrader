import dayjs from 'dayjs';

/** The string format @mantine/dates pickers use for values (local time). */
export const PICKER_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/** How due dates are shown inside the picker input. */
export const DUE_DISPLAY_FORMAT = 'ddd, MMM D, YYYY h:mm A';

/** Local day `days` from today at 11:59 PM, as a picker value. */
export function endOfDayIn(days: number): string {
  return dayjs().add(days, 'day').hour(23).minute(59).second(0).format(PICKER_FORMAT);
}

export function defaultDueDate(): string {
  return endOfDayIn(7);
}

export function isoToPicker(iso: string): string {
  return dayjs(iso).format(PICKER_FORMAT);
}

export function pickerToIso(value: string): string {
  return dayjs(value).toISOString();
}

export function isValidPickerValue(value: string | null | undefined): value is string {
  return !!value && dayjs(value).isValid();
}
