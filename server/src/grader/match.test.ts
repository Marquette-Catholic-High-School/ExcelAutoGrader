import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findSheetByName, matchSheets } from './match.js';

const pairs = (key: string[], other: string[], fallbackInOrder = false) =>
  matchSheets(key, other, { fallbackInOrder }).map((m) => [m.otherIndex === null ? null : other[m.otherIndex], m.method]);

describe('matchSheets', () => {
  test('exact names win, regardless of order', () => {
    assert.deepEqual(pairs(['Budget', 'Totals'], ['Totals', 'Budget']), [
      ['Budget', 'exact'],
      ['Totals', 'exact'],
    ]);
  });

  test('case-insensitive, trimmed names', () => {
    assert.deepEqual(pairs(['Budget'], [' budget ']), [[' budget ', 'name']]);
  });

  test('positional fallback', () => {
    assert.deepEqual(pairs(['Budget'], ['Sheet1']), [['Sheet1', 'position']]);
    assert.deepEqual(pairs(['Budget', 'Totals'], ['Sheet1', 'Sheet2']), [
      ['Sheet1', 'position'],
      ['Sheet2', 'position'],
    ]);
  });

  test('no positional match onto a sheet that matched another key sheet by name', () => {
    // "Totals" is at index 0 in the submission and is taken by the key's "Totals" sheet.
    assert.deepEqual(pairs(['Budget', 'Totals'], ['Totals']), [
      [null, null],
      ['Totals', 'exact'],
    ]);
  });

  test('missing sheets', () => {
    assert.deepEqual(pairs(['Budget', 'Totals'], ['Budget']), [
      ['Budget', 'exact'],
      [null, null],
    ]);
  });

  test('optional fallback: unmatched key sheets take the first unpaired sheet, in order', () => {
    assert.deepEqual(pairs(['Budget', 'Totals'], ['Totals'], true), [
      [null, null],
      ['Totals', 'exact'],
    ]);
    assert.deepEqual(pairs(['Budget', 'Totals'], ['Totals', 'Notes'], true), [
      ['Notes', 'position'],
      ['Totals', 'exact'],
    ]);
    assert.deepEqual(pairs(['Summary', 'Budget'], ['Budget', 'Mine', 'Extra'], true), [
      ['Mine', 'position'],
      ['Budget', 'exact'],
    ]);
    // Without the option such sheets stay unmatched (template pairing).
    assert.deepEqual(pairs(['Budget', 'Totals'], ['Totals', 'Notes']), [
      [null, null],
      ['Totals', 'exact'],
    ]);
  });

  test('exact match is preferred over a case-insensitive one', () => {
    assert.deepEqual(pairs(['data', 'Data'], ['Data', 'data']), [
      ['data', 'exact'],
      ['Data', 'exact'],
    ]);
  });
});

test('findSheetByName', () => {
  assert.equal(findSheetByName(['Budget', 'budget'], 'budget'), 1);
  assert.equal(findSheetByName(['Budget'], 'BUDGET'), 0);
  assert.equal(findSheetByName(['Budget'], 'Totals'), -1);
});
