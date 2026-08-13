// ── 푼/틀린 문제 전역 저장소 (SQLite) ────────────────────────────────────────
// 선택한 문제 텍스트를 docId + ref + text 해시로 식별해 upsert 한다.
// 같은 선택(문제)은 항상 같은 id → 중복 없이 상태만 갱신.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

// ZIP 아카이브 파일 저장 위치 (서버 저장 — 모든 기기에서 같은 라이브러리)
export const archivesDir = join(dataDir, 'archives');
mkdirSync(archivesDir, { recursive: true });

const db = new Database(join(dataDir, 'problems.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS problems (
    id          TEXT PRIMARY KEY,              -- sha256(docId|ref|text) 앞 32자
    doc_id      TEXT NOT NULL,
    doc_path    TEXT NOT NULL DEFAULT '',
    ref         TEXT NOT NULL DEFAULT '',      -- PDF: 페이지 번호, markdown: ''
    text        TEXT NOT NULL,                 -- 문제 발췌문
    status      TEXT NOT NULL DEFAULT 'wrong' CHECK (status IN ('solved','wrong')),
    wrong_count INTEGER NOT NULL DEFAULT 0,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_problems_doc    ON problems(doc_id);
  CREATE INDEX IF NOT EXISTS idx_problems_status ON problems(status);

  CREATE TABLE IF NOT EXISTS archives (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

// ── 레거시 정리 (호환성 불필요) ──────────────────────────────────────────
// 문제는 반드시 ref(마크다운 JSON 좌표 또는 PDF 페이지 번호)를 가져야 점프 가능.
// 옛 방식(좌표 미저장, ref='')으로 생긴 문제는 어차피 점프할 수 없으므로
// 서버 시작 시 제거한다 — 새 흐름(RangeSelect가 선택 시점에 ref 저장)에서는
// ref 없는 문제가 생성되지 않는다. (PDF 문제는 ref=페이지 번호라 영향 없음)
db.exec(`DELETE FROM problems WHERE ref = '' OR ref IS NULL`);

/** 텍스트 정규화 — 공백/줄바꿈 차이로 인한 중복 레코드 방지 */
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * 같은 선택(문제)은 항상 같은 id → docId + text 기준.
 * (ref는 저장 시마다 최신으로 갱신 — ref가 달라져도 중복 행이 생기지 않는다)
 */
export function problemId(docId, text) {
  return createHash('sha256').update(`${docId}|${normalizeText(text)}`).digest('hex').slice(0, 32);
}

export const problems = {
  list({ status, doc } = {}) {
    const clauses = [];
    const params = {};
    if (status) { clauses.push('status = @status'); params.status = status; }
    if (doc) { clauses.push('doc_id = @doc'); params.doc = doc; }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    return db.prepare(`SELECT * FROM problems ${where} ORDER BY updated_at DESC`).all(params);
  },

  upsert({ docId, docPath = '', ref = '', text, status = 'wrong' }) {
    const normalizedText = normalizeText(text);
    const id = problemId(docId, normalizedText);
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM problems WHERE id = ?').get(id);

    if (existing) {
      const becameWrong = status === 'wrong' && existing.status !== 'wrong';
      db.prepare(`
        UPDATE problems
        SET status      = @status,
            doc_path    = @docPath,
            ref         = @ref,      -- 최신 좌표로 항상 갱신
            wrong_count = wrong_count + @becameWrong,
            attempts    = attempts + 1,
            updated_at  = @now
        WHERE id = @id
      `).run({ id, status, docPath, ref, becameWrong: becameWrong ? 1 : 0, now });
      return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
    }

    // 예전 id 규칙(docId|ref|text)으로 생긴 중복 행 정리 — 같은 문서+텍스트면 하나만 유지
    db.prepare('DELETE FROM problems WHERE doc_id = @docId AND text = @text AND id != @id')
      .run({ docId, text: normalizedText, id });

    db.prepare(`
      INSERT INTO problems (id, doc_id, doc_path, ref, text, status, wrong_count, attempts, created_at, updated_at)
      VALUES (@id, @docId, @docPath, @ref, @text, @status, @wrongCount, 1, @now, @now)
    `).run({
      id, docId, docPath, ref, text: normalizedText, status,
      wrongCount: status === 'wrong' ? 1 : 0,
      now,
    });
    return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
  },

  update(id, { status, attempts } = {}) {
    const existing = db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
    if (!existing) return null;
    const nextStatus = status ?? existing.status;
    // 상태가 실제로 바뀌면 한 번 더 풀었다고 간주 → attempts +1
    const statusChanged = nextStatus !== existing.status;
    const nextAttempts = attempts ?? (statusChanged ? existing.attempts + 1 : existing.attempts);
    const becameWrong = nextStatus === 'wrong' && existing.status !== 'wrong';
    db.prepare(`
      UPDATE problems
      SET status      = @status,
          wrong_count = wrong_count + @becameWrong,
          attempts    = @attempts,
          updated_at  = @now
      WHERE id = @id
    `).run({
      id,
      status: nextStatus,
      becameWrong: becameWrong ? 1 : 0,
      attempts: nextAttempts,
      now: new Date().toISOString(),
    });
    return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
  },

  remove(id) {
    db.prepare('DELETE FROM problems WHERE id = ?').run(id);
  },

  /** 특정 문서의 모든 문제 삭제 (재업로드/패치 후 정리용) */
  removeByDoc(docId) {
    db.prepare('DELETE FROM problems WHERE doc_id = ?').run(docId);
  },
};

/** ZIP 아카이브 메타데이터 — 실제 파일은 archivesDir/<id>.zip */
export const archives = {
  list() {
    return db.prepare('SELECT id, name, size, created_at AS savedAt FROM archives ORDER BY created_at DESC').all();
  },
  get(id) {
    return db.prepare('SELECT id, name FROM archives WHERE id = ?').get(id) || null;
  },
  create({ id, name, size }) {
    db.prepare('INSERT INTO archives (id, name, size, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, size, new Date().toISOString());
  },
  remove(id) {
    db.prepare('DELETE FROM archives WHERE id = ?').run(id);
  },
};
