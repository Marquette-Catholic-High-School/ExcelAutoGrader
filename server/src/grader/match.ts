/**
 * Pairs each answer-key sheet with a sheet of another workbook (a submission or the template):
 * 1. exact name, 2. same name ignoring case and surrounding spaces, 3. same position — only when the sheet at
 * that position was not already paired with another key sheet, 4. optionally (`fallbackInOrder`), the first sheet
 * still unpaired, in order. Anything left over has no match.
 */

export type SheetMatchMethod = 'exact' | 'name' | 'position';

export interface SheetMatch {
  keyIndex: number;
  /** Index into the other workbook's sheets, or null when nothing matched. */
  otherIndex: number | null;
  method: SheetMatchMethod | null;
}

export interface MatchOptions {
  /** Pair each key sheet still unmatched after the position pass with the first unpaired other sheet ('position'). */
  fallbackInOrder?: boolean;
}

export function matchSheets(
  keyNames: readonly string[],
  otherNames: readonly string[],
  options: MatchOptions = {},
): SheetMatch[] {
  const matches: SheetMatch[] = keyNames.map((_, keyIndex) => ({ keyIndex, otherIndex: null, method: null }));
  const taken = new Set<number>();

  const pass = (method: SheetMatchMethod, same: (key: string, other: string) => boolean) => {
    for (const match of matches) {
      if (match.otherIndex !== null) continue;
      const index = otherNames.findIndex((name, i) => !taken.has(i) && same(keyNames[match.keyIndex], name));
      if (index < 0) continue;
      taken.add(index);
      match.otherIndex = index;
      match.method = method;
    }
  };

  pass('exact', (a, b) => a === b);
  pass('name', (a, b) => sheetKey(a) === sheetKey(b));
  for (const match of matches) {
    const index = match.keyIndex;
    if (match.otherIndex !== null || index >= otherNames.length || taken.has(index)) continue;
    taken.add(index);
    match.otherIndex = index;
    match.method = 'position';
  }
  if (options.fallbackInOrder) {
    for (const match of matches) {
      if (match.otherIndex !== null) continue;
      const index = otherNames.findIndex((_, i) => !taken.has(i));
      if (index < 0) break;
      taken.add(index);
      match.otherIndex = index;
      match.method = 'position';
    }
  }
  return matches;
}

/** Comparison key for sheet names (Excel treats them case-insensitively). */
export function sheetKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** Index of the sheet called `name` (exact, then case-insensitive), or -1. */
export function findSheetByName(names: readonly string[], name: string): number {
  const exact = names.indexOf(name);
  if (exact >= 0) return exact;
  const key = sheetKey(name);
  return names.findIndex((candidate) => sheetKey(candidate) === key);
}
