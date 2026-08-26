import { useEffect, useMemo, useState } from 'react';
import AppLayout from '../components/AppLayout.jsx';
import {
  BASE_UNITS,
  UNITS,
  lookupUnit,
  parseUnitExpr,
  mergeUnits,
  formatDim,
  formatValue,
  prefixedValue,
  defineAlias,
  substituteDim,
  formatSubstitution,
  activeAliases,
} from '../lib/units.js';

// ── Units — 물리량 단위 분해·병합 치트시트 ───────────────────────
// · 심볼(또는 접두사+심볼) 입력 → 기저 단위로 분해: "N" → 1 kg·m·s⁻²
// · 식 입력 → 이름 붙은 단위로 병합: "kg·m/s²" → 1 N (10⁵ dyn)
// · 사용자 별칭(alias): speed = m/s 라고 정의하고 활성화하면 s²/m → s/speed 로 치환 표시
// · 별칭은 기본 비활성화 — 원하는 것만 켜서 적용한다.
// · 아래 치트시트에서 클릭하면 바로 분해해 본다.

const EXAMPLES = ['N', 'kW·h', 'MPa', 'kg·m/s²', 'J/s', 'eV'];

const GROUP_LABEL = { base: 'SI base units', derived: 'SI derived units', common: 'Common (non-SI)' };

const ALIAS_STORE = 'units_aliases';

function loadAliases() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALIAS_STORE) || '[]');
    // 구버전 저장분 마이그레이션 — enabled가 없으면 기본 비활성화
    return Array.isArray(raw) ? raw.map((a) => ({ ...a, enabled: !!a.enabled })) : [];
  } catch { return []; }
}

/** 입력 → 화면 상태 계산 (순수 함수 — 테스트하기 쉬운 구조 유지) */
export function buildUnitView(query, aliases = []) {
  const q = String(query || '').trim();
  if (!q) return { mode: 'idle' };

  // 조회/파싱은 모든 별칭 허용(명시적으로 입력한 경우), 치환은 활성화된 것만
  const enabled = activeAliases(aliases);

  const unit = lookupUnit(q, aliases);
  if (unit) {
    const total = unit.factor;
    const alternates = mergeUnits(unit.dim, total);
    const { terms, remainder } = substituteDim(unit.dim, enabled);
    const substitution = terms.length ? formatSubstitution(terms, remainder) : '';
    return { mode: 'decompose', query: q, unit, total, alternates, substitution };
  }

  try {
    const { factor, dim } = parseUnitExpr(q, aliases);
    const matches = mergeUnits(dim, factor);
    const { terms, remainder } = substituteDim(dim, enabled);
    const substitution = terms.length ? formatSubstitution(terms, remainder) : '';
    return { mode: 'merge', query: q, factor, dim, matches, substitution };
  } catch (e) {
    return { mode: 'error', query: q, message: e.message };
  }
}

export default function Units() {
  const [query, setQuery] = useState('');
  const [aliases, setAliases] = useState(loadAliases);
  const [aliasName, setAliasName] = useState('');
  const [aliasExpr, setAliasExpr] = useState('');
  const [aliasError, setAliasError] = useState('');

  useEffect(() => {
    try { localStorage.setItem(ALIAS_STORE, JSON.stringify(aliases)); } catch {}
  }, [aliases]);

  const view = useMemo(() => buildUnitView(query, aliases), [query, aliases]);

  const addAlias = () => {
    try {
      const a = defineAlias(aliasName, aliasExpr, aliases);
      setAliases((prev) => [...prev, a]);
      setAliasName('');
      setAliasExpr('');
      setAliasError('');
      setQuery(a.sym); // 바로 분해해 보여준다
    } catch (e) {
      setAliasError(e.message);
    }
  };

  const removeAlias = (sym) => setAliases((prev) => prev.filter((a) => a.sym !== sym));

  const toggleAlias = (sym) =>
    setAliases((prev) => prev.map((a) => (a.sym === sym ? { ...a, enabled: !a.enabled } : a)));

  return (
    <AppLayout className="units">

      <div className="units__head">
        <h1 className="units__title">⚖ Units</h1>
        <p className="units__subtitle">
          Decompose a named unit into base SI units — or merge an expression back into named units.
        </p>
      </div>

      <div className="units__panel">
        <input
          className="units__input"
          type="text"
          autoFocus
          spellCheck={false}
          placeholder="Type a unit or an expression — N · kW·h · kg·m/s² …"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        />
        <div className="units__examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="units__ex" onClick={() => setQuery(ex)}>{ex}</button>
          ))}
        </div>

        <div className="units__result">
          {view.mode === 'idle' && (
            <p className="units__idle">
              Try <strong>N</strong> (decompose) or <strong>kg·m/s²</strong> (merge).<br />
              SI prefixes work too: <strong>kN</strong>, <strong>µF</strong>, <strong>kWh</strong>.
            </p>
          )}

          {view.mode === 'decompose' && (
            <>
              <p className="units__headline">
                1 <strong>{view.query}</strong> = {formatValue(view.total)} {formatDim(view.unit.dim)}
              </p>
              {view.unit.prefixFactor !== 1 && (
                <p className="units__sub">
                  {view.query} = {formatValue(view.unit.prefixFactor)} {view.unit.baseSym} · {view.unit.name}
                </p>
              )}
              {view.substitution && view.unit.kind !== 'alias' && (
                <p className="units__sub">
                  <span className="units__alias-sub">= {view.substitution}</span>{' '}
                  <em className="units__via">(with aliases)</em>
                </p>
              )}
              <p className="units__name">
                {view.unit.name}
                {view.unit.kind === 'alias' ? ' — your alias' : view.unit.kind === 'base' ? ' — SI base unit' : view.unit.si ? ' — SI unit' : ' — non-SI unit'}
              </p>
              {view.alternates.length > 1 && (
                <div className="units__rows">
                  <span className="units__group-title">Same dimension ({formatDim(view.unit.dim)})</span>
                  {view.alternates.filter((a) => a.sym !== view.unit.baseSym && a.sym !== view.unit.sym).map((a) => {
                    const show = a.si ? prefixedValue(a.value, a.sym) : { sym: a.sym, value: formatValue(a.value) };
                    return (
                      <div key={a.sym} className="units__row">
                        <span className="units__row-val">{show.value} {show.sym}</span>
                        <span className="units__row-name">{a.name}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {view.mode === 'merge' && (
            <>
              <p className="units__headline">
                {view.query} <span className="units__arrow">=</span>{' '}
                {formatValue(view.factor)} {formatDim(view.dim)}
              </p>
              {view.substitution && view.substitution !== view.query.trim() && (
                <p className="units__sub">
                  <span className="units__alias-sub">= {view.substitution}</span>{' '}
                  <em className="units__via">(with aliases)</em>
                </p>
              )}
              {view.matches.length > 0 ? (
                <div className="units__rows">
                  <span className="units__group-title">Named units</span>
                  {view.matches.map((m) => {
                    const show = m.si ? prefixedValue(m.value, m.sym) : { sym: m.sym, value: formatValue(m.value) };
                    return (
                      <div key={m.sym} className="units__row">
                        <span className="units__row-val">{show.value} {show.sym}</span>
                        <span className="units__row-name">{m.name}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="units__idle">No named unit has this dimension — but the base-unit form above is exact.</p>
              )}
            </>
          )}

          {view.mode === 'error' && (
            <p className="units__error">Couldn't read “{view.query}” — {view.message}.</p>
          )}
        </div>
      </div>

      <div className="units__panel">
        <p className="units__hint">
          Aliases — define your own symbols (e.g., <strong>speed = m/s</strong>). New aliases are
          <strong> off</strong>; toggle them <strong>on</strong> to apply, so <strong>s²/m</strong> reads as{' '}
          <strong>s/speed</strong>.
        </p>
        <div className="units__alias-form">
          <input
            className="units__alias-name"
            type="text"
            placeholder="name (e.g. speed)"
            value={aliasName}
            onChange={(e) => setAliasName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addAlias(); }}
          />
          <span className="units__alias-eq">=</span>
          <input
            className="units__alias-expr"
            type="text"
            placeholder="m/s"
            value={aliasExpr}
            onChange={(e) => setAliasExpr(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addAlias(); }}
          />
          <button className="units__alias-add" onClick={addAlias}>Add</button>
        </div>
        {aliasError && <p className="units__error">{aliasError}</p>}
        {aliases.length > 0 && (
          <div className="units__rows">
            {aliases.map((a) => (
              <div key={a.sym} className={'units__row' + (a.enabled ? '' : ' units__row--off')}>
                <button
                  className={'units__alias-toggle' + (a.enabled ? ' units__alias-toggle--on' : '')}
                  onClick={() => toggleAlias(a.sym)}
                  title={a.enabled ? `Disable ${a.sym}` : `Enable ${a.sym}`}
                  aria-label={`Toggle alias ${a.sym}`}
                  aria-pressed={!!a.enabled}
                >
                  {a.enabled ? '✓' : '—'}
                </button>
                <span
                  className="units__row-val units__row-val--click"
                  role="button"
                  tabIndex={0}
                  onClick={() => setQuery(a.sym)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setQuery(a.sym); }}
                  title={`Decompose ${a.sym}`}
                >
                  {a.sym} = {a.expr}
                </span>
                <button className="units__alias-del" onClick={() => removeAlias(a.sym)} aria-label={`Delete alias ${a.sym}`}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="units__panel">
        <p className="units__hint">Cheat sheet — click any unit to decompose it.</p>
        {(['base', 'derived', 'common']).map((kind) => {
          const list = kind === 'base'
            ? BASE_UNITS.map((b) => ({ sym: b.sym, name: b.name, dim: { [b.sym]: 1 } }))
            : UNITS.filter((u) => u.kind === kind);
          return (
            <div key={kind} className="units__group">
              <span className="units__group-title">{GROUP_LABEL[kind]}</span>
              <div className="units__grid">
                {list.map((u) => (
                  <button
                    key={u.sym}
                    className="units__chip"
                    onClick={() => setQuery(u.sym)}
                    title={`${u.name} — ${formatDim(u.dim)}`}
                  >
                    <span className="units__chip-sym">{u.sym}</span>
                    <span className="units__chip-name">{u.name}</span>
                    <span className="units__chip-dim">{formatDim(u.dim)}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </AppLayout>
  );
}
