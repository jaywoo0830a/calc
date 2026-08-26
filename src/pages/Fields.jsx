import { useEffect, useMemo, useRef, useState } from 'react';
import AppLayout from '../components/AppLayout.jsx';
import { fieldAt, forceOnChargeScene, sceneField, plateField, fieldLineCount, potentialCorners, contourPaths, traceFieldLine } from '../lib/electrostatics.js';
import { screenOffset } from '../lib/canvasMath.js';

// ── 상수 ────────────────────────────────────────────────────────
const WORLD_HALF = 5.6;  // 캔버스 세계 좌표 범위 (±)
const PLATE_X = 2;       // 평행판 위치 x = ±2
const PLATE_V0 = 4;      // +판 V = 4 → 판 사이 E = ΔV/d = 4/4 = 1
const MS_N = 150;        // 등전위선 marching-squares 해상도
const MAX_Q = 4;         // 전하량 상한

const COLORS = {
  paper: '#fffef7',
  ink: '#2c2416',
  line: '#5c3d2e',
  equipot: '#6b6050',
  pos: '#b5433a',
  neg: '#3d5a80',
  probe: '#3d5a40',
  accent: '#5c3d2e',
};

const OVERLAY_TOGGLES = [
  ['lines', 'Field lines'],
  ['equipot', 'Equipotential'],
  ['heatmap', 'Potential (color)'],
  ['arrows', 'E direction'],
];

// 화살표 그리기 (x, y = 꼬리 픽셀, worldAng = 세계 좌표(y↑) 각도)
// ⚠️ 내부에서 화면 좌표(y↓)로 변환 — 세계 각도를 그대로 쓰면 수직 방향이 반전됨
function drawArrow(ctx, x, y, worldAng, len, width, color) {
  const { dx, dy } = screenOffset(worldAng, len);
  const tipX = x + dx;
  const tipY = y + dy;
  const h = Math.max(3, Math.min(0.45 * len, 12));
  const w1 = screenOffset(worldAng - 0.55, h);
  const w2 = screenOffset(worldAng + 0.55, h);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - w1.dx, tipY - w1.dy);
  ctx.lineTo(tipX - w2.dx, tipY - w2.dy);
  ctx.closePath();
  ctx.fill();
}

export default function Fields() {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const heatRef = useRef(null); // 히트맵 오프스크린 캔버스
  const flowRef = useRef(null); // 🪩 흐르는 빛 오버레이 캔버스 (E 방향 표시)
  const flowSegsRef = useRef({ lines: [], grid: [] }); // 픽셀 좌표 빛 세그먼트
  const dirtyRef = useRef(true);
  const sizeRef = useRef({ w: 0, h: 0, scale: 1 });
  const dragRef = useRef(null); // { id, ox, oy, sx, sy, moved } | { id:null, x, y }
  const drawRef = useRef(null);
  const drawFlowRef = useRef(null);

  const [mode, setMode] = useState('charges');
  // 모드별 독립 장면 — Canvas/Plates 각자 전하 배치를 보존
  const [scenes, setScenes] = useState({ charges: [], plates: [] });
  const charges = scenes[mode];
  const updateCharges = (fn) => setScenes((s) => ({ ...s, [mode]: fn(s[mode]) }));
  const [overlays, setOverlays] = useState({ lines: true, equipot: true, heatmap: true, arrows: false });
  const [selectedId, setSelectedId] = useState(null);
  const [probe, setProbe] = useState(null);
  const [probeMode, setProbeMode] = useState(false);
  const [picker, setPicker] = useState(null); // { id } — 배치 직후 부호/전하량 팝오버
  const [resizeTick, setResizeTick] = useState(0);
  const lastQRef = useRef(1); // 새 전하 기본값 (마지막으로 정한 부호·전하량)

  const sceneRef = useRef({ charges, mode, overlays, selectedId, probe, drag: null });
  useEffect(() => {
    sceneRef.current = { ...sceneRef.current, charges, mode, overlays, selectedId, probe };
    dirtyRef.current = true;
  }, [charges, mode, overlays, selectedId, probe]);

  // ── 상태 바 계산 ──────────────────────────────────────────────
  const status = useMemo(() => {
    const sel = charges.find((c) => c.id === selectedId) || null;
    if (sel) {
      const { f } = forceOnChargeScene(mode, charges, sel.id, PLATE_X, PLATE_V0);
      return { type: 'charge', q: sel.q, force: f };
    }
    if (mode === 'plates' && !probe) return { type: 'plates' };
    if (probe) {
      const f = sceneField(mode, charges, probe.x, probe.y);
      return {
        type: 'probe',
        x: probe.x,
        y: probe.y,
        v: f.v,
        emag: Math.hypot(f.ex, f.ey),
        ang: (Math.atan2(f.ey, f.ex) * 180) / Math.PI,
      };
    }
    return { type: 'hint' };
  }, [charges, mode, selectedId, probe]);

  // ── 배치 팝오버 위치 (캔버스 상대 픽셀) ────────────────────────
  const pickerPos = useMemo(() => {
    if (!picker) return null;
    const c = charges.find((ch) => ch.id === picker.id);
    if (!c) return null;
    const { w, h, scale } = sizeRef.current;
    if (!w) return null;
    const px = w / 2 + c.x * scale;
    const py = h / 2 - c.y * scale;
    return { left: Math.max(72, Math.min(w - 72, px)), top: py, below: py < 92 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, charges, resizeTick]);

  // ── 그리기 파이프라인 ─────────────────────────────────────────
  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { w, h, scale } = sizeRef.current;
    if (!w) return;
    const dpr = canvas.width / w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const s = sceneRef.current;
    const rc = s.drag
      ? s.charges.map((c) => (c.id === s.drag.id ? { ...c, x: s.drag.x, y: s.drag.y } : c))
      : s.charges;
    const toPx = (x, y) => [w / 2 + x * scale, h / 2 - y * scale];

    // 흐르는 빛 세그먼트는 매 dirty 드로우마다 재수집
    flowSegsRef.current = { lines: [], grid: [] };

    // 배경
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, w, h);

    // 전위 히트맵
    if (s.overlays.heatmap) drawHeatmap(ctx, s.mode, rc, w, h, scale);

    // 등전위선
    if (s.overlays.equipot) drawEquipotential(ctx, s.mode, rc, toPx, w, h);

    // 장선 — 빛과 같은 계열의 연한 가이드 선 + 흐르는 빛 세그먼트 수집
    if (s.overlays.lines) drawFieldLines(ctx, s.mode, rc, toPx, scale);

    // E 방향 그리드 — 정적 화살표 대신 흐르는 빛 세그먼트 수집 (flow 레이어가 애니메이션)
    if (s.overlays.arrows) collectGridFlow(s.mode, rc, toPx, scale);

    // 평행판
    if (s.mode === 'plates') drawPlates(ctx, toPx, w, h, scale);

    // 좌표축 (연하게)
    ctx.strokeStyle = 'rgba(107,96,80,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const [ax1, ay] = toPx(-5.4, 0);
    const [ax2] = toPx(5.4, 0);
    ctx.moveTo(ax1, ay); ctx.lineTo(ax2, ay);
    const [ax, ay1] = toPx(0, 5.4);
    const [, ay2] = toPx(0, -5.4);
    ctx.moveTo(ax, ay1); ctx.lineTo(ax, ay2);
    ctx.stroke();

    // 전하
    drawCharges(ctx, rc, toPx, scale, s.selectedId, s.mode);

    // 빈 상태 안내
    if (s.mode === 'charges' && !rc.length) {
      ctx.fillStyle = COLORS.equipot;
      ctx.font = `500 ${Math.max(12, 0.3 * scale)}px 'Noto Serif', serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Tap anywhere to place a charge', w / 2, h / 2);
    }

    // 프로브
    if (s.probe) drawProbe(ctx, s.mode, rc, s.probe, toPx, scale);

    // 테두리
    ctx.strokeStyle = 'rgba(92,61,46,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  function drawHeatmap(ctx, mode, rc, w, h, scale) {
    const cell = 2;
    const gw = Math.max(2, Math.ceil(w / cell));
    const gh = Math.max(2, Math.ceil(h / cell));
    let off = heatRef.current;
    if (!off || off.width !== gw || off.height !== gh) {
      off = document.createElement('canvas');
      off.width = gw;
      off.height = gh;
      heatRef.current = off;
    }
    const octx = off.getContext('2d');
    const img = octx.createImageData(gw, gh);
    const data = img.data;
    const maxQ = Math.max(1, ...rc.map((c) => Math.abs(c.q)), 1);
    const vclip = 4 * maxQ;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const px = (i + 0.5) * cell;
        const py = (j + 0.5) * cell;
        const wx = (px - w / 2) / scale;
        const wy = (h / 2 - py) / scale;
        const f = fieldAt(rc, wx, wy);
        let v = f.v;
        if (mode === 'plates') {
          const p = plateField(wx, PLATE_X, PLATE_V0);
          // 판 밖 일정 V는 표시용 중립 (판 사이 선형 + 점전하 V만 색칠)
          v += Math.abs(wx) <= PLATE_X ? p.v : 0;
        }
        const t = Math.max(-1, Math.min(1, v / vclip));
        let r = 255;
        let g = 254;
        let b = 247;
        if (t > 0) {
          const a = 0.34 * Math.pow(t, 0.55);
          r += (181 - r) * a;
          g += (67 - g) * a;
          b += (58 - b) * a;
        } else if (t < 0) {
          const a = 0.34 * Math.pow(-t, 0.55);
          r += (61 - r) * a;
          g += (90 - g) * a;
          b += (128 - b) * a;
        }
        const o = (j * gw + i) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, gw, gh, 0, 0, w, h);
    ctx.restore();
  }

  function drawEquipotential(ctx, mode, rc, toPx, w, h) {
    ctx.strokeStyle = 'rgba(107,96,80,0.75)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    if (mode === 'plates' && !rc.length) {
      // 균일장: 수직 등전위선 (V = 0.5…3.5)
      for (let v = 0.5; v < PLATE_V0; v += 0.5) {
        const x = PLATE_V0 / 2 - v; // V = 2 − x → x = 2 − V
        const [ax, ay] = toPx(x, 5.3);
        const [bx, by] = toPx(x, -5.3);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      return;
    }
    const maxQ = Math.max(1, ...rc.map((c) => Math.abs(c.q)));
    // plates + 전하: 판 전위(선형)와 점전하 전위의 합성
    const extV = mode === 'plates' ? (x) => plateField(x, PLATE_X, PLATE_V0).v : null;
    const grid = potentialCorners(rc, MS_N, 5.4, extV);
    let mn = Infinity;
    let mx = -Infinity;
    for (const val of grid.v) {
      if (val < mn) mn = val;
      if (val > mx) mx = val;
    }
    const base = [0.5, 1, 2, 4].map((k) => k * maxQ);
    const levels = [...base.map((k) => -k), 0, ...base];
    for (const level of levels) {
      if (level <= mn || level >= mx) continue;
      for (const path of contourPaths(grid, level)) {
        ctx.beginPath();
        const [ax, ay] = toPx(path[0], path[1]);
        ctx.moveTo(ax, ay);
        for (let k = 2; k < path.length; k += 2) {
          const [px, py] = toPx(path[k], path[k + 1]);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  // Field lines 오버레이 — 빛 입자와 같은 황금빛 계열의 연한 가이드 선 + 흐르는 빛 위치 수집
  function drawFieldLines(ctx, mode, rc, toPx, scale) {
    // plates 모드에서는 판 장과 합성된 장에서 전하 장선을 추적
    const extE = mode === 'plates' ? (x, y) => plateField(x, PLATE_X, PLATE_V0) : null;
    const lineSegs = flowSegsRef.current.lines;
    // ⚠️ 연한 황금빛 — 빛 입자(rgb(216,162,50))와 같은 계열, 낮은 투명도
    ctx.strokeStyle = 'rgba(216,162,50,0.15)';
    ctx.lineWidth = 1.2;

    if (mode === 'plates') {
      // 균일장: 판 사이 수평 가이드 선
      for (let y = -4.5; y <= 4.5; y += 0.5) {
        const [ax, ay] = toPx(-PLATE_X + 0.07, y);
        const [bx, by] = toPx(PLATE_X - 0.07, y);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        for (let x = -1.4; x < PLATE_X - 0.4; x += 0.8) {
          const [lx, ly] = toPx(x, y);
          lineSegs.push({ x: lx, y: ly, ang: 0, len: Math.max(8, 0.2 * scale) });
        }
      }
    }

    // 전하 장선 (합성장에서 추적)
    for (const c of rc) {
      const n = fieldLineCount(c.q); // 장선 수 ∝ |q| (플럭스 직관)
      const r0 = 0.27;
      const dir = Math.sign(c.q);
      for (let k = 0; k < n; k++) {
        const ang = ((k + 0.5) / n) * Math.PI * 2;
        const pts = traceFieldLine(rc, c.x + r0 * Math.cos(ang), c.y + r0 * Math.sin(ang), dir, { excludeId: c.id, ext: extE });
        if (pts.length < 2) continue;
        const [sx, sy] = toPx(pts[0].x, pts[0].y);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        for (const p of pts) {
          const [px, py] = toPx(p.x, p.y);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
        // ~0.85 세계 단위마다 흐르는 빛 위치 수집 (방향은 물리적 합성 E)
        let acc = 0.5;
        for (let i = 1; i < pts.length; i++) {
          acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
          if (acc >= 0.85) {
            acc = 0;
            const e = fieldAt(rc, pts[i].x, pts[i].y);
            let ex = e.ex;
            let ey = e.ey;
            if (extE) {
              const ee = extE(pts[i].x, pts[i].y);
              ex += ee.ex;
              ey += ee.ey;
            }
            const mE = Math.hypot(ex, ey);
            if (mE < 1e-6) continue;
            const [fx, fy] = toPx(pts[i].x, pts[i].y);
            lineSegs.push({ x: fx, y: fy, ang: Math.atan2(ey, ex), len: Math.max(8, 0.2 * scale) });
          }
        }
      }
    }
  }

  // E 방향 그리드 — 각 격자점의 E 방향을 따라 흐르는 빛 세그먼트 수집
  function collectGridFlow(mode, rc, toPx, scale) {
    const segs = flowSegsRef.current.grid;
    const step = 0.62;
    for (let y = -5; y <= 5 + 1e-6; y += step) {
      for (let x = -5; x <= 5 + 1e-6; x += step) {
        let near = false;
        for (const c of rc) {
          if (Math.hypot(x - c.x, y - c.y) < 0.45) { near = true; break; }
        }
        if (near) continue;
        const f = sceneField(mode, rc, x, y);
        const m = Math.hypot(f.ex, f.ey);
        if (m < 0.02) continue;
        const len = Math.max(4, 0.22 * Math.min(1, Math.sqrt(m) / 1.8) * scale);
        const ang = Math.atan2(f.ey, f.ex); // 세계 각도 — screenOffset이 화면(y↓) 변환
        const [px, py] = toPx(x, y);
        const off = screenOffset(ang, len / 2);
        segs.push({ x: px - off.dx, y: py - off.dy, ang, len });
      }
    }
  }

  // 🪩 흐르는 빛 — 단순 버전: 세그먼트당 빛 입자 1개가
  // 전체 거리를 긴 시간(T초)에 걸쳐 천천히 지나가며 양 끝에서 부드럽게 페이드
  function drawFlowLayer(ctx, w, h, now) {
    ctx.clearRect(0, 0, w, h);
    const s = sceneRef.current;
    const segs = [];
    if (s.overlays.lines) segs.push(...flowSegsRef.current.lines);
    if (s.overlays.arrows) segs.push(...flowSegsRef.current.grid);
    if (!segs.length) return;
    const t = now / 1000;
    const T = 1; // 한 입자가 세그먼트를 완주하는 시간 (초)
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgb(216,162,50)';
    for (const sg of segs) {
      // 세그먼트별 고정 위상 오프셋 — 모든 입자가 동시에 출발하는 동기화 방지
      const offset = (sg.x * 0.073 + sg.y * 0.117) % 1;
      const ph = (t / T + offset) % 1;
      const { dx, dy } = screenOffset(sg.ang, sg.len);
      // 입자 길이 = 세그먼트의 40%, 이동 거리 = 세그먼트 + 입자 길이 (더 길게)
      const pLen = Math.max(3, sg.len * 0.4);
      const D = sg.len + pLen;
      const c = ph * D - pLen / 2; // 입자 중심의 세그먼트 내 위치
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, c / D))), 0.8);
      if (env <= 0.02) continue;
      const x0 = Math.max(0, c - pLen / 2);
      const x1 = Math.min(sg.len, c + pLen / 2);
      if (x1 <= x0) continue;
      // 은은한 후광 + 밝은 입자 (같은 위치·같은 위상)
      ctx.lineWidth = 5;
      ctx.globalAlpha = 0.18 * env;
      ctx.beginPath();
      ctx.moveTo(sg.x + (x0 / sg.len) * dx, sg.y + (x0 / sg.len) * dy);
      ctx.lineTo(sg.x + (x1 / sg.len) * dx, sg.y + (x1 / sg.len) * dy);
      ctx.stroke();
      ctx.lineWidth = 2.4;
      ctx.globalAlpha = 0.9 * env;
      ctx.beginPath();
      ctx.moveTo(sg.x + (x0 / sg.len) * dx, sg.y + (x0 / sg.len) * dy);
      ctx.lineTo(sg.x + (x1 / sg.len) * dx, sg.y + (x1 / sg.len) * dy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawPlates(ctx, toPx, w, h, scale) {
    const drawPlate = (x, color, label) => {
      const [px] = toPx(x, 0);
      const [ax, ay] = toPx(x, 5.1);
      const [bx, by] = toPx(x, -5.1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = `700 ${Math.max(12, 0.42 * scale)}px 'Noto Serif', serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, px, ay - 5);
    };
    drawPlate(-PLATE_X, COLORS.pos, '+');
    drawPlate(PLATE_X, COLORS.neg, '−');
  }

  function drawCharges(ctx, rc, toPx, scale, selectedId, mode) {
    for (const c of rc) {
      const [px, py] = toPx(c.x, c.y);
      const r = (0.2 + 0.06 * Math.abs(c.q)) * scale;
      const color = c.q > 0 ? COLORS.pos : COLORS.neg;
      // 선택된 전하: 받는 알짜힘 화살표 (plates 모드에서는 균일장 포함)
      if (c.id === selectedId) {
        const { fx, fy, f: fm } = forceOnChargeScene(mode, rc, c.id, PLATE_X, PLATE_V0);
        if (fm > 1e-3) {
          const ang = Math.atan2(fy, fx); // 세계 각도 — drawArrow가 화면(y↓)으로 변환
          const len = Math.min(1.5, 0.4 + 0.9 * Math.min(1, fm / 1.2)) * scale;
          const off = screenOffset(ang, r + 2);
          const sx = px + off.dx;
          const sy = py + off.dy;
          drawArrow(ctx, sx, sy, ang, len, 2.4, COLORS.ink);
        }
      }
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.paper;
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = `700 ${r * 1.05}px 'Noto Serif', serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.q > 0 ? '+' : '−', px, py + r * 0.05);
      const m = Math.abs(c.q);
      ctx.font = `600 ${Math.max(10, 0.3 * scale)}px 'Noto Serif', serif`;
      ctx.fillStyle = COLORS.ink;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(m === 1 ? 'q' : `${m}q`, px + r + 0.34 * scale, py - r + 0.1 * scale);
      if (c.id === selectedId) {
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.arc(px, py, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function drawProbe(ctx, mode, rc, probe, toPx, scale) {
    const [px, py] = toPx(probe.x, probe.y);
    const f = sceneField(mode, rc, probe.x, probe.y);
    const m = Math.hypot(f.ex, f.ey);
    ctx.strokeStyle = COLORS.probe;
    ctx.lineWidth = 1.5;
    const cs = 0.34 * scale;
    ctx.beginPath();
    ctx.moveTo(px - cs, py);
    ctx.lineTo(px + cs, py);
    ctx.moveTo(px, py - cs);
    ctx.lineTo(px, py + cs);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 0.16 * scale, 0, Math.PI * 2);
    ctx.stroke();
    if (m > 1e-3) {
      const ang = Math.atan2(f.ey, f.ex);
      drawArrow(ctx, px, py, ang, 0.75 * scale, 2, COLORS.probe);
    }
  }

  drawRef.current = draw;
  drawFlowRef.current = drawFlowLayer;

  // ── 렌더 루프: 메인 캔버스는 dirty일 때만, 흐르는 빛 레이어는 매 프레임 ──
  useEffect(() => {
    let raf;
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      if (dirtyRef.current) {
        dirtyRef.current = false;
        drawRef.current?.();
      }
      const fc = flowRef.current;
      if (!fc) return;
      const { w, h } = sizeRef.current;
      if (!w) return;
      const fctx = fc.getContext('2d');
      const dpr = fc.width / w;
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const s = sceneRef.current;
      if (s.overlays.lines || s.overlays.arrows) {
        drawFlowRef.current?.(fctx, w, h, now);
      } else {
        fctx.clearRect(0, 0, w, h);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── 캔버스 크기 (정사각형, stage에 맞춤) ────────────────────────
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const fit = () => {
      const r = stage.getBoundingClientRect();
      const side = Math.max(160, Math.floor(Math.min(r.width, r.height) - 4));
      sizeRef.current = { w: side, h: side, scale: side / (2 * WORLD_HALF) };
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(side * dpr);
      canvas.height = Math.round(side * dpr);
      canvas.style.width = `${side}px`;
      canvas.style.height = `${side}px`;
      const flow = flowRef.current;
      if (flow) {
        flow.width = Math.round(side * dpr);
        flow.height = Math.round(side * dpr);
        flow.style.width = `${side}px`;
        flow.style.height = `${side}px`;
      }
      dirtyRef.current = true;
      setResizeTick((t) => t + 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  // ── 포인터 상호작용 ───────────────────────────────────────────
  const toWorld = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const { scale } = sizeRef.current;
    return {
      x: (e.clientX - rect.left - rect.width / 2) / scale,
      y: (rect.height / 2 - (e.clientY - rect.top)) / scale,
    };
  };

  const hitCharge = (list, x, y) => {
    for (const c of list) {
      const r = 0.2 + 0.06 * Math.abs(c.q);
      if (Math.hypot(x - c.x, y - c.y) <= r + 0.34) return c; // 터치 정밀도 여유
    }
    return null;
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    const { x, y } = toWorld(e);
    const hit = hitCharge(sceneRef.current.charges, x, y);
    if (hit) {
      dragRef.current = { id: hit.id, ox: hit.x - x, oy: hit.y - y, sx: hit.x, sy: hit.y, moved: false };
      setSelectedId(hit.id);
    } else {
      dragRef.current = { id: null, x, y, moved: false };
    }
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || !d.id) return;
    const { x, y } = toWorld(e);
    const nx = x + d.ox;
    const ny = y + d.oy;
    // ⚠️ 모바일 손가락 떨림(작은 이동)은 탭으로 취급 — 임계값을 넘어야 드래그
    if (!d.moved && Math.hypot(nx - d.sx, ny - d.sy) < 0.12) return;
    d.moved = true;
    sceneRef.current.drag = {
      id: d.id,
      x: Math.max(-5.4, Math.min(5.4, nx)),
      y: Math.max(-5.4, Math.min(5.4, ny)),
    };
    dirtyRef.current = true;
  };

  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.id) {
      const p = d.moved ? sceneRef.current.drag : null;
      sceneRef.current.drag = null;
      if (p) {
        // 드래그 확정 → 이동 반영, 팝오버 닫기
        updateCharges((cs) => cs.map((c) => (c.id === p.id ? { ...c, x: p.x, y: p.y } : c)));
        setPicker(null);
      } else {
        // 전하 위 가벼운 탭 → 부호/전하량 편집 팝오버 (모바일 재탭 포함)
        setSelectedId(d.id);
        setProbe(null);
        setPicker({ id: d.id });
      }
    } else if (probeMode) {
      // 프로브 모드: 빈 곳 탭 → 그 점의 V·E 측정
      setProbe({ x: d.x, y: d.y });
      setSelectedId(null);
      setPicker(null);
    } else {
      // 기본: 빈 곳 탭 → 그 자리에 전하 배치 (plates 모드에서는 균일장 안에 배치)
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      updateCharges((cs) => [...cs, { id, x: d.x, y: d.y, q: lastQRef.current }]);
      setSelectedId(id);
      setProbe(null);
      setPicker({ id });
    }
    dirtyRef.current = true;
  };

  // ── 액션 ──────────────────────────────────────────────────────
  const switchMode = (m) => {
    if (m === mode) return;
    setMode(m); // 장면은 모드별로 보존됨
    setSelectedId(null);
    setProbe(null);
    setPicker(null);
  };

  const clearAll = () => {
    updateCharges(() => []); // 현재 모드의 장면만 비움
    setSelectedId(null);
    setProbe(null);
    setPicker(null);
  };

  // E direction은 장선/등전위선과 함께 켜면 혼란스러움 → 상호 배타 토글
  const toggleOverlay = (k) => setOverlays((o) => {
    const next = { ...o, [k]: !o[k] };
    if (k === 'arrows' && next.arrows) {
      next.lines = false;
      next.equipot = false;
    } else if ((k === 'lines' || k === 'equipot') && next[k]) {
      next.arrows = false;
    }
    return next;
  });

  const changeMag = (id, d) => {
    const c = charges.find((ch) => ch.id === id);
    if (!c) return;
    const q = Math.max(1, Math.min(MAX_Q, Math.abs(c.q) + d)) * Math.sign(c.q);
    lastQRef.current = q;
    updateCharges((cs) => cs.map((ch) => (ch.id === id ? { ...ch, q } : ch)));
  };

  const setSignOf = (id, sign) => {
    const c = charges.find((ch) => ch.id === id);
    if (!c) return;
    const q = Math.abs(c.q) * sign;
    lastQRef.current = q;
    updateCharges((cs) => cs.map((ch) => (ch.id === id ? { ...ch, q } : ch)));
  };

  const deleteCharge = (id) => {
    updateCharges((cs) => cs.filter((ch) => ch.id !== id));
    setSelectedId((s) => (s === id ? null : s));
    setPicker((p) => (p && p.id === id ? null : p));
  };

  return (
    <AppLayout className="fields">

      <div className="fields__panel">
        <div className="fields__chips" role="group" aria-label="Mode, tools and overlays">
        <span className="fields__mode-switch" role="group" aria-label="Field mode">
          <button
            className={'fields__mode-btn' + (mode === 'charges' ? ' fields__mode-btn--active' : '')}
            onClick={() => switchMode('charges')}
          >Canvas</button>
          <button
            className={'fields__mode-btn' + (mode === 'plates' ? ' fields__mode-btn--active' : '')}
            onClick={() => switchMode('plates')}
          >Plates</button>
        </span>
        <button className="fields__chip" onClick={clearAll}>Clear</button>
        <button
          className={'fields__chip' + (probeMode ? ' fields__chip--active' : '')}
          onClick={() => { setProbeMode((m) => !m); setProbe(null); setPicker(null); }}
        >◉ Probe</button>
        <span className="fields__chip-sep" aria-hidden="true" />
        {OVERLAY_TOGGLES.map(([k, label]) => (
          <button
            key={k}
            className={'fields__chip' + (overlays[k] ? ' fields__chip--active' : '')}
            onClick={() => toggleOverlay(k)}
          >{label}</button>
        ))}
      </div>
      </div>

      <div className="fields__stage" ref={stageRef}>
        <div className="fields__canvas-wrap">
          <canvas
            ref={canvasRef}
            className="fields__canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          <canvas ref={flowRef} className="fields__canvas fields__flow" aria-hidden="true" />
          {picker && pickerPos && (() => {
            const c = charges.find((ch) => ch.id === picker.id);
            if (!c) return null;
            return (
              <div
                className={'fields__picker' + (pickerPos.below ? ' fields__picker--below' : '')}
                style={{ left: pickerPos.left, top: pickerPos.top }}
              >
                <div className="fields__picker-row">
                  <span className="fields__picker-label">Sign</span>
                  <button
                    className={'fields__qbtn' + (c.q > 0 ? ' fields__qbtn--sign' : '')}
                    onClick={() => setSignOf(picker.id, 1)}
                  >+</button>
                  <button
                    className={'fields__qbtn' + (c.q < 0 ? ' fields__qbtn--sign' : '')}
                    onClick={() => setSignOf(picker.id, -1)}
                  >−</button>
                </div>
                <div className="fields__picker-row">
                  <span className="fields__picker-label">Size</span>
                  <button className="fields__qbtn" onClick={() => changeMag(picker.id, -1)}>−</button>
                  <span className="fields__qmag">{Math.abs(c.q)}q</span>
                  <button className="fields__qbtn" onClick={() => changeMag(picker.id, 1)}>+</button>
                </div>
                <div className="fields__picker-row">
                  <button className="fields__qbtn fields__qbtn--del" onClick={() => deleteCharge(picker.id)}>Delete</button>
                  <button className="fields__picker-done" onClick={() => setPicker(null)}>✓ Done</button>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      <div className="fields__status">
        {status.type === 'charge' && (
          <span>Charge q = {status.q > 0 ? '+' : '−'}{Math.abs(status.q)} · force |F| = {status.force.toFixed(2)} (relative units) — tap it to edit sign/size</span>
        )}
        {status.type === 'plates' && (
          <span>Parallel plates: uniform E = 1 between plates · ΔV = Ed = 4 · V decreases linearly from + to − plate</span>
        )}
        {status.type === 'probe' && (
          <span>
            P({status.x.toFixed(1)}, {status.y.toFixed(1)}) · V = {status.v.toFixed(2)} · |E| = {status.emag.toFixed(2)}
            {status.emag > 1e-3 ? ` · E direction ${status.ang.toFixed(0)}° (from +x axis)` : ' · E = 0'}
          </span>
        )}
        {status.type === 'hint' && (
          <span className="fields__status-note">
            {probeMode
              ? 'Probe mode: tap a point to measure V & E there — press ◉ Probe again to return to placing charges'
              : 'E = kQ/r² · V = kQ/r · F = kQ₁Q₂/r² — k = 1 (relative units). Tap anywhere to place a charge, drag to move'}
          </span>
        )}
      </div>
    </AppLayout>
  );
}
