import { conceptOptionList } from '../lib/conceptMap.js';

/**
 * 🧭 ConceptInput — 재사용 가능한 개념 입력 박스
 * 라벨 입력 + 부모 선택(계층 들여쓰기 옵션) + Add/Cancel.
 * PDF 캡처 바(고정 위치)와 Concepts 탭에서 공용으로 사용한다.
 */
export default function ConceptInput({
  label,
  onLabelChange,
  parent,
  onParentChange,
  concepts = [],
  onSubmit,
  onCancel,
  placeholder = 'Concept name…',
}) {
  return (
    <div className="concept-input">
      <input
        autoFocus
        className="concept-input__label"
        placeholder={placeholder}
        value={label}
        onChange={(e) => onLabelChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <select
        className="concept-input__parent"
        value={parent}
        onChange={(e) => onParentChange(e.target.value)}
        title="Parent concept"
      >
        <option value="">— top level —</option>
        {conceptOptionList(concepts).map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
      <div className="concept-input__actions">
        <button className="concept-input__add" onClick={onSubmit}>Add</button>
        <button className="concept-input__cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
