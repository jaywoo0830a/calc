// ============================================================
// electrostatics — 점전하 정전기학 계산 (SAT/AP 수준)
// E = kQ/r², V = kQ/r, F = kQ₁Q₂/r² — k = 1 (상대 단위)
// ============================================================

export const K = 1; // 상대 단위 (직관용)

/**
 * 평행판(이상적, 무한 크기) 장: 판 사이 E = ΔV/d로 일정, V 선형.
 * E = −dV/dx = v0/(2·plateX), V(−plateX)=v0, V(+plateX)=0.
 */
export function plateField(x, plateX = 2, v0 = 4) {
  if (Math.abs(x) <= plateX) {
    return { ex: v0 / (2 * plateX), ey: 0, v: (v0 / 2) * (1 - x / plateX) };
  }
  return { ex: 0, ey: 0, v: x < -plateX ? v0 : 0 };
}

/**
 * 전하가 내는 장선 수 — |q|에 비례 (플럭스 직관: 1q = 8선, 2q = 16선, …).
 */
export function fieldLineCount(q) {
  return Math.max(8, Math.round(8 * Math.abs(q)));
}

/**
 * id 전하가 다른 전하들로부터 받는 알짜힘. F = q·E (음전하는 E 반대 방향).
 * @returns {{ fx: number, fy: number, f: number }}
 */
export function forceOnCharge(charges, id) {
  const c = charges.find((ch) => ch.id === id);
  if (!c) return { fx: 0, fy: 0, f: 0 };
  const e = fieldAt(charges, c.x, c.y, id);
  const fx = c.q * e.ex;
  const fy = c.q * e.ey;
  return { fx, fy, f: Math.hypot(fx, fy) };
}

/**
 * 점전하들의 전기장/전위 계산.
 * skipId 전하는 제외 (자기 자신에 의한 힘 계산 시 사용).
 * minR > 0이면 전위 계산에서 거리를 minR로 하한 클램프 (특이점 제거).
 * @returns {{ ex: number, ey: number, v: number }}
 */
export function fieldAt(charges, x, y, skipId = null, minR = 0) {
  let ex = 0;
  let ey = 0;
  let v = 0;
  for (const c of charges) {
    if (c.id === skipId) continue;
    const dx = x - c.x;
    const dy = y - c.y;
    const r2 = dx * dx + dy * dy;
    if (r2 < 1e-12) {
      // 정확히 전하 위치: E는 정의 안 됨(0 취급), V는 클램프 반경으로
      if (minR > 0) v += (K * c.q) / minR;
      continue;
    }
    const r = Math.sqrt(r2);
    const kq = K * c.q;
    ex += (kq / r2) * (dx / r);
    ey += (kq / r2) * (dy / r);
    v += kq / Math.max(r, minR);
  }
  return { ex, ey, v };
}

/**
 * 장선(streamline) 추적 — RK2 적분.
 * dir = +1 (전하에서 나가는 방향) / -1 (들어가는 방향).
 * excludeId 전하는 시작점 근처에서 멈추지 않음(시드 전하),
 * 단 시작점으로 되돌아오면(장이 0인 점 통과 등) 정지.
 * @returns {Array<{x:number,y:number}>}
 */
export function traceFieldLine(charges, x0, y0, dir, opts = {}) {
  const {
    step = 0.08,
    maxSteps = 700,
    rStop = 0.24,
    bound = 6,
    minE = 1e-4,
    excludeId = null,
  } = opts;
  const pts = [];
  let x = x0;
  let y = y0;
  let traveled = 0;
  for (let i = 0; i < maxSteps; i++) {
    if (Math.abs(x) > bound || Math.abs(y) > bound) break;
    let hit = false;
    for (const c of charges) {
      const dx = x - c.x;
      const dy = y - c.y;
      const d2 = dx * dx + dy * dy;
      if (c.id === excludeId) {
        // 시드 전하로 되돌아온 경우 (중간에 E≈0 지점 통과) → 정지
        if (d2 < rStop * rStop * 0.5 && traveled > 1.2) { hit = true; break; }
      } else if (d2 < rStop * rStop) {
        hit = true;
        break;
      }
    }
    if (hit) break;
    const e1 = fieldAt(charges, x, y);
    const m1 = Math.hypot(e1.ex, e1.ey);
    if (m1 < minE) break;
    const ux = e1.ex / m1;
    const uy = e1.ey / m1;
    const e2 = fieldAt(charges, x + dir * ux * step * 0.5, y + dir * uy * step * 0.5);
    const m2 = Math.hypot(e2.ex, e2.ey);
    if (m2 < minE) break;
    const sx = dir * (e2.ex / m2) * step;
    const sy = dir * (e2.ey / m2) * step;
    x += sx;
    y += sy;
    traveled += Math.hypot(sx, sy);
    pts.push({ x, y });
  }
  return pts;
}

/**
 * (n+1)² 모서리 전위 그리드 (등전위선 marching squares용).
 * x, y 모두 [-bound, bound].
 */
export function potentialCorners(charges, n, bound) {
  const v = new Float32Array((n + 1) * (n + 1));
  const step = (2 * bound) / n;
  const minR = step * 0.3; // 전하 특이점 하한 클램프 — 전하 주변 가짜 고리 방지
  for (let j = 0; j <= n; j++) {
    // ⚠️ 행 j = y가 증가하는 순서 (contourSegments의 기하와 일치해야 함)
    // 이전엔 bound - j*step(위→아래)로 계산해 contourSegments와 y가 반전되어
    // 전하가 x축 위에 있으면 등전위선이 x축 아래에 그려지는 버그가 있었음
    const y = -bound + j * step;
    for (let i = 0; i <= n; i++) {
      const x = -bound + i * step;
      v[j * (n + 1) + i] = fieldAt(charges, x, y, null, minR).v;
    }
  }
  return { v, n, step, x0: -bound, y0: -bound };
}

// ── Marching squares 세그먼트 테이블 ─────────────────────────
// 모서리: 0=top, 1=right, 2=bottom, 3=left
// 코너 비트: TL=8, TR=4, BR=2, BL=1 (v >= level이면 inside)
const SEGS = [
  [],                        // 0
  [[2, 3]],                  // 1  BL
  [[1, 2]],                  // 2  BR
  [[1, 3]],                  // 3  BR+BL
  [[0, 1]],                  // 4  TR
  [[0, 1], [2, 3]],          // 5  TR+BL (ambiguous)
  [[0, 2]],                  // 6  TR+BR
  [[0, 3]],                  // 7  TR+BR+BL
  [[0, 3]],                  // 8  TL
  [[0, 2]],                  // 9  TL+BL
  [[0, 3], [1, 2]],          // 10 TL+BR (ambiguous)
  [[0, 1]],                  // 11 TL+BR+BL
  [[1, 3]],                  // 12 TL+TR
  [[1, 2]],                  // 13 TL+TR+BL
  [[2, 3]],                  // 14 TL+TR+BR
  [],                        // 15
];

/**
 * level 등고선 세그먼트를 world 좌표로 반환.
 * @returns {Array<[number, number, number, number]>} [x1, y1, x2, y2]
 */
export function contourSegments(grid, level) {
  const { v, n, step, x0, y0 } = grid;
  const segs = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * (n + 1) + i;
      const v00 = v[k];        // TL
      const v10 = v[k + 1];    // TR
      const v11 = v[k + n + 2];// BR
      const v01 = v[k + n + 1];// BL
      let idx = 0;
      if (v00 >= level) idx |= 8;
      if (v10 >= level) idx |= 4;
      if (v11 >= level) idx |= 2;
      if (v01 >= level) idx |= 1;
      let segList = SEGS[idx];
      // 안장점(ambiguous) 셀은 중심 평균값으로 디스앰비규에이션
      if (idx === 5 || idx === 10) {
        const centerIn = (v00 + v10 + v11 + v01) / 4 >= level;
        if (idx === 5) segList = centerIn ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]];
        else segList = centerIn ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
      }
      if (!segList.length) continue;
      const gx = x0 + i * step;
      const gy = y0 + j * step;
      const pts = [null, null, null, null];
      const edgePt = (e) => {
        if (pts[e]) return pts[e];
        let t;
        if (e === 0) t = (level - v00) / (v10 - v00);
        else if (e === 1) t = (level - v10) / (v11 - v10);
        else if (e === 2) t = (level - v01) / (v11 - v01);
        else t = (level - v00) / (v01 - v00);
        if (!Number.isFinite(t)) t = 0;
        t = Math.max(0, Math.min(1, t));
        let ax;
        let ay;
        if (e === 0) { ax = gx + t * step; ay = gy; }
        else if (e === 1) { ax = gx + step; ay = gy + t * step; }
        else if (e === 2) { ax = gx + t * step; ay = gy + step; }
        else { ax = gx; ay = gy + t * step; }
        return (pts[e] = [ax, ay]);
      };
      for (const [ea, eb] of segList) {
        const a = edgePt(ea);
        const b = edgePt(eb);
        segs.push([a[0], a[1], b[0], b[1]]);
      }
    }
  }
  return segs;
}

/**
 * contourSegments 결과를 연속 폴리라인으로 체이닝.
 * (개별 세그먼트를 따로 점선으로 그리면 대시 위상이 어긋나 "그림자"처럼 보임 →
 *  경로 단위로 묶어야 깨끗한 점선이 됨)
 * @returns {Array<number[]>} 각 경로 = [x1,y1,x2,y2,...]
 */
export function contourPaths(grid, level) {
  const segs = contourSegments(grid, level);
  const used = new Uint8Array(segs.length);
  const paths = [];
  const EPS = 1e-6;
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const path = [segs[i][0], segs[i][1], segs[i][2], segs[i][3]];
    let headX = segs[i][2];
    let headY = segs[i][3];
    let tailX = segs[i][0];
    let tailY = segs[i][1];
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const [x1, y1, x2, y2] = segs[j];
        if (Math.abs(x1 - headX) < EPS && Math.abs(y1 - headY) < EPS) {
          path.push(x2, y2); headX = x2; headY = y2; used[j] = 1; grew = true; break;
        }
        if (Math.abs(x2 - headX) < EPS && Math.abs(y2 - headY) < EPS) {
          path.push(x1, y1); headX = x1; headY = y1; used[j] = 1; grew = true; break;
        }
        if (Math.abs(x1 - tailX) < EPS && Math.abs(y1 - tailY) < EPS) {
          path.unshift(x2, y2); tailX = x2; tailY = y2; used[j] = 1; grew = true; break;
        }
        if (Math.abs(x2 - tailX) < EPS && Math.abs(y2 - tailY) < EPS) {
          path.unshift(x1, y1); tailX = x1; tailY = y1; used[j] = 1; grew = true; break;
        }
      }
    }
    paths.push(path);
  }
  return paths;
}
