/**
 * 🧭 ConceptParentPicker — 부모 선택 세로 스크롤 리스트 (select 대체)
 * ConceptInput(PDF 캡처 바)과 Concepts 편집기에서 공용.
 * groups: [{ label, options: [{ id, label(들여쓰기 nbsp 포함) }] }]
 * value: '' = Top level.
 */
export default function ConceptParentPicker({ value, groups = [], onChange }) {
  return (
    <div className="concept-input__parents" role="radiogroup" aria-label="Parent concept">
      <button
        type="button"
        className={'concept-input__parent-chip' + (value === '' ? ' concept-input__parent-chip--active' : '')}
        onClick={() => onChange('')}
      >
        ⊤ Top level
      </button>
      {groups.flatMap((g) => g.options).map((o) => {
        const depth = (o.label.match(/^\u00A0*/) || [''])[0].length / 2;
        const clean = o.label.replace(/^\u00A0+/, '');
        return (
          <button
            key={o.id}
            type="button"
            className={'concept-input__parent-chip' + (value === o.id ? ' concept-input__parent-chip--active' : '')}
            style={{ paddingLeft: `calc(${0.5 + depth * 0.625}rem + 2px)` }}
            onClick={() => onChange(o.id)}
            title={clean}
          >
            {clean}
          </button>
        );
      })}
    </div>
  );
}
