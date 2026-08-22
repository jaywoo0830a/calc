// ============================================================
// canvasMath 테스트 — 세계(y↑) → 화면(y↓) 변환
// 오늘의 버그: 힘/프로브/장선 화살표가 수직으로 반전되던 원인
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenAngle, screenOffset, screenVector } from './canvasMath.js';

const PI = Math.PI;
const approx = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} (a=${a}, b=${b})`);

test('screenAngle: 세계 각도의 부호 반전', () => {
  approx(screenAngle(PI / 2), -PI / 2);
  approx(screenAngle(-PI / 4), PI / 4);
  approx(screenAngle(0), 0);
});

test('screenOffset: 세계 위쪽은 화면 위쪽으로', () => {
  const up = screenOffset(PI / 2, 10);
  approx(up.dx, 0, 1e-9);
  approx(up.dy, -10, 1e-9, '세계 y↑ → 화면 dy<0 (위)');
});

test('screenOffset: 세계 아래쪽은 화면 아래쪽으로', () => {
  const down = screenOffset(-PI / 2, 10);
  approx(down.dy, 10, 1e-9, '세계 y↓ → 화면 dy>0 (아래)');
});

test('screenOffset: 수평 방향은 그대로', () => {
  const right = screenOffset(0, 5);
  approx(right.dx, 5);
  approx(right.dy, 0);
  const left = screenOffset(PI, 5);
  approx(left.dx, -5);
  approx(left.dy, 0);
});

test('screenVector: y 성분만 반전', () => {
  const v = screenVector(3, 4);
  assert.deepEqual(v, { x: 3, y: -4 });
});

test('종단 검증: 세로 쌍극자(+위, −아래)의 −전하 힘 화살표가 화면에서 위를 향함', () => {
  // 힘(세계): −전하는 위(+쪽)로 → fy > 0, fx = 0 → ang = atan2(fy, fx) = π/2
  // 화면 각도: screenAngle(π/2) = −π/2 → 화면에서 위 = 음의 y 방향
  const fy = 1 / 9; // k·1·1/3²
  const worldAng = Math.atan2(fy, 0); // +π/2
  const off = screenOffset(worldAng, 30);
  assert.ok(off.dy < 0, '화면 오프셋이 위(음의 dy) — 전하를 향함');
  approx(off.dx, 0, 1e-6);
});
