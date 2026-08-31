// ── 서버 API 클라이언트 — 푼/틀린 문제 전역 관리 ──────────────────────────────
// Vite dev / Caddy prod 모두 `/api` → API 서버로 프록시된다.
const BASE = '/api';

// 파괴적(DELETE) 요청용 세션 토큰 — 비밀번호 검증 성공 시 서버가 발급
let clearToken = null;

/** api 모듈 밖(storage.js 등)에서 토큰 헤더를 붙일 때 사용 */
export function getClearToken() {
  return clearToken;
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.method === 'DELETE' && clearToken) headers['X-Clear-Token'] = clearToken;
  const res = await fetch(BASE + path, { ...options, headers });
  if (!res.ok) {
    // 토큰 무효(서버 재시작 등)면 폐기 — 다음 파괴적 작업에서 다시 비밀번호 확인
    if (options.method === 'DELETE' && res.status === 401) clearToken = null;
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
  /** 파괴적 작업 승인 상태 — 세션 토큰 보유 여부 */
  hasClearToken() {
    return !!clearToken;
  },

  /** 📝 Practice — Three.js 탭 연습장 스니펫 */
  listPractice() {
    return request('/practice');
  },
  getPractice(id) {
    return request('/practice/' + encodeURIComponent(id));
  },
  savePractice(body) {
    return request('/practice', { method: 'POST', body: JSON.stringify(body) });
  },
  deletePractice(id) {
    return request('/practice/' + encodeURIComponent(id), { method: 'DELETE' });
  },
  execPractice(code, mode) {
    return request('/practice/exec', { method: 'POST', body: JSON.stringify({ code, mode }) });
  },

  /** 🧠 deep 테스트 섹션 의미 채점 — [{want, got}] → { scores: number[] } (서버 MiniLM) */
  scoreSections(pairs) {
    return request('/concepts/score', { method: 'POST', body: JSON.stringify({ pairs }) });
  },

  /** 🧮 To KaTeX — 드로잉 이미지(PNG base64)를 GLM-OCR로 LaTeX 변환 */
  mathOcr(imageBase64) {
    return request('/math-ocr', { method: 'POST', body: JSON.stringify({ image: imageBase64 }) });
  },

  /** 파괴적 작업용 비밀번호 검증 — 성공 시 세션 토큰 저장 (이후 같은 세션은 재입력 생략) */
  verifyClearPassword(password) {
    return request('/admin/verify', { method: 'POST', body: JSON.stringify({ password }) }).then((data) => {
      if (data && data.token) clearToken = data.token;
      return data;
    });
  },
};
