import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  displayFormula,
  engineFormula,
  generatedArrayCells,
  mapAreaReferences,
  maskStringLiterals,
  normalizeFormula,
  volatileFunctions,
  type AreaReference,
} from './formula.js';

describe('formula helpers', () => {
  test('displayFormula strips "=" and internal prefixes', () => {
    assert.equal(displayFormula('=SUM(A1:A3)'), 'SUM(A1:A3)');
    assert.equal(displayFormula('_xlfn.XLOOKUP(A2,B:B,C:C)'), 'XLOOKUP(A2,B:B,C:C)');
    assert.equal(displayFormula('_xlfn._xlws.SORT(A1:A9)'), 'SORT(A1:A9)');
  });

  test('normalizeFormula ignores case, spaces and $ outside string literals', () => {
    assert.equal(normalizeFormula('=sum( $B$2 : b4 )'), normalizeFormula('SUM(B2:B4)'));
    assert.equal(normalizeFormula("'My Sheet'!a1*2"), "'MY SHEET'!A1*2");
    assert.equal(normalizeFormula('A1&" x $ "'), 'A1&" x $ "');
    assert.notEqual(normalizeFormula('A1&"Yes"'), normalizeFormula('A1&"yes"'));
    assert.notEqual(normalizeFormula('B1*2'), normalizeFormula('B1*3'));
  });

  test('engineFormula adapts Excel syntax for HyperFormula', () => {
    assert.equal(engineFormula('IF(A1>3,TRUE,false)'), '=IF(A1>3,TRUE(),FALSE())');
    assert.equal(engineFormula('AND(TRUE(),B1)'), '=AND(TRUE(),B1)');
    assert.equal(engineFormula('"TRUE"&A1'), '="TRUE"&A1');
    assert.equal(engineFormula("'TRUE'!A1+TRUE!B2"), "='TRUE'!A1+TRUE!B2");
    assert.equal(engineFormula('_xlfn.CONCAT(A1:A3,"-",B1)'), '=TEXTJOIN("",FALSE(),A1:A3,"-",B1)');
    assert.equal(engineFormula('CONCATENATE(A1,B1)'), '=CONCATENATE(A1,B1)');
    assert.equal(engineFormula('TRUE_RATE*2'), '=TRUE_RATE*2');
    assert.equal(engineFormula('STDEV.S($A$1:$A$9)'), '=STDEV.S($A$1:$A$9)');
  });

  test('maskStringLiterals blanks literals but keeps quoted sheet names and the length', () => {
    assert.equal(maskStringLiterals('A1&"x""y"&B1'), 'A1&"    "&B1');
    assert.equal(maskStringLiterals("'Bob''s'!A1&\"\""), "'Bob''s'!A1&\"\"");
    assert.equal(maskStringLiterals('"open'), '"   "');
  });

  test('volatileFunctions', () => {
    assert.deepEqual(volatileFunctions('TODAY()-A1'), ['TODAY']);
    assert.deepEqual(volatileFunctions('=rand() * now() + RAND ()'), ['RAND', 'NOW']);
    assert.deepEqual(volatileFunctions('_xlfn.RANDARRAY(3)+RANDBETWEEN(1,6)'), ['RANDARRAY', 'RANDBETWEEN']);
    assert.deepEqual(volatileFunctions('"TODAY()"&A1'), []);
    assert.deepEqual(volatileFunctions('OFFSET(A1,1,0)+INDIRECT("B2")+KNOW(1)+TODAY_RATE'), []);
  });
});

describe('mapAreaReferences', () => {
  const seen = (formula: string) => {
    const refs: AreaReference[] = [];
    mapAreaReferences(formula, (ref) => {
      refs.push(ref);
      return null;
    });
    return refs.map((ref) => [ref.sheet, ref.start.r, ref.start.c, ref.end.r, ref.end.c]);
  };
  const toA1 = (formula: string) => mapAreaReferences(formula, (ref) => ({ start: ref.start, end: { r: 9, c: 1 } }));

  test('finds cell, column and row areas with and without sheet prefixes', () => {
    assert.deepEqual(seen('=SUM(A1:B2)+$C$3:$D$4'), [
      [null, 0, 0, 1, 1],
      [null, 2, 2, 3, 3],
    ]);
    assert.deepEqual(seen('=SUM(A:C)+SUM($2:$5)'), [
      [null, 0, 0, 1_048_575, 2],
      [null, 1, 0, 4, 16_383],
    ]);
    assert.deepEqual(seen("=Data!B2:B9+'My Sheet'!A:A+'Bob''s'!1:1"), [
      ['Data', 1, 1, 8, 1],
      ['My Sheet', 0, 0, 1_048_575, 0],
      ["Bob's", 0, 0, 0, 16_383],
    ]);
    assert.deepEqual(seen('=SUM(B9:A1)'), [[null, 0, 0, 8, 1]]);
  });

  test('ignores string literals, single cells, names and functions', () => {
    assert.deepEqual(seen('="A1:B2"&TEXT(A1,"h:mm")&LOG10(A1)&A1&Rate&ATAN2(1,2)'), []);
    assert.deepEqual(seen('=A1:B'), []);
  });

  test('rewrites references as absolute areas and keeps everything else', () => {
    assert.equal(toA1('=SUM(A:A)+"A:A"&B1'), '=SUM($A$1:$B$10)+"A:A"&B1');
    assert.equal(toA1("=SUM('My Sheet'!A3:XFD1048576)"), "=SUM('My Sheet'!$A$3:$B$10)");
    assert.equal(mapAreaReferences('=A1:B2*2', () => null), '=A1:B2*2');
  });
});

test('generatedArrayCells counts arrays built from literal sizes', () => {
  assert.equal(generatedArrayCells('=SEQUENCE(1048576,16384)'), 1_048_576 * 16_384);
  assert.equal(generatedArrayCells('=SUM(SEQUENCE(10))+MUNIT(3)'), 10 + 9);
  assert.equal(generatedArrayCells('=SUM(OFFSET(A1,0,0,1000,20))+OFFSET(B2,1,1)'), 20_000 + 1);
  assert.equal(generatedArrayCells('=SEQUENCE(A1,B1)&"SEQUENCE(99999,99999)"'), 1);
  assert.equal(generatedArrayCells('=SUM(A1:A9)'), 0);
});
