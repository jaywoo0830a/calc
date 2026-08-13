// ── 영영사전 데이터 레이어 — Wiktionary REST API (무료, 키 불필요, CORS 지원) ──
// WordLookup 카드가 사용하는 공통 형태로 정규화한다:
// { word, phonetic, audio, meanings: [{ partOfSpeech, definitions: [{ definition, example }] }], origin }
// 또는 { notFound: true } / { error: '...' }
// ⚠️ Wiktionary는 정의 텍스트에 위키 마크업([[…]], {{…}})이 섞여 있어 정리가 필요하다.

export const PROVIDER_LABEL = 'Wiktionary';

const API_URL = (word) =>
  `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;

// 단일 영어 단어 또는 짧은 영어 구문 (아포스트로피/하이픈/공백 허용)
const WORD_RE = /^[A-Za-z][A-Za-z' -]{0,49}$/;

/** 사전 조회 대상인지 판별 (단어/짧은 구문만 — 그 외엔 절대 트리거 안 됨) */
export function isCandidate(text) {
  if (!text) return false;
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 50 && WORD_RE.test(t);
}

/** HTML 엔티티(&#39;, &amp; 등) 디코드 */
function decodeEntities(text) {
  const el = document.createElement('span');
  el.innerHTML = text;
  return el.textContent;
}

/**
 * 위키 마크업/HTML 정리 — REST가 정의에 <span>/<b>/<a> 등 HTML을 섞어 반환하므로
 * ① HTML 태그를 벗겨 텍스트만 취한 뒤 ② [[target|label]]→label, [[target]]→target,
 * ③ {{template}} 제거, ④ 공백 정리.
 */
function cleanWikitext(text) {
  let t = String(text || '');
  t = decodeEntities(t); // 태그 제거 + 엔티티 디코드 (textContent)
  t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  t = t.replace(/\[\[([^\]]*)\]\]/g, '$1');
  t = t.replace(/\{\{[^{}]*\}\}/g, '');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

/** 단어 정의 조회 — Wiktionary REST API 응답을 표시용 형태로 정규화 */
export async function lookupDefinition(word) {
  try {
    const res = await fetch(API_URL(word));
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const senses = (json && json.en) || []; // 영어 뜻풀이 (언어 코드 키)
    if (!Array.isArray(senses) || !senses.length) return { notFound: true };

    const meanings = senses.slice(0, 8).map((s) => ({
      partOfSpeech: s.partOfSpeech || '',
      definitions: (s.definitions || [])
        .map((d) => ({
          definition: cleanWikitext(d.definition),
          example: cleanWikitext((d.examples && d.examples[0] && d.examples[0].text) || ''),
        }))
        .filter((d) => d.definition) // 빈 정의(usage label만 있는 sense) 제거
        .slice(0, 3),
    })).filter((m) => m.definitions.length > 0);

    if (!meanings.length) return { notFound: true };
    return {
      word,
      phonetic: '', // Wiktionary REST 정의 엔드포인트는 발음/음성/어원 미제공
      audio: '',
      meanings,
      origin: '',
    };
  } catch (e) {
    return { error: e.message || 'Network error' };
  }
}
