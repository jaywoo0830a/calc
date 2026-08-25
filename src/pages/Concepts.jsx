import { useState, useCallback, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import AppNav from '../components/AppNav.jsx';
import { getAllConcepts, saveConcept, deleteConcept } from '../lib/storage.js';
import { setPendingConcept, takePendingConceptsFullscreen } from '../lib/conceptJump.js';
import {
  updateNode, reparentNode, deleteNode, buildTree,
  reviewQueue, STATUS, REVIEW_PRIORITY,
  addNode, setOrder, childrenOf, suggestId,
  conceptsToMap, conceptIdBase,
} from '../lib/conceptMap.js';

// ── 🧭 Concepts — 개념 노드 모아보기 (문서별 트리, 상태 필터) ──
// PDF 뷰어의 🧭 Concept 툴/단축키 N으로 만든 개념 노드를 전부 모아 보여준다.
// 노드만 훑으며 원 페이지로 점프 = 초고속 복습.
// 행 3원칙: 기본=이름만 · 클릭=내용(요약+p.N) · 더블클릭=편집.

const docName = (fp) => String(fp || '').split('/').pop() || 'Document';

// 상태별 색 — 노드의 상태 점(dot)에 반영 (○ 모름=빨강, ◐ 애매=황토, ● 이해=초록, △ 보류=회색)
const STATUS_COLORS = {
  [STATUS.UNKNOWN]: '#b5433a',
  [STATUS.FUZZY]: '#c98a1b',
  [STATUS.KNOWN]: '#3d5a40',
  [STATUS.HOLD]: '#8a8378',
};

const STATUS_LABELS = {
  [STATUS.UNKNOWN]: "Don't know",
  [STATUS.FUZZY]: 'Fuzzy',
  [STATUS.KNOWN]: 'Understood',
  [STATUS.HOLD]: 'On hold',
};

/** 같은 문서의 노드만 담은 core map */
function docMap(items, filePath) {
  return conceptsToMap((items || []).filter((c) => c.filePath === filePath));
}

/** 답안 비교 정규화 — 공백·대소문자 무시 */
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// ── CLEAR 프레임 (뇌과학 기반 요약 틀) — DB 변경 없이 summary 문자열로 병합 ──
const CLEAR_KEYS = ['Core', 'Link', 'Example', 'Antithesis', 'Restate'];

const CLEAR_PLACEHOLDERS = {
  Core: 'what is it? (one sentence, your own words)',
  Link: 'upper / lower / related (⊃ → ↔ ≠)',
  Example: 'one concrete case',
  Antithesis: 'what it is NOT · exceptions · boundaries',
  Restate: 'everything in one sentence',
};

/** summary 문자열 → CLEAR 섹션 파싱 (헤더 없는 레거시 텍스트는 Core로) */
function parseClear(text) {
  const parts = {};
  CLEAR_KEYS.forEach((k) => { parts[k] = ''; });
  let last = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(new RegExp(`^(${CLEAR_KEYS.join('|')}):\\s*(.*)$`));
    if (m) {
      last = m[1];
      if (m[2]) parts[last] = m[2];
    } else if (last) {
      parts[last] = (parts[last] ? parts[last] + '\n' : '') + line;
    } else if (line.trim()) {
      parts.Core = (parts.Core ? parts.Core + '\n' : '') + line;
    }
  }
  return parts;
}

/** CLEAR 섹션 → summary 문자열 병합 (빈 섹션 생략) */
function mergeClear(parts) {
  return CLEAR_KEYS
    .filter((k) => String(parts[k] || '').trim())
    .map((k) => `${k}: ${String(parts[k]).trim()}`)
    .join('\n');
}

/** summary가 CLEAR 헤더 형식인지 */
function hasClearFormat(text) {
  return new RegExp(`^(${CLEAR_KEYS.join('|')}):\\s`, 'm').test(String(text || ''));
}

// ── 🧠 학습 마찰 게이트: 새 노드(빈 summary)는 연속 5분 + 최소 2섹션 채워야 저장 ──
const STUDY_GATE_MS = 5 * 60 * 1000;
const STUDY_GATE_MIN_SECTIONS = 2;

const fmtMs = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 트리에서 id 노드 탐색 */
function findTreeNode(roots, id) {
  for (const n of roots) {
    if (n.id === id) return n;
    const f = findTreeNode(n.children || [], id);
    if (f) return f;
  }
  return null;
}

/** 플로팅 내용 카드 앵커 — 노드 오른쪽(없으면 왼쪽, 그래도 없으면 뷰포트 클램프) */
function anchorFor(el, id) {
  const r = el.getBoundingClientRect();
  const CARD_W = 384, GAP = 12;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left;
  if (r.right + GAP + CARD_W <= vw) left = r.right + GAP;
  else if (r.left - GAP - CARD_W >= 0) left = r.left - GAP - CARD_W;
  else left = Math.max(12, Math.min(r.left, vw - CARD_W - 12));
  const cardH = Math.min(380, vh - 24);
  const top = Math.max(12, Math.min(r.top, vh - 12 - cardH));
  return { id, left, top };
}

/** 테스트 범위 id 목록 (순수) — 전체 또는 서브트리 */
function testScopeOf(items, filePath, t) {
  if (!t || !items || !filePath) return [];
  const map = conceptsToMap((items || []).filter((c) => c.filePath === filePath));
  if (t.retryIds) return t.retryIds;
  if (!t.rootId) return Object.keys(map);
  const roots = buildTree(map);
  const sub = findTreeNode(roots, t.rootId);
  if (!sub) return [];
  const out = [];
  const walk = (n) => { out.push(n.id); (n.children || []).forEach(walk); };
  walk(sub);
  return out;
}

/**
 * 드래그 앤 드롭 배치 — before/after(대상과 같은 부모의 형제 위치) 또는
 * inside(대상의 마지막 자식). 사이클은 reparentNode가 검증(throw)한다.
 */
function placeNodeAt(map, nodeId, targetId, pos) {
  const target = map[targetId];
  if (!map[nodeId] || !target || nodeId === targetId) return map;
  const newParent = pos === 'inside' ? target.id : target.parent;
  let m = reparentNode(map, nodeId, newParent);
  if (pos === 'inside') return m; // 마지막 자식으로
  // 형제 목록에서 대상 위치(before/after)에 끼워 넣고 order 재정규화
  const sibs = childrenOf(m, newParent).filter((n) => n.id !== nodeId);
  const ti = sibs.findIndex((n) => n.id === targetId);
  if (ti < 0) return m;
  const insertAt = pos === 'before' ? ti : ti + 1;
  const ordered = [...sibs];
  ordered.splice(insertAt, 0, m[nodeId]);
  let out = m;
  ordered.forEach((n, i) => { out = setOrder(out, n.id, i); });
  return out;
}

export default function Concepts() {
  const [items, setItems] = useState(null);      // null = 로딩 중
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState('all');   // all | ○ | ◐ | ● | △
  const [selectedFp, setSelectedFp] = useState(null); // null = PDF 목록 뷰, 선택 시 디테일 뷰
  const [editing, setEditing] = useState(null);  // { id, filePath, label, summary, status, parent, pageNumber }
  const [collapsed, setCollapsed] = useState(() => new Set()); // 접힌 노드 id (UI 전용)
  const [expandedId, setExpandedId] = useState(null); // 클릭으로 내용 펼친 노드 (한 번에 하나)
  const [contentAnchor, setContentAnchor] = useState(null); // { id, left, top } — 플로팅 카드 위치
  const [cardPos, setCardPos] = useState(null); // { id, left, top } — 실측 후 뷰포트 클램프 좌표
  const cardRef = useRef(null);
  const lastTapRef = useRef({ id: null, t: 0 }); // 터치 더블 탭 감지 (dblclick 없는 기기)
  const [treeFull, setTreeFull] = useState(false); // 트리 전체화면 (뷰어 전체화면과 동일한 몰입)
  const [treeZoom, setTreeZoom] = useState(1);    // 전체화면 줌 0.6–2.0
  const overlayRef = useRef(null);
  const nativeFsRef = useRef(false); // 네이티브 풀스크린 진입 여부 (fullscreenchange 동기화용)
  // 🧠 Test 모드 (회상 연습) — 비파괴(서버 변경 없음)
  const [testPick, setTestPick] = useState(false);   // 범위 선택 중 (노드 탭 = 그 서브트리)
  const [testType, setTestType] = useState('label'); // 'label'(A)=모든 라벨만 | 'deep'(B)=빈 라벨+CLEAR
  const [test, setTest] = useState(null);            // { type, rootId, blankIds[], answers:{id:{label,summary}}, scored, missed[], retryIds }
  const [testInput, setTestInput] = useState(null);  // 답 입력 중인 노드 id
  const [testText, setTestText] = useState('');
  const [gate, setGate] = useState(null);            // { id, openedAt } — 새 노드 5분 학습 게이트
  const [, setTick] = useState(0);                   // 게이트 카운트다운 리렌더 틱
  const draftRef = useRef({});                       // 게이트 노드 초안 보존 (닫아도 유지, 타이머만 리셋)
  const [dragId, setDragId] = useState(null);     // 드래그 중인 노드 id
  const [dropHint, setDropHint] = useState(null); // { id, pos: before|after|inside }
  const [addingChild, setAddingChild] = useState(null); // { id, filePath } — 자식 추가 중인 부모
  const [childLabel, setChildLabel] = useState('');
  const savingRef = useRef(0);                    // 진행 중 저장 수 — 폴링이 낙관적 변경을 덮지 않게
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    setLoadError(false);
    getAllConcepts().then((list) => {
      setItems(list || []);
      if (list == null) setLoadError(true);
    }).catch(() => { setItems(null); setLoadError(true); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Viewer(전체화면)의 🧭 Concepts 버튼 → 해당 문서를 전체화면 트리로 열기
  const pendingFsRef = useRef(takePendingConceptsFullscreen());
  useEffect(() => {
    const fp = pendingFsRef.current;
    if (!fp || !items) return;
    pendingFsRef.current = null;
    if (items.some((c) => c.filePath === fp)) {
      setSelectedFp(fp);
      setTreeFull(true);
    }
  }, [items]);

  // 선택한 문서의 개념이 전부 사라지면(삭제 등) 목록 뷰로 복귀
  useEffect(() => {
    if (selectedFp && items && !items.some((c) => c.filePath === selectedFp)) setSelectedFp(null);
  }, [selectedFp, items]);

  // 문서/필터가 바뀌면 열려 있던 내용·편집·자식 추가·테스트 UI를 닫는다
  useEffect(() => {
    setExpandedId(null);
    setContentAnchor(null);
    setEditing(null);
    setGate(null);
    setAddingChild(null);
    setChildLabel('');
    setTest(null);
    setTestPick(false);
    setTestInput(null);
    setTestText('');
  }, [selectedFp, filter]);

  // 📡 3초 폴링 — 다른 기기와 동기 (서명 같으면 setState 생략, 저장 중엔 스킵)
  useEffect(() => {
    const id = setInterval(() => {
      if (savingRef.current > 0) return; // 편집 저장이 진행 중 — 다음 틱으로
      getAllConcepts().then((list) => {
        if (!list) return;
        setItems((prev) => {
          if (!prev) return list;
          const sig = (l) => JSON.stringify(l.map((c) => [c.id, c.updatedAt]).sort());
          return sig(prev) === sig(list) ? prev : list;
        });
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, []);

  // ── 코어 연산 결과를 전역 목록에 반영 + 변경분만 서버 저장 ──
  const commitDoc = useCallback((filePath, oldMap, newMap) => {
    const list = Object.values(newMap).map((n) => ({
      id: n.id, filePath, label: n.label, summary: n.summary, status: n.status,
      parentId: n.parent || '', pageNumber: n.pageNumber, order: n.order,
      createdAt: n.createdAt || new Date().toISOString(),
      updatedAt: n.updatedAt || new Date().toISOString(),
    }));
    setItems((prev) => [...(prev || []).filter((c) => c.filePath !== filePath), ...list]);
    const ops = [];
    for (const id of Object.keys(oldMap)) {
      if (!newMap[id]) ops.push(deleteConcept(id));
    }
    for (const id of Object.keys(newMap)) {
      const n = newMap[id];
      const o = oldMap[id];
      if (!o
        || n.label !== o.label || n.summary !== o.summary || n.status !== o.status
        || n.parent !== o.parent || n.order !== o.order || n.pageNumber !== o.pageNumber) {
        ops.push(saveConcept({
          id: n.id, filePath, label: n.label, summary: n.summary, status: n.status,
          parentId: n.parent || '', pageNumber: n.pageNumber, order: n.order,
        }));
      }
    }
    savingRef.current += 1;
    Promise.all(ops).catch(() => refresh()).finally(() => { savingRef.current -= 1; });
  }, [refresh]);

  // 삭제 — 자식은 조부모로 자동 승격 (명세 §4.3)
  const removeItem = useCallback((c) => {
    const map = docMap(items, c.filePath);
    if (!map[c.id]) return;
    delete draftRef.current[c.id];
    commitDoc(c.filePath, map, deleteNode(map, c.id));
  }, [items, commitDoc]);

  // ── 트리 인터랙션 ──
  const toggleCollapse = useCallback((id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // 행 클릭 → 내용 펼침/접힘 — 플로팅 카드(한 번에 하나만)
  const toggleExpand = useCallback((id, el) => {
    if (expandedId === id) {
      setExpandedId(null);
      setContentAnchor(null);
      return;
    }
    setExpandedId(id);
    if (el) setContentAnchor(anchorFor(el, id));
  }, [expandedId]);

  // 플로팅 카드 — 스크롤/리사이즈 시 노드에 붙어 따라감
  useEffect(() => {
    if (!contentAnchor) return;
    const id = contentAnchor.id;
    const reposition = () => {
      const el = document.querySelector(`[data-node-id="${id}"]`);
      if (!el) return;
      const a = anchorFor(el, id);
      setContentAnchor((prev) => (prev && (prev.left !== a.left || prev.top !== a.top) ? a : prev));
    };
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [contentAnchor && contentAnchor.id]);

  // 플로팅 카드 — 실제 크기 측정 후 뷰포트 안으로 클램프 (모든 기기 안정 포지션)
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || !contentAnchor) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = contentAnchor.left, top = contentAnchor.top;
    if (r.right > vw - 8) left = Math.max(8, vw - r.width - 8);
    if (r.bottom > vh - 8) top = Math.max(8, vh - r.height - 8);
    setCardPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { id: contentAnchor.id, left, top }));
  });

  // 플로팅 카드 바깥 클릭 → 닫기 (해당 노드 행 클릭은 유지)
  useEffect(() => {
    if (!contentAnchor) return;
    const onDown = (e) => {
      if (e.target.closest('.concepts__float-card')) return;
      if (e.target.closest(`[data-node-id="${contentAnchor.id}"]`)) return;
      setExpandedId(null);
      setContentAnchor(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [contentAnchor]);

  // 펼친 노드가 삭제되면 카드 닫기
  useEffect(() => {
    if (expandedId && items && !items.some((c) => c.id === expandedId)) {
      setExpandedId(null);
      setContentAnchor(null);
    }
  }, [expandedId, items]);

  // 트리 전체화면 — Esc로 닫기
  useEffect(() => {
    if (!treeFull) return;
    const onKey = (e) => { if (e.key === 'Escape') setTreeFull(false); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [treeFull]);

  // 트리 전체화면 — 네이티브 Fullscreen API 우선, 실패/iOS는 CSS 오버레이 폴백
  useEffect(() => {
    if (!treeFull) return;
    const el = overlayRef.current;
    if (el && el.requestFullscreen) {
      el.requestFullscreen().then(() => { nativeFsRef.current = true; }).catch(() => { nativeFsRef.current = false; });
    }
  }, [treeFull]);

  // 브라우저 UI(ESC 등)로 풀스크린을 나가면 상태 동기화
  useEffect(() => {
    const onFs = () => {
      if (nativeFsRef.current && !document.fullscreenElement) {
        nativeFsRef.current = false;
        setTreeFull(false);
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const exitTreeFull = useCallback(() => {
    nativeFsRef.current = false;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    setTreeFull(false);
  }, []);

  // ── 🧠 Test 모드 ──
  const startTest = useCallback((rootId) => {
    const ids = testScopeOf(items, selectedFp, { rootId, retryIds: null });
    let blankIds;
    if (testType === 'deep') {
      const shuffled = ids.slice().sort(() => Math.random() - 0.5);
      blankIds = shuffled.slice(0, Math.max(1, Math.ceil(ids.length / 2))); // 라벨 절반 정도 랜덤 비움
    } else {
      blankIds = ids.slice(); // A — 전부 빈칸
    }
    setTest({
      type: testType, rootId, blankIds,
      answers: {}, scored: false, missed: [], retryIds: null,
    });
    setTestPick(false);
    setExpandedId(null);
    setContentAnchor(null);
    setTestInput(null);
    setTestText('');
  }, [items, selectedFp, testType]);

  const beginAnswer = useCallback((id) => {
    if (!test || test.scored) return;
    setTestInput(id);
    setTestText((test.answers[id] || {}).label || '');
  }, [test]);

  const submitAnswer = useCallback(() => {
    if (!testInput) return;
    const v = testText.trim();
    if (v) {
      setTest((t) => (t ? {
        ...t,
        answers: { ...t.answers, [testInput]: { ...(t.answers[testInput] || {}), label: v } },
      } : t));
    }
    setTestInput(null);
    setTestText('');
  }, [testInput, testText]);

  const exitTest = useCallback(() => {
    setTest(null);
    setTestPick(false);
    setTestInput(null);
    setTestText('');
  }, []);

  // 게이트 카운트다운 — 남은 시간이 0이 될 때까지 1초 틱
  const gateRemainingMs = gate ? Math.max(0, STUDY_GATE_MS - (Date.now() - gate.openedAt)) : 0;
  const gateFilled = editing ? CLEAR_KEYS.filter((k) => String(editing.parts[k] || '').trim()).length : 0;
  const gateLocked = !!gate && (gateRemainingMs > 0 || gateFilled < STUDY_GATE_MIN_SECTIONS);
  const gateCounting = !!gate && gateRemainingMs > 0;
  useEffect(() => {
    if (!gateCounting) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [gateCounting]);

  // DnD 드롭 — 같은 문서 안에서만 이동 (문서 간 이동은 미지원)
  const onDropNode = useCallback((draggedId, targetId, pos) => {
    const dragged = (items || []).find((c) => c.id === draggedId);
    const target = (items || []).find((c) => c.id === targetId);
    if (!dragged || !target || dragged.filePath !== target.filePath) return;
    const map = docMap(items, dragged.filePath);
    try {
      commitDoc(dragged.filePath, map, placeNodeAt(map, draggedId, targetId, pos));
    } catch (e) {
      console.warn('[concepts] drop failed:', e); // 사이클 등은 코어가 거부
    }
  }, [items, commitDoc]);

  // 인라인 자식 추가
  const startAddChild = useCallback((c) => {
    setAddingChild({ id: c.id, filePath: c.filePath });
    setChildLabel('');
  }, []);

  const submitChild = useCallback(() => {
    const parent = addingChild;
    if (!parent) return;
    const label = childLabel.trim();
    setAddingChild(null);
    setChildLabel('');
    if (!label) return;
    const map = docMap(items, parent.filePath);
    if (!map[parent.id]) return;
    try {
      const id = suggestId(map, conceptIdBase(parent.filePath));
      const newMap = addNode(map, { id, label, parent: parent.id, pageNumber: map[parent.id].pageNumber });
      commitDoc(parent.filePath, map, newMap);
    } catch (e) {
      console.warn('[concepts] add child failed:', e);
    }
  }, [addingChild, childLabel, items, commitDoc]);

  // 자식 추가/테스트 답 입력 — 바깥 클릭/Esc로 닫기 (안 없어지는 UI 방지)
  useEffect(() => {
    if (!addingChild && !testInput) return;
    const close = () => {
      if (addingChild) { setAddingChild(null); setChildLabel(''); }
      if (testInput) { setTestInput(null); setTestText(''); }
    };
    const onDown = (e) => {
      if (!e.target.closest('.concepts__add-child')) close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [addingChild, testInput]);

  const startEdit = useCallback((c) => {
    setExpandedId(null);
    setContentAnchor(null);
    const isNew = !String(c.summary || '').trim();
    const draft = isNew ? draftRef.current[c.id] : null;
    setEditing({
      id: c.id, filePath: c.filePath, label: c.label || '',
      parts: draft ? { ...draft } : parseClear(c.summary),
      status: c.status || STATUS.UNKNOWN, parent: c.parentId || '',
      pageNumber: Number(c.pageNumber) || 1,
    });
    // 빈 summary 노드만 게이트 — 닫으면 리셋, 초안은 draftRef에 보존
    setGate(isNew ? { id: c.id, openedAt: Date.now() } : null);
  }, []);

  // 편집기 닫기 — 게이트 타이머 리셋 + 초안 보존
  const closeEditor = useCallback(() => {
    setEditing((v) => {
      if (v && gate && gate.id === v.id) draftRef.current[v.id] = v.parts;
      return null;
    });
    setGate(null);
  }, [gate]);

  // CLEAR 섹션 입력 — 게이트 노드는 초안을 계속 백업
  const updatePart = useCallback((k, value) => {
    setEditing((v) => {
      if (!v) return v;
      const parts = { ...v.parts, [k]: value };
      if (gate && gate.id === v.id) draftRef.current[v.id] = parts;
      return { ...v, parts };
    });
  }, [gate]);

  const saveEdit = useCallback(() => {
    if (!editing) return;
    if (gate && gate.id === editing.id) {
      const elapsed = Date.now() - gate.openedAt;
      const filled = CLEAR_KEYS.filter((k) => String(editing.parts[k] || '').trim()).length;
      if (elapsed < STUDY_GATE_MS || filled < STUDY_GATE_MIN_SECTIONS) return; // 게이트 잠금
    }
    const map = docMap(items, editing.filePath);
    if (!map[editing.id]) { setEditing(null); setGate(null); return; }
    try {
      let newMap = updateNode(map, editing.id, {
        label: editing.label, summary: mergeClear(editing.parts || {}),
        status: editing.status, pageNumber: Number(editing.pageNumber) || 1,
      });
      const targetParent = editing.parent ? String(editing.parent) : null;
      if (newMap[editing.id].parent !== targetParent) {
        newMap = reparentNode(newMap, editing.id, targetParent);
      }
      commitDoc(editing.filePath, map, newMap);
      delete draftRef.current[editing.id];
      setEditing(null);
      setGate(null);
    } catch (e) {
      setItems(null); // 코어 검증 실패 표시는 간단히 새로고침 유도 대신 무시
      console.warn('[concepts] edit failed:', e);
      setEditing(null);
      setGate(null);
      refresh();
    }
  }, [editing, items, gate, commitDoc, refresh]);

  // 노드 오른쪽의 p.N 버튼 → Viewer로 이동 후 원 페이지로 점프 (트리 전체화면 중이면 PDF도 전체화면)
  const openConcept = useCallback((c) => {
    setPendingConcept({ filePath: c.filePath, pageNumber: c.pageNumber, label: c.label, fullscreen: treeFull });
    navigate('/viewer');
  }, [navigate, treeFull]);

  // ── 문서별 그룹 (필터 반영) ──
  const groups = useMemo(() => {
    if (!items) return [];
    const out = [];
    const map = new Map();
    for (const c of items) {
      if (!map.has(c.filePath)) { map.set(c.filePath, []); out.push([c.filePath, map.get(c.filePath)]); }
      map.get(c.filePath).push(c);
    }
    return out;
  }, [items]);

  // 상태별 개수 (문서 카드용)
  const statusCounts = useCallback((list) => {
    const counts = { [STATUS.UNKNOWN]: 0, [STATUS.FUZZY]: 0, [STATUS.KNOWN]: 0, [STATUS.HOLD]: 0 };
    for (const c of list) {
      if (counts[c.status] != null) counts[c.status] += 1;
      else counts[STATUS.UNKNOWN] += 1;
    }
    return counts;
  }, []);

  // 디테일 뷰에 표시할 목록 (선택 문서 + 상태 필터)
  const detailItems = useMemo(
    () => (selectedFp && items
      ? items.filter((c) => c.filePath === selectedFp && (filter === 'all' || c.status === filter))
      : []),
    [selectedFp, items, filter]
  );

  // 편집 패널용 부모 옵션 (같은 문서 트리, 자기 자신 제외 — 가지별 optgroup)
  const parentGroups = useMemo(() => {
    if (!editing || !items) return [];
    const groups = [];
    const walk = (n, d, out) => {
      if (n.id === editing.id) return;
      out.push({ id: n.id, label: '\u00A0'.repeat(d * 2) + n.label });
      (n.children || []).forEach((ch) => walk(ch, d + 1, out));
    };
    for (const root of buildTree(docMap(items, editing.filePath))) {
      if (root.id === editing.id) continue;
      const out = [];
      walk(root, 0, out);
      if (out.length) groups.push({ label: root.label, options: out });
    }
    return groups;
  }, [editing, items]);

  // ── 트리 행 (재귀) — 기본=이름만 · 클릭=내용 · 더블클릭=편집 ──
  const renderRow = (node, fp, isLast = false) => {
    const record = { ...node, filePath: fp };
    const kids = node.children || [];
    const isCollapsed = collapsed.has(node.id);
    const hint = dropHint && dropHint.id === node.id ? dropHint.pos : null;
    return (
      <div key={node.id} className={'concepts__item' + (isLast ? ' concepts__item--last' : '')}>
        <div
          className={'concepts__row'
            + (dragId === node.id ? ' concepts__row--dragging' : '')
            + (hint ? ` concepts__row--drop-${hint}` : '')}
          data-node-id={node.id}
          onClick={(e) => {
            if (testPick) { startTest(node.id); return; }
            // 터치 더블 탭 감지 — dblclick이 없는 모바일/태블릿에서 편집 진입
            const now = Date.now();
            const last = lastTapRef.current;
            if (last.id === node.id && now - last.t < 350) {
              lastTapRef.current = { id: null, t: 0 };
              startEdit(record);
              return;
            }
            lastTapRef.current = { id: node.id, t: now };
            toggleExpand(node.id, e.currentTarget);
          }}
          onDoubleClick={() => { if (!testPick) startEdit(record); }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', node.id);
            e.dataTransfer.effectAllowed = 'move';
            setDragId(node.id);
          }}
          onDragOver={(e) => {
            if (!dragId || dragId === node.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const r = e.currentTarget.getBoundingClientRect();
            const rel = (e.clientY - r.top) / r.height;
            const pos = rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'inside';
            setDropHint((prev) => (prev && prev.id === node.id && prev.pos === pos ? prev : { id: node.id, pos }));
          }}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData('text/plain');
            const r = e.currentTarget.getBoundingClientRect();
            const rel = (e.clientY - r.top) / r.height;
            const pos = rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'inside';
            setDragId(null);
            setDropHint(null);
            if (id && id !== node.id) onDropNode(id, node.id, pos);
          }}
          onDragEnd={() => { setDragId(null); setDropHint(null); }}
        >
          {kids.length > 0 ? (
            <button
              className="concepts__toggle"
              onClick={(e) => { e.stopPropagation(); toggleCollapse(node.id); }}
              title={isCollapsed ? 'Expand children' : 'Collapse children'}
            >{isCollapsed ? '▸' : '▾'}</button>
          ) : (
            <span className="concepts__toggle-spacer" />
          )}
          <span
            className="concepts__status"
            style={{ background: STATUS_COLORS[node.status] }}
            title={`Status: ${STATUS_LABELS[node.status]}`}
          />
          <button
            className="concepts__label"
            title={node.summary || 'Click for details · double-click to edit'}
          >
            <span className="concepts__name">{node.label}</span>
          </button>
          <button
            className="concepts__page"
            onClick={(e) => { e.stopPropagation(); openConcept(record); }}
            title={`Go to source page ${node.pageNumber}`}
          >p.{node.pageNumber}</button>
        </div>
        {addingChild && addingChild.id === node.id && (
          <div className="concepts__add-child">
            <input
              autoFocus
              placeholder="Child concept…"
              title="Enter = add · Esc = cancel"
              value={childLabel}
              onChange={(e) => setChildLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitChild();
                if (e.key === 'Escape') { setAddingChild(null); setChildLabel(''); }
              }}
            />
            <button
              className="concepts__add-child-cancel"
              title="Cancel"
              aria-label="Cancel"
              onClick={() => { setAddingChild(null); setChildLabel(''); }}
            >✕</button>
          </div>
        )}
        {editing && editing.id === node.id && (
          <div
            className="concepts__editor concepts__editor--inline"
            data-edit-id={node.id}
            onKeyDown={(e) => { if (e.key === 'Escape') closeEditor(); }}
          >
            <input
              autoFocus
              className="concepts__editor-label"
              placeholder="Concept name"
              value={editing.label}
              onChange={(e) => setEditing((v) => ({ ...v, label: e.target.value }))}
            />
            <div className="concepts__editor-clear">
              {CLEAR_KEYS.map((k) => (
                <div className="concepts__editor-clear-row" key={k}>
                  <label className="concepts__editor-clear-label">{k}</label>
                  <textarea
                    className="concepts__editor-clear-input"
                    rows={2}
                    placeholder={CLEAR_PLACEHOLDERS[k]}
                    value={editing.parts[k]}
                    onChange={(e) => updatePart(k, e.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="concepts__editor-row">
              <div className="concepts__editor-status">
                {REVIEW_PRIORITY.map((s) => (
                  <button
                    key={s}
                    className={'concepts__filter concepts__filter--swatch' + (editing.status === s ? ' concepts__filter--active' : '')}
                    style={{ background: STATUS_COLORS[s] }}
                    onClick={() => setEditing((v) => ({ ...v, status: s }))}
                    title={STATUS_LABELS[s]}
                    aria-label={STATUS_LABELS[s]}
                  />
                ))}
              </div>
              <input
                className="concepts__editor-page"
                type="number"
                min={1}
                value={editing.pageNumber}
                onChange={(e) => setEditing((v) => ({ ...v, pageNumber: Number(e.target.value) || 1 }))}
                title="Source page"
              />
              <select
                className="concepts__editor-parent"
                value={editing.parent}
                onChange={(e) => setEditing((v) => ({ ...v, parent: e.target.value }))}
                title="Parent concept"
              >
                <option value="">— top level —</option>
                {parentGroups.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="concepts__editor-actions">
              <button className="concepts__editor-child" onClick={() => { closeEditor(); startAddChild(record); }}>＋ Add child</button>
              <button className="concepts__editor-delete" onClick={() => { closeEditor(); removeItem(record); }}>× Delete</button>
              {gate && gate.id === editing.id && (
                <span className={'concepts__editor-gate' + (!gateLocked ? ' concepts__editor-gate--ok' : '')}>
                  {gateRemainingMs > 0
                    ? `Save unlocks in ${fmtMs(gateRemainingMs)} — keep studying`
                    : gateFilled < STUDY_GATE_MIN_SECTIONS
                      ? `Fill at least ${STUDY_GATE_MIN_SECTIONS - gateFilled} more section${STUDY_GATE_MIN_SECTIONS - gateFilled > 1 ? 's' : ''} to save`
                      : 'Ready — you can save'}
                </span>
              )}
              <span className="concepts__editor-spacer" />
              <button className="concepts__cancel" onClick={closeEditor}>Cancel</button>
              <button className="concepts__save" onClick={saveEdit} disabled={gateLocked}>Save</button>
            </div>
          </div>
        )}
        {kids.length > 0 && !isCollapsed && (
          <div className="concepts__children">
            {kids.map((child, i) => renderRow(child, fp, i === kids.length - 1))}
          </div>
        )}
      </div>
    );
  };

  // ── 🧠 Test 모드 파생 데이터 (비파괴) ──
  const testDocMap = useMemo(
    () => (selectedFp && items ? docMap(items, selectedFp) : {}),
    [selectedFp, items]
  );

  const testScope = useMemo(() => {
    if (!test) return [];
    return test.retryIds || test.blankIds || [];
  }, [test]);

  const testRoots = useMemo(() => {
    if (!test || test.retryIds) return null;
    const roots = buildTree(testDocMap);
    if (!test.rootId) return roots;
    const sub = findTreeNode(roots, test.rootId);
    return sub ? [sub] : [];
  }, [test, testDocMap]);

  // 빈 노드 완료 여부 — A(라벨만)는 라벨 필수, B(deep)는 요약까지(원 요약 있을 때)
  const testNodeDone = useCallback((id) => {
    const a = test.answers[id] || {};
    if (!(a.label || '').trim()) return false;
    if (test.type !== 'deep') return true;
    const hasSum = String(testDocMap[id]?.summary || '').trim();
    return !hasSum || !!(a.summary || '').trim();
  }, [test, testDocMap]);

  const answeredCount = test ? testScope.filter(testNodeDone).length : 0;

  // 라운드 종료 채점 — 정답은 여기서 처음 공개 (라운드 중 숨김)
  const finishTest = useCallback(() => {
    setTest((t) => {
      if (!t || t.scored) return t;
      const missed = testScope.filter((id) => {
        const a = t.answers[id] || {};
        const labelOk = norm(testDocMap[id]?.label) === norm(a.label);
        if (t.type !== 'deep') return !labelOk; // A — 라벨만
        const sumOk = (a.summary || '').trim() === String(testDocMap[id]?.summary || '').trim();
        return !labelOk || !sumOk; // B — 라벨+요약
      });
      return { ...t, scored: true, missed };
    });
  }, [testScope, testDocMap]);

  const retryTest = useCallback(() => {
    setTest((t) => (t ? {
      type: t.type, rootId: t.rootId, blankIds: t.blankIds,
      answers: {}, scored: false, missed: [], retryIds: t.missed,
    } : t));
    setTestInput(null);
    setTestText('');
  }, []);

  // 전부 채워지면 자동 채점
  useEffect(() => {
    if (!test || test.scored || testScope.length === 0) return;
    if (testScope.every(testNodeDone)) finishTest();
  }, [test, testScope, testNodeDone, finishTest]);

  // ── 🧠 Test 행 — 빈 노드는 라벨+요약을 채우고, 나머지 노드는 단서로 유지 ──
  const renderTestRow = (node, fp, isLast = false) => {
    if (!node) return null;
    const kids = node.children || [];
    const blanked = (test.retryIds || test.blankIds || []).includes(node.id);
    const ans = test.answers[node.id] || {};
    const labelText = ans.label || '';
    const sumText = ans.summary || '';
    if (!blanked) {
      // 단서 노드 — 라벨만 보여줌 (요약은 빈 노드 채점에만 사용)
      return (
        <div key={node.id} className={'concepts__item' + (isLast ? ' concepts__item--last' : '')}>
          <div className="concepts__row concepts__row--test">
            <span className="concepts__toggle-spacer" />
            <span className="concepts__status" style={{ background: STATUS_COLORS[node.status] }} />
            <span className="concepts__name">{node.label}</span>
          </div>
          {kids.length > 0 && (
            <div className="concepts__children">
              {kids.map((ch, i) => renderTestRow(ch, fp, i === kids.length - 1))}
            </div>
          )}
        </div>
      );
    }
    const labelOk = test.scored && norm(labelText) === norm(node.label);
    const sumOk = test.scored && sumText.trim() === String(node.summary || '').trim();
    const ok = test.scored && labelOk && (test.type !== 'deep' || sumOk);
    const cls = 'concepts__row concepts__row--test'
      + (test.scored
        ? (ok ? ' concepts__row--correct' : ' concepts__row--wrong')
        : (labelText ? ' concepts__row--answered' : ' concepts__row--blank'));
    return (
      <div key={node.id} className={'concepts__item' + (isLast ? ' concepts__item--last' : '')}>
        <div className={cls} onClick={() => beginAnswer(node.id)}>
          <span className="concepts__toggle-spacer" />
          <span className="concepts__status" style={{ background: STATUS_COLORS[node.status] }} />
          {test.scored ? (
            <>
              <span className={'concepts__test-mark' + (ok ? ' concepts__test-mark--ok' : ' concepts__test-mark--no')}>
                {ok ? '✓' : '✗'}
              </span>
              <span className="concepts__test-label">
                <span className="concepts__name">{node.label}</span>
                {!labelOk && <span className="concepts__test-you">you: {labelText || '—'}</span>}
              </span>
            </>
          ) : (
            <span className="concepts__name">{labelText}</span>
          )}
        </div>
        {testInput === node.id && !test.scored && (
          <div className="concepts__add-child concepts__test-input">
            <input
              autoFocus
              placeholder="Recall the label…"
              title="Enter = answer · Esc = cancel"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAnswer();
                if (e.key === 'Escape') { setTestInput(null); setTestText(''); }
              }}
            />
            <button
              className="concepts__add-child-cancel"
              title="Cancel"
              aria-label="Cancel"
              onClick={() => { setTestInput(null); setTestText(''); }}
            >✕</button>
          </div>
        )}
        {test.type === 'deep' && !test.scored && (
          <textarea
            className="concepts__test-detail-input"
            rows={4}
            placeholder={'Core: …\nLink: …\nExample: …\nAntithesis: …\nRestate: …'}
            value={sumText}
            onChange={(e) => setTest((t) => (t ? {
              ...t,
              answers: { ...t.answers, [node.id]: { ...(t.answers[node.id] || {}), summary: e.target.value } },
            } : t))}
          />
        )}
        {test.type === 'deep' && test.scored && (
          <div className="concepts__test-detail">
            <div className="concepts__test-detail-answer">{node.summary}</div>
            {!sumOk && (
              <div className="concepts__test-detail-you">
                <span className="concepts__test-detail-you-label">You wrote</span>
                <span>{sumText || '—'}</span>
              </div>
            )}
          </div>
        )}
        {kids.length > 0 && (
          <div className="concepts__children">
            {kids.map((ch, i) => renderTestRow(ch, fp, i === kids.length - 1))}
          </div>
        )}
      </div>
    );
  };

  const total = items ? items.length : 0;
  const unknownCount = items ? items.filter((c) => c.status === STATUS.UNKNOWN).length : 0;

  // 상태 필터 칩 (목록/디테일 공용)
  const filterChips = (
    <div className="concepts__filters">
      <button
        className={'concepts__filter' + (filter === 'all' ? ' concepts__filter--active' : '')}
        onClick={() => setFilter('all')}
      >All</button>
      {REVIEW_PRIORITY.map((s) => (
        <button
          key={s}
          className={'concepts__filter concepts__filter--swatch' + (filter === s ? ' concepts__filter--active' : '')}
          style={{ background: STATUS_COLORS[s] }}
          onClick={() => setFilter(filter === s ? 'all' : s)}
          title={STATUS_LABELS[s] + (s === STATUS.UNKNOWN ? ' — review first' : '')}
          aria-label={STATUS_LABELS[s]}
        />
      ))}
    </div>
  );

  return (
    <main className="concepts">
      <AppNav />

      {loadError ? (
        <div className="concepts__empty">Couldn't load concepts — check the server.</div>
      ) : items === null ? (
        <div className="concepts__empty">Loading…</div>
      ) : items.length === 0 ? (
        <>
          <div className="concepts__head">
            <h1 className="concepts__title">🧭 Concepts</h1>
          </div>
          <div className="concepts__empty">
            No concepts yet — open a PDF in the Viewer, pick 🧭 Concept and tap a page (or press N).
          </div>
        </>
      ) : selectedFp ? (
        // ── 디테일 뷰: 선택한 PDF 하나에 몰입 (전폭 트리) ──
        <>
          <div className="concepts__head">
            <button className="concepts__back" onClick={() => setSelectedFp(null)} title="Back to all documents">← All documents</button>
            <h1 className="concepts__title">📕 {docName(selectedFp)}</h1>
            {(() => {
              const list = items.filter((c) => c.filePath === selectedFp);
              const counts = statusCounts(list);
              return (
                <span className="concepts__count">
                  {list.length + (list.length === 1 ? ' concept' : ' concepts')}
                  {counts[STATUS.UNKNOWN] > 0 && <em className="concepts__unknown-count"> · {counts[STATUS.UNKNOWN]} to review</em>}
                </span>
              );
            })()}
            {!test && !testPick && filterChips}
            {!test && !testPick && items.some((c) => c.filePath === selectedFp) && (
              <button
                className="concepts__test-btn"
                onClick={() => { setTestType('label'); setTestPick(true); setExpandedId(null); setContentAnchor(null); }}
                title="A — every label is blanked; recall the labels only"
              >Test</button>
            )}
            {!test && !testPick && items.some((c) => c.filePath === selectedFp) && (
              <button
                className="concepts__test-btn"
                onClick={() => { setTestType('deep'); setTestPick(true); setExpandedId(null); setContentAnchor(null); }}
                title="B — some labels are blanked; recall each label and its CLEAR notes"
              >Deep test</button>
            )}
            {!test && !testPick && items.some((c) => c.filePath === selectedFp) && (
              <button
                className="concepts__test-btn"
                onClick={() => setTreeFull(true)}
                title="Fullscreen — zoomable concept tree"
              >⛶</button>
            )}
          </div>

          {test ? (
            // ── 🧠 Test 모드 (비파괴 — 정답은 라운드 끝까지 숨김) ──
            <>
              <div className="concepts__test-bar">
                <span className="concepts__test-bar-count">
                  {test.scored
                    ? `Score — ${testScope.length - (test.missed || []).length} / ${testScope.length}`
                    : `${test.type === 'deep' ? 'Deep test' : 'Test'} — ${answeredCount} / ${testScope.length} filled`}
                  {test.retryIds ? ' · round 2' : ''}
                </span>
                <span className="concepts__test-bar-actions">
                  {!test.scored
                    ? <button className="concepts__test-btn" onClick={finishTest}>Finish &amp; score</button>
                    : (test.missed && test.missed.length > 0)
                      ? <button className="concepts__test-btn" onClick={retryTest}>Retry missed ({test.missed.length})</button>
                      : null}
                  <button className="concepts__test-btn" onClick={exitTest}>Exit</button>
                </span>
              </div>
              <div className="concepts__list concepts__list--detail">
                <section className="concepts__group">
                  {testRoots
                    ? testRoots.map((root, i) => renderTestRow(root, selectedFp, i === testRoots.length - 1))
                    : (test.retryIds || []).map((id, i) => renderTestRow(testDocMap[id], selectedFp, i === test.retryIds.length - 1))}
                </section>
              </div>
            </>
          ) : (
            <>
              {testPick && (
                <div className="concepts__test-bar">
                  <span className="concepts__test-bar-count">
                    {testType === 'deep'
                      ? 'Deep test — tap a branch to test its labels and notes'
                      : 'Test — tap a branch to test its labels'}
                  </span>
                  <span className="concepts__test-bar-actions">
                    <button className="concepts__test-btn" onClick={() => startTest(null)}>Whole document</button>
                    <button className="concepts__test-btn" onClick={() => setTestPick(false)}>Cancel</button>
                  </span>
                </div>
              )}
              {detailItems.length === 0 ? (
                <div className="concepts__empty">No concepts match this filter.</div>
              ) : treeFull ? null : (
                <div className="concepts__list concepts__list--detail">
                  <section className="concepts__group">
                    {filter === 'all'
                      ? buildTree(docMap(items, selectedFp)).map((root) => renderRow(root, selectedFp))
                      : reviewQueue(docMap(items, selectedFp))
                        .filter((n) => n.status === filter)
                        .map((n) => renderRow({ ...n, children: [] }, selectedFp))}
                  </section>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        // ── 마스터 뷰: PDF 목록 — 터치하면 해당 문서에 몰입 ──
        <>
          <div className="concepts__head">
            <h1 className="concepts__title">🧭 Concepts</h1>
            <span className="concepts__count">
              {groups.length} document{groups.length === 1 ? '' : 's'} · {total} concept{total === 1 ? '' : 's'}
              {unknownCount > 0 && <em className="concepts__unknown-count"> · {unknownCount} to review</em>}
            </span>
          </div>
          <div className="concepts__docs">
            {groups.map(([fp, list]) => {
              const counts = statusCounts(list);
              return (
                <button
                  key={fp}
                  className="concepts__doc-card"
                  onClick={() => setSelectedFp(fp)}
                  title={`Open ${docName(fp)}`}
                >
                  <span className="concepts__doc-card-name">📕 {docName(fp)}</span>
                  <span className="concepts__doc-card-count">{list.length} concept{list.length === 1 ? '' : 's'}</span>
                  <span className="concepts__doc-card-stats">
                    {REVIEW_PRIORITY.map((s) => (
                      <span key={s} className={'concepts__doc-card-stat' + (s === STATUS.UNKNOWN && counts[s] > 0 ? ' concepts__doc-card-stat--review' : '')} title={STATUS_LABELS[s]}>
                        <span className="concepts__dot" style={{ background: STATUS_COLORS[s] }} /> {counts[s]}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {treeFull && !test && createPortal(
        <div className="concepts__fullscreen" ref={overlayRef}>
          <div className="concepts__fullscreen-bar">
            <span className="concepts__fullscreen-title">📕 {docName(selectedFp)}</span>
            <button className="concepts__test-btn" onClick={() => setTreeZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(1)))} title="Zoom out">−</button>
            <span className="concepts__fullscreen-zoom">{Math.round(treeZoom * 100)}%</span>
            <button className="concepts__test-btn" onClick={() => setTreeZoom((z) => Math.min(2.0, +(z + 0.1).toFixed(1)))} title="Zoom in">+</button>
            <button className="concepts__test-btn" onClick={() => setTreeZoom(1)} title="Reset zoom">1:1</button>
            <button className="concepts__test-btn" onClick={exitTreeFull} title="Exit fullscreen (Esc)">✕ Exit</button>
          </div>
          <div className="concepts__list concepts__list--detail concepts__fullscreen-scroll">
            <div style={{ width: `${treeZoom * 100}%` }}>
              <section
                className="concepts__group"
                style={{ transform: `scale(${treeZoom})`, transformOrigin: 'top left', width: `${100 / treeZoom}%` }}
              >
                {filter === 'all'
                  ? buildTree(docMap(items, selectedFp)).map((root) => renderRow(root, selectedFp))
                  : reviewQueue(docMap(items, selectedFp))
                    .filter((n) => n.status === filter)
                    .map((n) => renderRow({ ...n, children: [] }, selectedFp))}
              </section>
            </div>
          </div>
        </div>,
        document.body
      )}

      {contentAnchor && (() => {
        const node = (items || []).find((c) => c.id === contentAnchor.id);
        if (!node) return null;
        const parts = parseClear(node.summary);
        const pos = cardPos && cardPos.id === contentAnchor.id ? cardPos : contentAnchor;
        return createPortal(
          <div className="concepts__float-card" ref={cardRef} style={{ left: pos.left, top: pos.top }}>
            <div className="concepts__float-card-head">
              <span className="concepts__float-card-title">{node.label}</span>
              <button
                className="concepts__float-card-close"
                onClick={() => { setExpandedId(null); setContentAnchor(null); }}
                title="Close"
              >✕</button>
            </div>
            {node.summary
              ? (hasClearFormat(node.summary) ? (
                <div className="concepts__float-card-clear">
                  {CLEAR_KEYS.filter((k) => String(parts[k] || '').trim()).map((k) => (
                    <div className="concepts__float-card-sec" key={k}>
                      <span className="concepts__float-card-sec-label">{k}</span>
                      <span className="concepts__float-card-sec-text">{parts[k]}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="concepts__float-card-summary">{node.summary}</div>
              ))
              : <div className="concepts__float-card-empty">No notes yet — double-click to edit.</div>}
            <div className="concepts__float-card-foot">
              <button
                className="concepts__float-card-page"
                onClick={() => openConcept({ filePath: node.filePath, pageNumber: node.pageNumber, label: node.label })}
                title={`Go to source page ${node.pageNumber}`}
              >p.{node.pageNumber}</button>
            </div>
          </div>,
          document.body
        );
      })()}
    </main>
  );
}
