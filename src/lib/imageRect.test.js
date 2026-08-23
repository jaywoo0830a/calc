// ============================================================
// imageRect 테스트 — 이미지 주석이 PDF 페이지 안에 들어오도록
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitImageRect } from './imageRect.js';

const approx = (a, b, tol = 1e-9, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || ''} |a−b| = ${Math.abs(a - b)} (a=${a}, b=${b})`);

const PAGE = 842 / 595; // 세로 A4-ish 페이지: pageAspect = h/w

test('fitImageRect: 안에 있으면 x/y/w는 그대로, h는 aspect로 재계산', () => {
  const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.2 };
  const out = fitImageRect(r, 1.5, PAGE);
  approx(out.x, 0.2, 1e-9);
  approx(out.y, 0.2, 1e-9);
  approx(out.w, 0.4, 1e-9);
  approx(out.h, 0.4 / (1.5 * PAGE), 1e-9);
});

test('fitImageRect: 세로로 긴 이미지는 높이가 페이지를 넘지 않게 폭을 줄인다', () => {
  // aspect 0.5 (세로 사진) — 페이지 aspect 1.415
  const maxW = 0.5 * PAGE;
  const out = fitImageRect({ x: 0, y: 0, w: 0.9, h: 0.5 }, 0.5, PAGE);
  approx(out.w, maxW, 1e-9);
  approx(out.h, 1, 1e-9); // 높이가 정확히 페이지 높이
});

test('fitImageRect: x/y가 음수이거나 끝을 넘으면 클램프', () => {
  const out = fitImageRect({ x: -0.2, y: -0.3, w: 0.4, h: 0.2 }, 1.5, PAGE);
  approx(out.x, 0, 1e-9);
  approx(out.y, 0, 1e-9);

  const out2 = fitImageRect({ x: 0.9, y: 0.95, w: 0.4, h: 0.2 }, 1.5, PAGE);
  approx(out2.x, 1 - out2.w, 1e-9);
  approx(out2.y, 1 - out2.h, 1e-9);
});

test('fitImageRect: w가 0보다 작아지지 않는다 (최소 0.12)', () => {
  const out = fitImageRect({ x: 0, y: 0, w: 0.01, h: 0.1 }, 1.5, PAGE);
  assert.ok(out.w >= 0.12);
});

test('fitImageRect: 누락된 rect에도 기본값으로 동작', () => {
  const out = fitImageRect(undefined, 1.5, PAGE);
  assert.ok(out.w > 0 && out.h > 0);
  assert.ok(out.x >= 0 && out.y >= 0);
});
