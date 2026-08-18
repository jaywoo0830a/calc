// ── 서버 API 클라이언트 — 푼/틀린 문제 전역 관리 ──────────────────────────────
// Vite dev / Caddy prod 모두 `/api` → API 서버로 프록시된다.
const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  /** 문제 목록 — { status?: 'solved'|'wrong', doc?: docId } */
  listProblems(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') qs.set(k, v);
    }
    const suffix = qs.toString() ? '?' + qs.toString() : '';
    return request('/problems' + suffix);
  },

  /** 문제 등록/상태 전환 (같은 선택은 서버에서 upsert) */
  saveProblem(body) {
    return request('/problems', { method: 'POST', body: JSON.stringify(body) });
  },

  updateProblem(id, patch) {
    return request('/problems/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  deleteProblem(id) {
    return request('/problems/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  /** 특정 문서의 모든 문제 삭제 */
  deleteProblemsByDoc(doc) {
    return request('/problems?doc=' + encodeURIComponent(doc), { method: 'DELETE' });
  },

  /** 전체 문제 삭제 */
  clearProblems() {
    return request('/problems', { method: 'DELETE' });
  },

  /** 특정 파일을 담은 아카이브 검색 — 최근 업로드 순 */
  findArchivesByFile(path) {
    return request('/archives/find?path=' + encodeURIComponent(path));
  },

  /** 찾아본 단어장 (vocab) */
  listVocab() {
    return request('/vocab');
  },
  recordVocab(word) {
    return request('/vocab', { method: 'POST', body: JSON.stringify({ word }) });
  },
  deleteVocab(word) {
    return request('/vocab/' + encodeURIComponent(word), { method: 'DELETE' });
  },
  clearVocab() {
    return request('/vocab', { method: 'DELETE' });
  },

  /** 나만의 의미 매핑 (1단어 → N개 별칭) */
  listAllVocabAliases() {
    return request('/vocab/aliases');
  },
  listVocabAliases(word) {
    return request('/vocab/' + encodeURIComponent(word) + '/aliases');
  },
  addVocabAlias(word, alias, example = '') {
    return request('/vocab/' + encodeURIComponent(word) + '/aliases', {
      method: 'POST',
      body: JSON.stringify({ alias, example }),
    });
  },
  deleteVocabAlias(word, alias) {
    return request('/vocab/' + encodeURIComponent(word) + '/aliases/' + encodeURIComponent(alias), {
      method: 'DELETE',
    });
  },
};
