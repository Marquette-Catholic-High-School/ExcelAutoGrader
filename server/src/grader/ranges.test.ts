import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { columnIndex, columnLetters, encodeAddress, parseRange, rangeContains } from './ranges.js';

describe('parseRange', () => {
  test('single cells and ranges without a sheet', () => {
    assert.deepEqual(parseRange('B2'), { text: 'B2', sheet: null, start: { r: 1, c: 1 }, end: { r: 1, c: 1 } });
    assert.deepEqual(parseRange(' b2:d10 '), { text: 'b2:d10', sheet: null, start: { r: 1, c: 1 }, end: { r: 9, c: 3 } });
  });

  test('absolute references and reversed corners', () => {
    assert.deepEqual(parseRange('$D$10:$B$2')?.start, { r: 1, c: 1 });
    assert.deepEqual(parseRange('$D$10:$B$2')?.end, { r: 9, c: 3 });
    assert.deepEqual(parseRange('B$2:$C3')?.end, { r: 2, c: 2 });
  });

  test('sheet prefixes', () => {
    assert.equal(parseRange('Sheet1!B2:B10')?.sheet, 'Sheet1');
    assert.equal(parseRange("'My Sheet'!F5")?.sheet, 'My Sheet');
    assert.equal(parseRange("'Bob''s Budget'!A1")?.sheet, "Bob's Budget");
    assert.equal(parseRange("'Q1!Totals'!A1")?.sheet, 'Q1!Totals');
    assert.equal(parseRange('My Sheet!A1')?.sheet, 'My Sheet');
    assert.equal(parseRange('totals!a1')?.sheet, 'totals');
  });

  test('rejects malformed references', () => {
    for (const bad of [
      '',
      'Sheet1!ZZZ',
      'ZZZ',
      'A0',
      'A1048577',
      'XFE1',
      'B:B',
      '2:2',
      'A1:B2:C3',
      'Sheet1!',
      '!A1',
      "'Unclosed!A1",
      "'Bad'Quote'!A1",
      'Sheet[1]!A1',
      'A1 B2',
      'R1C1',
    ]) {
      assert.equal(parseRange(bad), null, bad);
    }
  });

  test('accepts the largest cell', () => {
    assert.deepEqual(parseRange('XFD1048576')?.start, { r: 1048575, c: 16383 });
  });
});

describe('helpers', () => {
  test('column letters round-trip', () => {
    for (const [c, letters] of [
      [0, 'A'],
      [25, 'Z'],
      [26, 'AA'],
      [99, 'CV'],
      [701, 'ZZ'],
      [702, 'AAA'],
      [16383, 'XFD'],
    ] as const) {
      assert.equal(columnLetters(c), letters);
      assert.equal(columnIndex(letters), c);
    }
    assert.equal(columnIndex('XFE'), -1);
    assert.equal(encodeAddress(6, 2), 'C7');
  });

  test('rangeContains', () => {
    const range = parseRange('B2:C3')!;
    assert.equal(rangeContains(range, 1, 1), true);
    assert.equal(rangeContains(range, 2, 2), true);
    assert.equal(rangeContains(range, 0, 1), false);
    assert.equal(rangeContains(range, 1, 3), false);
  });
});
