import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  compareCell,
  effectiveTolerance,
  isBlank,
  isHardCodedFormula,
  normalizeText,
  numbersEqual,
  parseBooleanText,
  parseNumericText,
  valuesEqual,
  type CompareOptions,
} from './compare.js';

const opts: CompareOptions = { numericTolerance: 0.01, caseSensitive: false, ignoreWhitespace: true, requireFormulas: true };

describe('numbersEqual', () => {
  test('within the absolute tolerance, inclusive', () => {
    assert.equal(numbersEqual(1, 1.01, 0.01), true);
    assert.equal(numbersEqual(1.01, 1, 0.01), true);
    assert.equal(numbersEqual(100, 100.004, 0.01), true);
    assert.equal(numbersEqual(1, 1.02, 0.01), false);
    assert.equal(numbersEqual(-5, 5, 0.01), false);
  });

  test('ignores floating-point noise even with zero tolerance', () => {
    assert.equal(numbersEqual(0.1 + 0.2, 0.3, 0), true);
    assert.equal(numbersEqual(1e12 + 0.0001, 1e12, 0), true);
    assert.equal(numbersEqual(0.3, 0.31, 0), false);
    const sum = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].reduce((a, b) => a + b, 0);
    assert.equal(numbersEqual(sum, 2.8, 0), true);
  });

  test('zero tolerance still tells real differences in large numbers apart', () => {
    assert.equal(numbersEqual(5551234567, 5551234570, 0), false);
    assert.equal(numbersEqual(1e9, 1e9 + 0.9, 0), false);
  });

  test('non-finite numbers only equal themselves', () => {
    assert.equal(numbersEqual(Number.NaN, Number.NaN, 1), false);
    assert.equal(numbersEqual(Infinity, 5, 1e9), false);
  });
});

describe('parseNumericText', () => {
  const cases: [string, number | null][] = [
    [' 42 ', 42],
    ['1,234.50', 1234.5],
    ['1234.5', 1234.5],
    ['$12', 12],
    ['-$5.25', -5.25],
    ['$-5.25', -5.25],
    ['€3,000', 3000],
    ['12 £', 12],
    ['25%', 0.25],
    ['-12.5 %', -0.125],
    ['(1,200)', -1200],
    ['($7.50)', -7.5],
    ['+8', 8],
    ['−3', -3],
    ['.5', 0.5],
    ['1.5e3', 1500],
    ['1,2', null],
    ['12,34.5', null],
    ['abc', null],
    ['', null],
    ['   ', null],
    ['$', null],
    ['%', null],
    ['--5', null],
    ['$5$', null],
    ['10/16/2026', null],
    ['TRUE', null],
  ];
  for (const [text, expected] of cases) {
    test(JSON.stringify(text), () => assert.equal(parseNumericText(text), expected));
  }
});

describe('parseBooleanText / isBlank / normalizeText', () => {
  test('booleans', () => {
    assert.equal(parseBooleanText(' true '), true);
    assert.equal(parseBooleanText('FALSE'), false);
    assert.equal(parseBooleanText('yes'), null);
  });

  test('blank values', () => {
    assert.equal(isBlank(null), true);
    assert.equal(isBlank(undefined), true);
    assert.equal(isBlank(''), true);
    assert.equal(isBlank(' \t '), true);
    assert.equal(isBlank(0), false);
    assert.equal(isBlank(false), false);
  });

  test('text normalization', () => {
    assert.equal(normalizeText('  Total   Income ', opts), 'total income');
    assert.equal(normalizeText(' A  b ', { caseSensitive: true, ignoreWhitespace: false }), ' A  b ');
    assert.equal(normalizeText('Café', opts), normalizeText('Café', opts));
  });
});

describe('valuesEqual', () => {
  const eq = (expected: unknown, actual: unknown, o: Partial<CompareOptions> = {}) =>
    valuesEqual({ value: expected as never }, { value: actual as never }, { ...opts, ...o });

  test('numbers and numeric text', () => {
    assert.equal(eq(1234.5, '1,234.50'), true);
    assert.equal(eq(12, '$12'), true);
    assert.equal(eq(0.25, '25%'), true);
    assert.equal(eq(42, ' 42 '), true);
    assert.equal(eq('42', 42), true);
    assert.equal(eq(42, 'forty-two'), false);
    assert.equal(eq(1, true), false);
  });

  test('dates compare as serial numbers', () => {
    assert.equal(eq(46311, 46311), true);
    assert.equal(eq(46311, 46312), false);
  });

  test('the tolerance follows the key cell\'s display units', () => {
    const percent = (value: number) => ({ value, unit: 'percent' as const });
    const time = (value: number) => ({ value, unit: 'time' as const });
    // 0.01 means 0.01 percentage points for percentages: 12.9% vs 13.5% differs, 12.931% vs 12.935% does not.
    assert.equal(valuesEqual(percent(0.1293), { value: 0.1354 }, opts), false);
    assert.equal(valuesEqual(percent(0.12931), { value: 0.12935 }, opts), true);
    assert.equal(valuesEqual(percent(0.25), { value: '25%' }, opts), true);
    // At most one second for times: 8:30 vs 8:20 differs; half a second does not.
    const eightThirty = 8.5 / 24;
    assert.equal(valuesEqual(time(eightThirty), { value: 8 / 24 + 20 / 1440 }, opts), false);
    assert.equal(valuesEqual(time(eightThirty), { value: eightThirty + 0.5 / 86_400 }, opts), true);
    assert.equal(valuesEqual(time(eightThirty), { value: eightThirty + 2 / 86_400 }, opts), false);
    // Plain numbers and currency use the tolerance as is.
    assert.equal(eq(3770, 3770.004), true);
    assert.equal(eq(3770, 3770.02), false);
    // The units of the key cell count, not the student's.
    assert.equal(valuesEqual({ value: 0.1293 }, percent(0.1354), opts), true);
  });

  test('effectiveTolerance', () => {
    assert.equal(effectiveTolerance(0.01, undefined), 0.01);
    assert.equal(effectiveTolerance(0.01, 'percent'), 0.0001);
    assert.equal(effectiveTolerance(0.01, 'time'), 1 / 86_400);
    assert.equal(effectiveTolerance(0, 'time'), 0);
    assert.equal(effectiveTolerance(1e-6, 'time'), 1e-6);
  });

  test('booleans and TRUE/FALSE text', () => {
    assert.equal(eq(true, true), true);
    assert.equal(eq(true, 'TRUE'), true);
    assert.equal(eq(false, ' false '), true);
    assert.equal(eq('TRUE', true), true);
    assert.equal(eq(true, false), false);
    assert.equal(eq(true, 1), false);
  });

  test('text honors ignoreWhitespace and caseSensitive', () => {
    assert.equal(eq('Total Income', '  total   income '), true);
    assert.equal(eq('Total Income', 'total income', { caseSensitive: true }), false);
    assert.equal(eq('Total Income', 'Total  Income', { ignoreWhitespace: false }), false);
    assert.equal(eq('Total Income', 'Total Income', { ignoreWhitespace: false, caseSensitive: true }), true);
    assert.equal(eq('Rent', 'Rents'), false);
  });

  test('errors compare by their text', () => {
    const e = (value: string) => ({ value, isError: true });
    assert.equal(valuesEqual(e('#DIV/0!'), e('#DIV/0!'), opts), true);
    assert.equal(valuesEqual(e('#DIV/0!'), e('#N/A'), opts), false);
    assert.equal(valuesEqual(e('#N/A'), { value: '#n/a' }, opts), true);
    assert.equal(valuesEqual(e('#DIV/0!'), { value: 0 }, opts), false);
    assert.equal(valuesEqual({ value: 5 }, e('#VALUE!'), opts), false);
  });

  test('blank only equals blank', () => {
    assert.equal(eq('', null), true);
    assert.equal(eq('', 0), false);
    assert.equal(eq(0, null), false);
  });
});

describe('compareCell', () => {
  test('correct value with a formula', () => {
    assert.deepEqual(compareCell({ value: 10, formula: 'SUM(A1:A2)' }, { value: 10, formula: 'A1+A2' }, opts), {
      correct: true,
    });
  });

  test('empty student cell', () => {
    assert.deepEqual(compareCell({ value: 10 }, undefined, opts), { correct: false, reason: 'empty' });
    assert.deepEqual(compareCell({ value: 'x' }, { value: '   ' }, opts), { correct: false, reason: 'empty' });
    assert.deepEqual(compareCell({ value: 10, formula: 'A1' }, undefined, opts), { correct: false, reason: 'empty' });
  });

  test('value mismatch', () => {
    assert.deepEqual(compareCell({ value: 10 }, { value: 11 }, opts), { correct: false, reason: 'value_mismatch' });
    // A student formula that produces nothing is a wrong value, not an empty cell.
    assert.deepEqual(compareCell({ value: 10, formula: 'A1' }, { value: '', formula: 'B1' }, opts), {
      correct: false,
      reason: 'value_mismatch',
    });
  });

  test('hard-coded answer where the key has a formula', () => {
    assert.deepEqual(compareCell({ value: 10, formula: 'A1+A2' }, { value: 10 }, opts), {
      correct: false,
      reason: 'formula_required',
    });
    assert.deepEqual(compareCell({ value: 10, formula: 'A1+A2' }, { value: 10 }, { ...opts, requireFormulas: false }), {
      correct: true,
    });
    // A wrong hard-coded value is reported as a mismatch first.
    assert.deepEqual(compareCell({ value: 10, formula: 'A1+A2' }, { value: 9 }, opts), {
      correct: false,
      reason: 'value_mismatch',
    });
  });

  test('key constants do not require formulas', () => {
    assert.deepEqual(compareCell({ value: 'Rent' }, { value: 'rent', formula: 'LOWER("RENT")' }, opts), { correct: true });
  });

  test('constant-only formulas count as hard-coded', () => {
    const key = { value: 2693.25, formula: 'SUM(C10:C15)' };
    for (const formula of ['2693.25', '=3200+520-1026.75', '(2693.25)', '"2693.25"*1']) {
      assert.deepEqual(compareCell(key, { value: 2693.25, formula }, opts), { correct: false, reason: 'formula_required' }, formula);
    }
    assert.deepEqual(compareCell(key, { value: 2693.25, formula: '2693.25' }, { ...opts, requireFormulas: false }), {
      correct: true,
    });
    // Still a wrong value first.
    assert.deepEqual(compareCell(key, { value: 2000, formula: '2000' }, opts), { correct: false, reason: 'value_mismatch' });
    // No formula requirement when the key's own formula is constant-only.
    assert.deepEqual(compareCell({ value: 3720, formula: '3200+520' }, { value: 3720 }, opts), { correct: true });
  });

  test('formulas with references, names or functions are real formulas', () => {
    const key = { value: 10, formula: 'B2*2' };
    for (const formula of ['SUM(B2:B4)', 'B2*1.1', 'Totals!B2', "'My Sheet'!B2", 'TaxRate*B2', 'PI()*2', 'Table1[Total]']) {
      assert.deepEqual(compareCell(key, { value: 10, formula }, opts), { correct: true }, formula);
    }
  });

  test('isHardCodedFormula', () => {
    assert.equal(isHardCodedFormula('=2693.25'), true);
    assert.equal(isHardCodedFormula('3200+520'), true);
    assert.equal(isHardCodedFormula('1.5E+3*-2%'), true);
    assert.equal(isHardCodedFormula('"Total: "&"5"'), true);
    assert.equal(isHardCodedFormula('TRUE'), true);
    assert.equal(isHardCodedFormula('E5*2'), false);
    assert.equal(isHardCodedFormula('"A1"&B1'), false);
    assert.equal(isHardCodedFormula('TRUE_RATE*2'), false);
    assert.equal(isHardCodedFormula('$B$2'), false);
  });

  test('volatile key formulas are checked by formula, not by their saved result', () => {
    const key = { value: 10, formula: 'TODAY()-A1' };
    assert.deepEqual(compareCell(key, { value: 13, formula: 'TODAY()-A1' }, opts), { correct: true });
    assert.deepEqual(compareCell(key, { value: 13, formula: 'today() - $A$1' }, opts), { correct: true });
    assert.deepEqual(compareCell(key, { value: 10 }, opts), { correct: false, reason: 'formula_required' });
    assert.deepEqual(compareCell(key, { value: 10 }, { ...opts, requireFormulas: false }), {
      correct: false,
      reason: 'formula_required',
    });
    assert.deepEqual(compareCell(key, { value: 13, formula: 'A1+3' }, opts), { correct: false, reason: 'value_mismatch' });
    assert.deepEqual(compareCell(key, undefined, opts), { correct: false, reason: 'empty' });
    // Every volatile function of the key must be used; text in quotes does not count.
    const both = { value: 0.5, formula: 'RAND()*NOW()' };
    assert.deepEqual(compareCell(both, { value: 0.7, formula: 'NOW()*RAND()' }, opts), { correct: true });
    assert.deepEqual(compareCell(both, { value: 0.7, formula: 'RAND()&"NOW()"' }, opts), {
      correct: false,
      reason: 'value_mismatch',
    });
  });

  test('key formula that evaluates to an empty string', () => {
    const key = { value: '', formula: 'IF(A1>0,"Over","")' };
    assert.deepEqual(compareCell(key, { value: '', formula: 'IF(A1>0,"Over","")' }, opts), { correct: true });
    assert.deepEqual(compareCell(key, undefined, { ...opts, requireFormulas: false }), { correct: true });
    assert.deepEqual(compareCell(key, undefined, opts), { correct: false, reason: 'empty' });
    assert.deepEqual(compareCell(key, { value: 'Over', formula: 'B1' }, opts), { correct: false, reason: 'value_mismatch' });
  });

  test('error results', () => {
    const key = { value: '#DIV/0!', isError: true, formula: 'A1/0' };
    assert.deepEqual(compareCell(key, { value: '#DIV/0!', isError: true, formula: 'B1/0' }, opts), { correct: true });
    assert.deepEqual(compareCell(key, { value: 0, formula: 'B1' }, opts), { correct: false, reason: 'value_mismatch' });
  });
});
