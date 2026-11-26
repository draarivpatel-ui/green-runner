import test from 'node:test';
import assert from 'node:assert/strict';

async function loadModule(rel) {
  const ns = await import(new URL(rel, import.meta.url));
  return ns.default ?? ns;
}

const M = await loadModule('../carbon-lab.js');

function cellValue(s) {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s;
}

test('batch6 csv escaping neutralizes hidden formula prefixes', () => {
  const fn = M.csvEscape;
  for (const hostile of ['=1', ' =1', '\u200b=1', '\ufeff=1', '\u00a0=1', '\t=1', '\t123', '\r=1', '+cmd', '@SUM(1)', '  -42x']) {
    assert.equal(cellValue(fn(hostile)).startsWith("'"), true, JSON.stringify(hostile));
  }
  assert.equal(fn('\r=1').startsWith('"') && fn('\r=1').endsWith('"'), true, 'carriage return cell stays quoted');
  assert.equal(fn('-42'), '-42');
  assert.equal(cellValue(fn('  -42')).startsWith("'"), true);
});

test('batch6 digest copies keep prototype keys as digestible data', () => {
  const clean = { a: 1, digest: { value: 'x' }, integritySha256: 'x' };
  const hostile = JSON.parse('{"a":1,"__proto__":{"polluted":true},"constructor":{"x":2},"prototype":{"y":3}}');
  hostile.digest = { value: 'x' };
  hostile.integritySha256 = 'x';
  assert.notEqual(M.verifyStampedReport(hostile).actual, M.verifyStampedReport(clean).actual);
  assert.equal({}.polluted, undefined);
});

test('batch6 trace preview truncation is code point safe', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.equal(source.includes('Array.from(JSON.stringify(t.output)).slice(0, 360)'), true);
});
