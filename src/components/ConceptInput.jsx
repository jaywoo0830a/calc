import { conceptOptionGroups } from '../lib/conceptMap.js';

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
      <div className="concept-input__parents" role="radiogroup" aria-label="Parent concept">
        <button
          type="button"
          className={'concept-input__parent-chip' + (parent === '' ? ' concept-input__parent-chip--active' : '')}
          onClick={() => onParentChange('')}
        >
          ⊤ Top level
        </button>
        {conceptOptionGroups(concepts).flatMap((g) => g.options).map((o) => {
          const depth = (o.label.match(/^\u00A0*/) || [''])[0].length / 2;
          const clean = o.label.replace(/^\u00A0+/, '');
          return (
            <button
              key={o.id}
              type="button"
              className={'concept-input__parent-chip' + (parent === o.id ? ' concept-input__parent-chip--active' : '')}
              style={{ paddingLeft: `calc(${0.5 + depth * 0.625}rem + 2px)` }}
              onClick={() => onParentChange(o.id)}
              title={clean}
            >
              {clean}
            </button>
          );
        })}
      </div>
      <div className="concept-input__actions">
        <button className="concept-input__add" onClick={onSubmit}>Add</button>
        <button className="concept-input__cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
