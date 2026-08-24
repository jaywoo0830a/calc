// pinchView 테스트 — 두 손가락 핀치(거리 비율) + 중점 이동
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPan, pinchView, zoomAt } from './zoomView.js';

const VIEW = { w: 1000, h: 800 };
const BIG = { w: 800, h: 600 };

test('pinchView: 앵커 기준 줌과 중점 이동을 함께 적용한다', () => {
  const base = zoomAt({ scale: 1, x: 0, y: 0 }, 2, { x: 600, y: 500 }, VIEW, BIG);
  const out = pinchView({ scale: 1, x: 0, y: 0 }, 2, { x: 600, y: 500 }, { dx: 30, dy: -20 }, VIEW, BIG);
  assert.equal(out.scale, 2);
  assert.deepEqual({ x: out.x, y: out.y }, clampPan(base.x + 30, base.y - 20, 2, VIEW, BIG));
});

test('pinchView: 축소는 fit(1배) 밑으로 내려가지 않는다', () => {
  const out = pinchView({ scale: 2, x: -100, y: -100 }, 0.2, { x: 500, y: 400 }, { dx: 0, dy: 0 }, VIEW, BIG);
  assert.equal(out.scale, 1);
  assert.deepEqual({ x: out.x, y: out.y }, { x: 0, y: 0 });
});

test('pinchView: 최대 배율 8을 넘지 않는다', () => {
  const out = pinchView({ scale: 4, x: 0, y: 0 }, 5, { x: 500, y: 400 }, { dx: 0, dy: 0 }, VIEW, BIG);
  assert.equal(out.scale, 8);
});
