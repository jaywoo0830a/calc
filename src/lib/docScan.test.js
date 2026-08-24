// docScan 순수 함수 테스트 — 꼭짓점 정렬 + 워프 타깃 크기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderCorners, sizeForQuad } from './docScan.js';

test('orderCorners: 이미 정렬된 순서 유지', () => {
  const pts = [[10, 20], [200, 20], [200, 150], [10, 150]];
  assert.deepEqual(orderCorners(pts), pts);
});

test('orderCorners: 뒤섞인 순서를 TL/TR/BR/BL로 정렬', () => {
  const pts = [[200, 150], [10, 20], [10, 150], [200, 20]];
  assert.deepEqual(orderCorners(pts), [[10, 20], [200, 20], [200, 150], [10, 150]]);
});

test('orderCorners: 기울어진 사다리꼴도 정렬', () => {
  // 시계방향 아님 — 임의 순서
  const pts = [[180, 130], [40, 170], [160, 40], [20, 50]];
  const out = orderCorners(pts);
  // TL = x+y 최소 (20,50)=70
  assert.deepEqual(out[0], [20, 50]);
  // BR = x+y 최대 (180,130)=310
  assert.deepEqual(out[2], [180, 130]);
});

test('sizeForQuad: 정사각형은 maxDim으로 축소', () => {
  const { w, h } = sizeForQuad([[0, 0], [800, 0], [800, 800], [0, 800]], 1600);
  assert.equal(w, 800);
  assert.equal(h, 800);
});

test('sizeForQuad: 큰 사각형은 maxDim 이하로, 비율 유지', () => {
  const { w, h } = sizeForQuad([[0, 0], [4000, 0], [4000, 3000], [0, 3000]], 1600);
  assert.equal(w, 1600);
  assert.equal(h, 1200);
});

test('sizeForQuad: 평행사변형은 평균 변 길이 사용', () => {
  const { w, h } = sizeForQuad([[0, 0], [600, 0], [700, 400], [100, 400]], 1600);
  assert.equal(w, 600);
  assert.equal(h, Math.round(Math.hypot(100, 400))); // 412
});
