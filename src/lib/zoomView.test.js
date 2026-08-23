// ============================================================
// zoomView 테스트 — 전체화면 라이트박스 줌/팬 계산 (순수 로직)
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampScale, zoomAt, clampPan, toggleZoom } from './zoomView.js';

const VIEW = { w: 1000, h: 800 };
const IMG = { w: 500, h: 400 };
const BIG = { w: 800, h: 600 }; // 2배에서 가로·세로 모두 오버플로 (1600/1200)

test('clampScale: 1~8 범위로 클램프, NaN/Infinity는 1', () => {
  assert.equal(clampScale(0.3), 1);
  assert.equal(clampScale(99), 8);
  assert.equal(clampScale(2.5), 2.5);
  assert.equal(clampScale(NaN), 1);
});

test('zoomAt: 커서 아래 이미지 점이 그대로 유지된다 (anchor 불변)', () => {
  const out = zoomAt({ scale: 1, x: 0, y: 0 }, 2, { x: 600, y: 500 }, VIEW, BIG);
  // rel = (600-500)/1=100 → x = 600-500-100*2 = -100
  // relY = (500-400)/1=100 → y = 500-400-100*2 = -100
  assert.deepEqual(out, { scale: 2, x: -100, y: -100 });
});

test('zoomAt: 최대 배율을 넘지 않는다', () => {
  const out = zoomAt({ scale: 6, x: 0, y: 0 }, 3, { x: 500, y: 400 }, VIEW, IMG);
  assert.equal(out.scale, 8);
});

test('clampPan: 이미지가 화면보다 작으면 항상 중앙 (팬 0)', () => {
  assert.deepEqual(clampPan(500, -300, 1, VIEW, IMG), { x: 0, y: 0 });
});

test('clampPan: 가로로만 넘치는 이미지는 y 팬이 0으로 고정', () => {
  const wide = { w: 1200, h: 400 };
  assert.deepEqual(clampPan(500, -50, 1, VIEW, wide), { x: 100, y: 0 });
});

test('clampPan: 확대 시 화면 가장자리보다 더 당길 수 없다', () => {
  // scale 8: dispW 4000 → mx=(4000-1000)/2=1500, dispH 3200 → my=1200
  assert.deepEqual(clampPan(2000, -2000, 8, VIEW, IMG), { x: 1500, y: -1200 });
});

test('toggleZoom: 1→2, 확대 상태→1 (fit)', () => {
  assert.equal(toggleZoom(1), 2);
  assert.equal(toggleZoom(2), 1);
  assert.equal(toggleZoom(4.5), 1);
});
