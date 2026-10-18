/** A positive integer route param such as ":classId", or null for anything else ("abc", "0", missing). */
export function parseId(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
