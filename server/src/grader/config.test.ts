import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_GRADING_CONFIG } from '../../../shared/types.js';
import { normalizeGradingConfig } from './index.js';

describe('normalizeGradingConfig', () => {
  test('defaults for missing input', () => {
    for (const input of [undefined, null, '', '   ', {}, '{}']) {
      assert.deepEqual(normalizeGradingConfig(input), DEFAULT_GRADING_CONFIG);
    }
  });

  test('returns a fresh copy (defaults are never mutated)', () => {
    const config = normalizeGradingConfig(undefined);
    config.ranges.push('A1');
    assert.deepEqual(DEFAULT_GRADING_CONFIG.ranges, []);
    assert.notEqual(normalizeGradingConfig({}).ranges, DEFAULT_GRADING_CONFIG.ranges);
  });

  test('accepts a JSON string, fills defaults and drops unknown keys', () => {
    const config = normalizeGradingConfig(JSON.stringify({ scope: 'formulas', caseSensitive: true, bogus: 1 }));
    assert.deepEqual(config, { ...DEFAULT_GRADING_CONFIG, scope: 'formulas', caseSensitive: true });
    assert.equal('bogus' in config, false);
  });

  test('null values fall back to defaults', () => {
    assert.equal(normalizeGradingConfig({ numericTolerance: null, requireFormulas: null }).numericTolerance, 0.01);
  });

  test('rejects garbage', () => {
    assert.throws(() => normalizeGradingConfig('{not json'), /could not be read/);
    assert.throws(() => normalizeGradingConfig('[1,2]'), /could not be read/);
    assert.throws(() => normalizeGradingConfig(42), /could not be read/);
  });

  test('scope', () => {
    assert.equal(normalizeGradingConfig({ scope: 'all' }).scope, 'all');
    assert.throws(() => normalizeGradingConfig({ scope: 'everything' }), /Choose which cells to grade/);
    assert.throws(() => normalizeGradingConfig({ scope: 3 }), /Choose which cells to grade/);
  });

  test('numeric tolerance', () => {
    assert.equal(normalizeGradingConfig({ numericTolerance: 0 }).numericTolerance, 0);
    assert.equal(normalizeGradingConfig({ numericTolerance: 1e9 }).numericTolerance, 1e9);
    assert.equal(normalizeGradingConfig({ numericTolerance: '0.5' }).numericTolerance, 0.5);
    for (const bad of [-0.01, 1e9 + 1, Number.NaN, Infinity, 'abc', '', true, [1]]) {
      assert.throws(() => normalizeGradingConfig({ numericTolerance: bad }), /Numeric tolerance/, String(bad));
    }
  });

  test('booleans', () => {
    const config = normalizeGradingConfig({ ignoreWhitespace: false, showExpectedToStudents: 'true' });
    assert.equal(config.ignoreWhitespace, false);
    assert.equal(config.showExpectedToStudents, true);
    assert.throws(() => normalizeGradingConfig({ requireFormulas: 'yes' }), /"Require formulas" setting must be on or off/);
    assert.throws(() => normalizeGradingConfig({ excludeTemplateCells: 1 }), /must be on or off/);
  });

  test('ranges are trimmed, de-duplicated and validated', () => {
    const config = normalizeGradingConfig({ scope: 'ranges', ranges: [' B2:B10 ', '', 'B2:B10', "'My Sheet'!$C$3", 'sheet1!a1'] });
    assert.deepEqual(config.ranges, ['B2:B10', "'My Sheet'!$C$3", 'sheet1!a1']);
    assert.deepEqual(normalizeGradingConfig({ ranges: 'A1, B2:C3;D4' }).ranges, ['A1', 'B2:C3', 'D4']);
    assert.throws(() => normalizeGradingConfig({ ranges: ['Sheet1!ZZZ'] }), /^Error: Invalid range "Sheet1!ZZZ"/);
    assert.throws(() => normalizeGradingConfig({ ranges: [5] }), /list of cell ranges/);
    assert.throws(() => normalizeGradingConfig({ ranges: { a: 1 } }), /list of cell ranges/);
    const many = Array.from({ length: 101 }, (_, i) => `A${i + 1}`);
    assert.throws(() => normalizeGradingConfig({ ranges: many }), /up to 100 ranges/);
    assert.equal(normalizeGradingConfig({ ranges: many.slice(0, 100) }).ranges.length, 100);
  });

  test('ranges scope needs at least one range', () => {
    assert.throws(
      () => normalizeGradingConfig({ scope: 'ranges', ranges: [' '] }),
      { message: 'Add at least one cell range to grade, e.g. Sheet1!B2:B10.' },
    );
    // Ranges are kept (and validated) for other scopes so the form can switch back.
    assert.deepEqual(normalizeGradingConfig({ scope: 'all', ranges: ['A1'] }).ranges, ['A1']);
  });
});
