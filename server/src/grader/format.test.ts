import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatUnit, hasDatePart, numberFormat } from './format.js';

test('formatUnit: percentages and times', () => {
  const cases: [string, ReturnType<typeof formatUnit>][] = [
    ['0.0%', 'percent'],
    ['0%', 'percent'],
    ['[Red]0.00%;-0.00%', 'percent'],
    ['0.0"%"', undefined],
    ['0.0\\%', undefined],
    ['h:mm', 'time'],
    ['h:mm AM/PM', 'time'],
    ['[h]:mm:ss', 'time'],
    ['mm:ss', 'time'],
    ['m/d/yyyy h:mm', 'time'],
    ['m/d/yyyy', undefined],
    ['[$-409]mmmm d, yyyy', undefined],
    ['[White]m/d/yyyy', undefined],
    ['"$"#,##0.00', undefined],
    ['#,##0.00 "hours"', undefined],
    ['0.00', undefined],
  ];
  for (const [format, unit] of cases) assert.equal(formatUnit(format), unit, format);
});

test('hasDatePart: calendar dates, not times of day or durations', () => {
  for (const format of ['m/d/yyyy', 'mmm-yy', 'mmmm', 'd-mmm', 'm/d/yyyy h:mm', '[$-409]dddd, mmmm d']) {
    assert.equal(hasDatePart(format), true, format);
  }
  for (const format of ['h:mm', '[h]:mm', 'mm:ss', 'h:mm AM/PM', '0.0%', '0.00', '"d"0']) {
    assert.equal(hasDatePart(format), false, format);
  }
});

test('numberFormat ignores General and missing formats', () => {
  assert.equal(numberFormat({ t: 'n', v: 1, z: 'General' }), undefined);
  assert.equal(numberFormat({ t: 'n', v: 1 }), undefined);
  assert.equal(numberFormat({ t: 'n', v: 1, z: '0%' }), '0%');
});
