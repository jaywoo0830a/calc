import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getAllConcepts, saveConcept, deleteConcept } from '../lib/storage.js';
import { setPendingConcept } from '../lib/conceptJump.js';
import { conceptsToMap } from '../components/PdfAnnotator.jsx';
import {
  updateNode, reparentNode, moveNode, deleteNode, buildTree,
  reviewQueue, STATUS, REVIEW_PRIORITY,
} from '../lib/conceptMap.js';

// ── 🧭 Concepts — 개념 노드 모아보기 (문서별 트리, 상태 필터, 클릭 → Viewer 점프) ──
// PDF 뷰어의 🧭 Concept 툴/단축키 N으로 만든 개념 노드를 전부 모아 보여준다.
// 노드만 훑으며 원 페이지로 점프 = 초고속 복습.

const docName = (fp) => String(fp || '').split('/').pop() || 'Document';

/** 같은 문서의 노드만 담은 core map */
function docMap(items, filePath) {
  return conceptsToMap((items || []).filter((c) => c.filePath === filePath));
}

export default function Concepts() {
  const [items, setItems] = useState(null);      // null = 로딩 중
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState('all');   // all | ○ | ◐ | ● | △
  const [editing, setEditing] = useState(null);  // { id, filePath, label, summary, status, parent, pageNumber }
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

  // 형제 사이 ▲▼ 이동
  const moveItem = useCallback((c, delta) => {
    const map = docMap(items, c.filePath);
    if (!map[c.id]) return;
    commitDoc(c.filePath, map, moveNode(map, c.id, delta));
  }, [items, commitDoc]);

  // 삭제 — 자식은 조부모로 자동 승격 (명세 §4.3)
  const removeItem = useCallback((c) => {
    const map = docMap(items, c.filePath);
    if (!map[c.id]) return;
    commitDoc(c.filePath, map, deleteNode(map, c.id));
  }, [items, commitDoc]);

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

  // 행 클릭 → Viewer로 이동 후 원 페이지로 점프
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
    return out.filter(([fp, list]) => {
      if (filter === 'all') return list.length > 0;
      return list.some((c) => c.status === filter);
    });
  }, [items, filter]);

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

  // ── 트리 행 (재귀) — 코어 노드에는 filePath가 없으므로 인자로 전달 ──
  const renderRow = (node, depth, fp) => {
    const record = { ...node, filePath: fp };
    return (
      <div key={node.id}>
        <div className="concepts__row" style={{ paddingLeft: `${0.4 + depth * 1.2}rem` }}>
          <button
            className="concepts__status"
            onClick={() => toggleStatus(record)}
            title={`Status ${node.status} — tap to cycle ○→◐→●→△`}
          >{node.status}</button>
          <button
            className="concepts__label"
            onClick={() => openConcept(record)}
            title={node.summary || `Go to source page ${node.pageNumber}`}
          >
            <span className="concepts__name">{node.label}</span>
            {node.summary && <span className="concepts__summary">{node.summary}</span>}
          </button>
          <span className="concepts__page">p.{node.pageNumber}</span>
          <span className="concepts__actions">
            <button title="Move up" onClick={() => moveItem(record, -1)}>▲</button>
            <button title="Move down" onClick={() => moveItem(record, 1)}>▼</button>
            <button title="Edit" onClick={() => startEdit(record)}>✏️</button>
            <button title="Delete (children are kept)" onClick={() => removeItem(record)}>×</button>
          </span>
        </div>
        {(node.children || []).map((child) => renderRow(child, depth + 1, fp))}
      </div>
    );
  };

  const total = items ? items.length : 0;
  const unknownCount = items ? items.filter((c) => c.status === STATUS.UNKNOWN).length : 0;

  return (
    <main className="concepts">
      <nav className="calculator__nav">
        <Link to="/" className="calculator__nav-tab">Calc</Link>
        <Link to="/viewer" className="calculator__nav-tab">Viewer</Link>
        <Link to="/playground" className="calculator__nav-tab">Three.js</Link>
        <Link to="/math" className="calculator__nav-tab">Math Space</Link>
        <Link to="/fields" className="calculator__nav-tab">Fields</Link>
        <Link to="/units" className="calculator__nav-tab">Units</Link>
        <Link to="/relation" className="calculator__nav-tab">Relation</Link>
        <Link to="/problems" className="calculator__nav-tab">Problems</Link>
        <span className="calculator__nav-tab calculator__nav-tab--active">Concepts</span>
        <Link to="/vocab" className="calculator__nav-tab">Vocab</Link>
      </nav>

      <div className="concepts__head">
        <h1 className="concepts__title">🧭 Concepts</h1>
        <span className="concepts__count">
          {items ? total + (total === 1 ? ' concept' : ' concepts') : '…'}
          {unknownCount > 0 && <em className="concepts__unknown-count"> · {unknownCount} to review (○)</em>}
        </span>
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
              title={s === STATUS.UNKNOWN ? '모름 — 최우선 복습' : s === STATUS.FUZZY ? '애매' : s === STATUS.KNOWN ? '이해' : '보류'}
            >{s}</button>
          ))}
        </div>
      </div>

      {/* 편집 패널 */}
      {editing && (
        <div className="concepts__editor">
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
                >{s}</button>
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
            <button className="concepts__save" onClick={saveEdit}>Save</button>
            <button className="concepts__cancel" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {loadError ? (
        <div className="concepts__empty">Couldn't load concepts — check the server.</div>
      ) : items === null ? (
        <div className="concepts__empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="concepts__empty">
          No concepts yet — open a PDF in the Viewer, pick 🧭 Concept and tap a page (or press N).
        </div>
      ) : groups.length === 0 ? (
        <div className="concepts__empty">No concepts match this filter.</div>
      ) : (
        <div className="concepts__list">
          {groups.map(([fp, list]) => {
            const map = docMap(items, fp);
            return (
              <section key={fp} className="concepts__group">
                <header className="concepts__doc">
                  <span>📕 {docName(fp)}</span>
                  <span className="concepts__doc-count">{list.length}</span>
                </header>
                {filter === 'all'
                  ? buildTree(map).map((root) => renderRow(root, 0, fp))
                  : reviewQueue(map).filter((n) => n.status === filter).map((n) => renderRow({ ...n, children: [] }, 0, fp))}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
