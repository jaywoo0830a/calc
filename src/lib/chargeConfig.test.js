// ============================================================
// chargeConfig 테스트 — Arrange 패널 파싱/직렬화
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargesToLines, parseChargeLines, MAX_Q, POS_LIMIT } from './chargeConfig.js';

test('parse: 기본 형식 + q 생략 시 +1', () => {
  const cs = parseChargeLines('-1.5, 0, 1\n1.5, 0, -1\n2, 3');
  assert.equal(cs.length, 3);
  assert.deepEqual(
    { x: cs[0].x, y: cs[0].y, q: cs[0].q },
    { x: -1.5, y: 0, q: 1 },
  );
  assert.equal(cs[2].q, 1, 'q 생략 → +1');
});

test('parse: 공백/탭 구분 허용, 부동소수 q 허용', () => {
  const cs = parseChargeLines('0\t0\t2\n1.5 1.5 -0.5');
  assert.equal(cs[0].q, 2);
  assert.equal(cs[1].q, -0.5);
});

test('parse: 오류 케이스들', () => {
  assert.throws(() => parseChargeLines(''), /at least one line/);
  assert.throws(() => parseChargeLines('0, 0, 0'), /non-zero/);
  assert.throws(() => parseChargeLines(`0, 0, ${MAX_Q + 1}`), /≤/);
  assert.throws(() => parseChargeLines(`${POS_LIMIT + 1}, 0, 1`), /within/);
  assert.throws(() => parseChargeLines('abc, 0, 1'), /invalid number/);
  assert.throws(() => parseChargeLines('1, 2, 3, 4'), /expected/);
  const tooMany = Array.from({ length: 13 }, (_, i) => `${i}, 0, 1`).join('\n');
  assert.throws(() => parseChargeLines(tooMany), /Max/);
});

test('round-trip: chargesToLines → parseChargeLines 동일', () => {
  const cs = [
    { id: 'a', x: -1.5, y: 0, q: 1 },
    { id: 'b', x: 1.5, y: 0.2, q: -1 },
    { id: 'c', x: 0.333, y: -2, q: 2 },
  ];
  const back = parseChargeLines(chargesToLines(cs));
  assert.equal(back.length, cs.length);
  back.forEach((c, i) => {
    assert.ok(Math.abs(c.x - cs[i].x) < 0.005, 'x round-trip');
    assert.ok(Math.abs(c.y - cs[i].y) < 0.005, 'y round-trip');
    assert.equal(c.q, cs[i].q);
  });
});
