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
`);

/** 같은 선택(문제)은 항상 같은 id → 중복 없이 상태만 갱신 */
export function problemId(docId, ref, text) {
  return createHash('sha256').update(`${docId}|${ref}|${text}`).digest('hex').slice(0, 32);
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
    const id = problemId(docId, ref, text);
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM problems WHERE id = ?').get(id);

    if (existing) {
      const becameWrong = status === 'wrong' && existing.status !== 'wrong';
      db.prepare(`
        UPDATE problems
        SET status      = @status,
            wrong_count = wrong_count + @becameWrong,
            attempts    = attempts + 1,
            updated_at  = @now
        WHERE id = @id
      `).run({ id, status, becameWrong: becameWrong ? 1 : 0, now });
      return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
    }

    db.prepare(`
      INSERT INTO problems (id, doc_id, doc_path, ref, text, status, wrong_count, attempts, created_at, updated_at)
      VALUES (@id, @docId, @docPath, @ref, @text, @status, @wrongCount, 1, @now, @now)
    `).run({
      id, docId, docPath, ref, text, status,
      wrongCount: status === 'wrong' ? 1 : 0,
      now,
    });
    return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
  },

  update(id, { status, attempts } = {}) {
    const existing = db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
    if (!existing) return null;
    const nextStatus = status ?? existing.status;
    const nextAttempts = attempts ?? existing.attempts;
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
