import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import AppNav from '../components/AppNav.jsx';
import { getAllConcepts, saveConcept, deleteConcept } from '../lib/storage.js';
import { setPendingConcept } from '../lib/conceptJump.js';
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

  // 선택한 문서의 개념이 전부 사라지면(삭제 등) 목록 뷰로 복귀
  useEffect(() => {
    if (selectedFp && items && !items.some((c) => c.filePath === selectedFp)) setSelectedFp(null);
  }, [selectedFp, items]);

  // 문서/필터가 바뀌면 열려 있던 내용·편집·자식 추가 UI를 닫는다
  useEffect(() => {
    setExpandedId(null);
    setEditing(null);
    setAddingChild(null);
    setChildLabel('');
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

  // 상태 순환 ○ → ◐ → ● → △
  const toggleStatus = useCallback((c) => {
    const map = docMap(items, c.filePath);
    const node = map[c.id];
    if (!node) return;
    const idx = REVIEW_PRIORITY.indexOf(node.status);
    const next = REVIEW_PRIORITY[(idx < 0 ? 0 : idx + 1) % REVIEW_PRIORITY.length];
    commitDoc(c.filePath, map, updateNode(map, c.id, { status: next }));
  }, [items, commitDoc]);

  // 삭제 — 자식은 조부모로 자동 승격 (명세 §4.3)
  const removeItem = useCallback((c) => {
    const map = docMap(items, c.filePath);
    if (!map[c.id]) return;
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

  // 행 클릭 → 내용 펼침/접힘 (아코디언 — 한 번에 하나만)
  const toggleExpand = useCallback((id) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

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

  const startEdit = useCallback((c) => {
    setEditing({
      id: c.id, filePath: c.filePath, label: c.label || '', summary: c.summary || '',
      status: c.status || STATUS.UNKNOWN, parent: c.parentId || '',
      pageNumber: Number(c.pageNumber) || 1,
    });
  }, []);

  const saveEdit = useCallback(() => {
    if (!editing) return;
    const map = docMap(items, editing.filePath);
    if (!map[editing.id]) { setEditing(null); return; }
    try {
      let newMap = updateNode(map, editing.id, {
        label: editing.label, summary: editing.summary,
        status: editing.status, pageNumber: Number(editing.pageNumber) || 1,
      });
      const targetParent = editing.parent ? String(editing.parent) : null;
      if (newMap[editing.id].parent !== targetParent) {
        newMap = reparentNode(newMap, editing.id, targetParent);
      }
      commitDoc(editing.filePath, map, newMap);
      setEditing(null);
    } catch (e) {
      setItems(null); // 코어 검증 실패 표시는 간단히 새로고침 유도 대신 무시
      console.warn('[concepts] edit failed:', e);
      setEditing(null);
      refresh();
    }
  }, [editing, items, commitDoc, refresh]);

  // 노드 오른쪽의 p.N 버튼 → Viewer로 이동 후 원 페이지로 점프
  const openConcept = useCallback((c) => {
    setPendingConcept({ filePath: c.filePath, pageNumber: c.pageNumber, label: c.label });
    navigate('/viewer');
  }, [navigate]);

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

  // 편집 패널용 부모 옵션 (같은 문서 트리, 자기 자신 제외)
  const parentOptions = useMemo(() => {
    if (!editing || !items) return [];
    const out = [];
    const walk = (n, d) => {
      if (n.id !== editing.id) out.push({ id: n.id, label: '— '.repeat(d) + n.label });
      (n.children || []).forEach((ch) => walk(ch, d + 1));
    };
    buildTree(docMap(items, editing.filePath)).forEach((r) => walk(r, 0));
    return out;
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
          onClick={() => toggleExpand(node.id)}
          onDoubleClick={() => startEdit(record)}
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
          <button
            className="concepts__status"
            style={{ background: STATUS_COLORS[node.status] }}
            onClick={(e) => { e.stopPropagation(); toggleStatus(record); }}
            title={`Status: ${STATUS_LABELS[node.status]} — tap to change`}
            aria-label={`Status: ${STATUS_LABELS[node.status]}`}
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
        {expandedId === node.id && (
          <div className="concepts__content">
            {node.summary
              ? <p className="concepts__content-summary">{node.summary}</p>
              : <p className="concepts__content-empty">No notes yet — double-click to edit.</p>}
          </div>
        )}
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
          </div>
        )}
        {editing && editing.id === node.id && (
          <div className="concepts__editor concepts__editor--inline" data-edit-id={node.id}>
            <input
              autoFocus
              className="concepts__editor-label"
              placeholder="Concept name"
              value={editing.label}
              onChange={(e) => setEditing((v) => ({ ...v, label: e.target.value }))}
            />
            <textarea
              className="concepts__editor-summary"
              rows={2}
              placeholder="Summary (one sentence)…"
              value={editing.summary}
              onChange={(e) => setEditing((v) => ({ ...v, summary: e.target.value }))}
            />
            <div className="concepts__editor-row">
              <div className="concepts__editor-status">
                {REVIEW_PRIORITY.map((s) => (
                  <button
                    key={s}
                    className={'concepts__filter' + (editing.status === s ? ' concepts__filter--active' : '')}
                    onClick={() => setEditing((v) => ({ ...v, status: s }))}
                    title={STATUS_LABELS[s]}
                    aria-label={STATUS_LABELS[s]}
                  >
                    <span className="concepts__dot" style={{ background: STATUS_COLORS[s] }} />
                  </button>
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
                {parentOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="concepts__editor-actions">
              <button className="concepts__editor-child" onClick={() => { setEditing(null); startAddChild(record); }}>＋ Add child</button>
              <button className="concepts__editor-delete" onClick={() => { setEditing(null); removeItem(record); }}>× Delete</button>
              <span className="concepts__editor-spacer" />
              <button className="concepts__cancel" onClick={() => setEditing(null)}>Cancel</button>
              <button className="concepts__save" onClick={saveEdit}>Save</button>
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
          className={'concepts__filter' + (filter === s ? ' concepts__filter--active' : '')}
          onClick={() => setFilter(filter === s ? 'all' : s)}
          title={STATUS_LABELS[s] + (s === STATUS.UNKNOWN ? ' — review first' : '')}
          aria-label={STATUS_LABELS[s]}
        >
          <span className="concepts__dot" style={{ background: STATUS_COLORS[s] }} />
        </button>
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
            {filterChips}
          </div>

          {detailItems.length === 0 ? (
            <div className="concepts__empty">No concepts match this filter.</div>
          ) : (
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
    </main>
  );
}
