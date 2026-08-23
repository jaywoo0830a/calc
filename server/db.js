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
    solved_at   TEXT,                        -- 마지막으로 맞은 시각
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_problems_doc    ON problems(doc_id);
  CREATE INDEX IF NOT EXISTS idx_problems_status ON problems(status);

  CREATE TABLE IF NOT EXISTS archive_files (
    archive_id TEXT NOT NULL,
    path       TEXT NOT NULL,
    PRIMARY KEY (archive_id, path)
  );
  CREATE INDEX IF NOT EXISTS idx_archive_files_path ON archive_files(path);

  CREATE TABLE IF NOT EXISTS archives (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vocab (
    word       TEXT PRIMARY KEY,
    count      INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_at    TEXT NOT NULL
  );

  -- 나만의 의미 매핑 (1단어 → N개 별칭 + 예문)
  CREATE TABLE IF NOT EXISTS vocab_aliases (
    word       TEXT NOT NULL,
    alias      TEXT NOT NULL,
    example    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (word, alias)
  );

  CREATE TABLE IF NOT EXISTS annotations (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    page_number INTEGER NOT NULL DEFAULT 1,
    type        TEXT NOT NULL DEFAULT 'highlight',
    color       TEXT NOT NULL DEFAULT '',
    style       TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL DEFAULT '',
    rect        TEXT NOT NULL DEFAULT '{}', -- JSON {x,y,w,h} (0~1 정규화)
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_annotations_file ON annotations(file_path);

  CREATE TABLE IF NOT EXISTS bookmarks (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    page_number INTEGER NOT NULL DEFAULT 1,
    title       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookmarks_file ON bookmarks(file_path);
`);

// ── 마이그레이션: problems.solved_at 추가 (구버전 DB용) ─────────────────
{
  const cols = db.prepare('PRAGMA table_info(problems)').all();
  if (!cols.some((c) => c.name === 'solved_at')) {
    db.exec('ALTER TABLE problems ADD COLUMN solved_at TEXT');
  }
}

// ── 마이그레이션: vocab_aliases.example 추가 ────────────────────────────
{
  const cols = db.prepare('PRAGMA table_info(vocab_aliases)').all();
  if (cols.length > 0 && !cols.some((c) => c.name === 'example')) {
    db.exec("ALTER TABLE vocab_aliases ADD COLUMN example TEXT NOT NULL DEFAULT ''");
  }
}

// ── 마이그레이션: annotations.status 추가 (스캔 PDF용 문제 코멘트) ──────
{
  const cols = db.prepare('PRAGMA table_info(annotations)').all();
  if (cols.length > 0) {
    if (!cols.some((c) => c.name === 'status')) {
      db.exec("ALTER TABLE annotations ADD COLUMN status TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.some((c) => c.name === 'attempts')) {
      db.exec('ALTER TABLE annotations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'wrong_count')) {
      db.exec('ALTER TABLE annotations ADD COLUMN wrong_count INTEGER NOT NULL DEFAULT 0');
    }
    // 🖼️ 이미지 주석 — dataURL + 종횡비
    if (!cols.some((c) => c.name === 'data_url')) {
      db.exec("ALTER TABLE annotations ADD COLUMN data_url TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.some((c) => c.name === 'aspect')) {
      db.exec('ALTER TABLE annotations ADD COLUMN aspect REAL NOT NULL DEFAULT 0');
    }
  }
}

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
      const becameSolved = status === 'solved' && existing.status !== 'solved';
      db.prepare(`
        UPDATE problems
        SET status      = @status,
            doc_path    = @docPath,
            ref         = @ref,      -- 최신 좌표로 항상 갱신
            wrong_count = wrong_count + @becameWrong,
            attempts    = attempts + 1,
            solved_at   = CASE WHEN @becameSolved = 1 THEN @now ELSE solved_at END,
            updated_at  = @now
        WHERE id = @id
      `).run({ id, status, docPath, ref, becameWrong: becameWrong ? 1 : 0, becameSolved: becameSolved ? 1 : 0, now });
      return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
    }

    // 예전 id 규칙(docId|ref|text)으로 생긴 중복 행 정리 — 같은 문서+텍스트면 하나만 유지
    db.prepare('DELETE FROM problems WHERE doc_id = @docId AND text = @text AND id != @id')
      .run({ docId, text: normalizedText, id });

    db.prepare(`
      INSERT INTO problems (id, doc_id, doc_path, ref, text, status, wrong_count, attempts, solved_at, created_at, updated_at)
      VALUES (@id, @docId, @docPath, @ref, @text, @status, @wrongCount, 1, @solvedAt, @now, @now)
    `).run({
      id, docId, docPath, ref, text: normalizedText, status,
      wrongCount: status === 'wrong' ? 1 : 0,
      solvedAt: status === 'solved' ? now : null,
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
    const becameSolved = nextStatus === 'solved' && existing.status !== 'solved';
    db.prepare(`
      UPDATE problems
      SET status      = @status,
          wrong_count = wrong_count + @becameWrong,
          attempts    = @attempts,
          solved_at   = CASE WHEN @becameSolved = 1 THEN @now ELSE solved_at END,
          updated_at  = @now
      WHERE id = @id
    `).run({
      id,
      status: nextStatus,
      becameWrong: becameWrong ? 1 : 0,
      becameSolved: becameSolved ? 1 : 0,
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

  /** 전체 문제 삭제 (Problems 탭 Clear all) */
  removeAll() {
    db.prepare('DELETE FROM problems').run();
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
    db.prepare('DELETE FROM archive_files WHERE archive_id = ?').run(id);
  },

  /** ZIP 내부 파일 목록 저장 (업로드/백필 시) */
  setFileList(id, paths) {
    const ins = db.prepare('INSERT OR IGNORE INTO archive_files (archive_id, path) VALUES (?, ?)');
    const tx = db.transaction((list) => { for (const p of list) ins.run(id, p); });
    tx(paths);
  },

  hasFileList(id) {
    return !!db.prepare('SELECT 1 FROM archive_files WHERE archive_id = ? LIMIT 1').get(id);
  },

  /** 해당 경로(또는 파일명)를 담은 아카이브 목록 — 최근 업로드 순 */
  findByFile(path) {
    const name = String(path || '').split('/').pop();
    return db.prepare(`
      SELECT a.id, a.name, a.created_at AS savedAt
      FROM archive_files af
      JOIN archives a ON a.id = af.archive_id
      WHERE af.path = @path OR af.path = @name OR af.path LIKE '%/' || @name
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `).all({ path: String(path || ''), name });
  },
};

/** 찾아본 단어장 — 단어별 조회 횟수/시각 기록 (기기 간 공유) */
export const vocab = {
  list() {
    return db.prepare('SELECT word, count, created_at, last_at FROM vocab ORDER BY last_at DESC, word ASC').all();
  },
  record(word) {
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT word FROM vocab WHERE word = ?').get(word);
    if (existing) {
      db.prepare('UPDATE vocab SET count = count + 1, last_at = ? WHERE word = ?').run(now, word);
    } else {
      db.prepare('INSERT INTO vocab (word, count, created_at, last_at) VALUES (?, 1, ?, ?)').run(word, now, now);
    }
  },
  remove(word) {
    db.prepare('DELETE FROM vocab WHERE word = ?').run(word);
    db.prepare('DELETE FROM vocab_aliases WHERE word = ?').run(word);
  },
  removeAll() {
    db.prepare('DELETE FROM vocab').run();
    db.prepare('DELETE FROM vocab_aliases').run();
  },
};
/** 나만의 의미 매핑 — 단어별 별칭 1:N (예: concise → shorten, compressed) */
export const vocabAliases = {
  listAll() {
    return db.prepare('SELECT word, alias, example, created_at FROM vocab_aliases ORDER BY created_at ASC').all();
  },
  listFor(word) {
    return db.prepare(
      'SELECT word, alias, example, created_at FROM vocab_aliases WHERE word = ? ORDER BY created_at ASC, alias ASC'
    ).all(word);
  },
  add(word, alias, example = '') {
    const now = new Date().toISOString();
    // 같은 뜻을 다시 추가하면 예문만 갱신 (upsert)
    db.prepare(`
      INSERT INTO vocab_aliases (word, alias, example, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(word, alias) DO UPDATE SET example = excluded.example
    `).run(word, alias, example, now);
    return db.prepare('SELECT word, alias, example, created_at FROM vocab_aliases WHERE word = ? AND alias = ?')
      .get(word, alias) || null;
  },
  remove(word, alias) {
    db.prepare('DELETE FROM vocab_aliases WHERE word = ? AND alias = ?').run(word, alias);
  },
};
/** PDF 주석(하이라이트/밑줄/코멘트) — 클라우드 동기화 (기기 간 동일 표시) */
export const annotations = {
  list(filePath) {
    const rows = db.prepare(
      'SELECT * FROM annotations WHERE file_path = ? ORDER BY page_number ASC, created_at ASC'
    ).all(filePath);
    return rows.map((r) => ({
      id: r.id,
      filePath: r.file_path,
      pageNumber: r.page_number,
      type: r.type,
      color: r.color,
      style: r.style,
      text: r.text,
      status: r.status || '',
      attempts: Number(r.attempts) || 0,
      wrong_count: Number(r.wrong_count) || 0,
      rect: JSON.parse(r.rect || '{}'),
      dataUrl: r.data_url || '',
      aspect: Number(r.aspect) || 0,
    }));
  },
  upsert({ id, filePath, pageNumber, type, color, style, text, rect, status, attempts, wrong_count, dataUrl, aspect }) {
    const now = new Date().toISOString();
    const exists = db.prepare('SELECT id FROM annotations WHERE id = ?').get(id);
    const data = {
      id, filePath, pageNumber, type, color, style, text,
      rect: JSON.stringify(rect || {}),
      status: String(status || ''),
      attempts: Number(attempts) || 0,
      wrong_count: Number(wrong_count) || 0,
      dataUrl: String(dataUrl || ''),
      aspect: Number(aspect) || 0,
    };
    if (exists) {
      db.prepare(`
        UPDATE annotations
        SET file_path = @filePath, page_number = @pageNumber, type = @type,
            color = @color, style = @style, text = @text, rect = @rect,
            status = @status, attempts = @attempts, wrong_count = @wrong_count,
            data_url = @dataUrl, aspect = @aspect, updated_at = @now
        WHERE id = @id
      `).run({ ...data, now });
    } else {
      db.prepare(`
        INSERT INTO annotations (id, file_path, page_number, type, color, style, text, rect, status, attempts, wrong_count, data_url, aspect, created_at, updated_at)
        VALUES (@id, @filePath, @pageNumber, @type, @color, @style, @text, @rect, @status, @attempts, @wrong_count, @dataUrl, @aspect, @now, @now)
      `).run({ ...data, now });
    }
    return {
      id, filePath, pageNumber, type, color, style, text, rect,
      status: String(status || ''),
      attempts: Number(attempts) || 0,
      wrong_count: Number(wrong_count) || 0,
      dataUrl: String(dataUrl || ''),
      aspect: Number(aspect) || 0,
    };
  },
  remove(id) {
    db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
  },
  removeByFile(filePath) {
    db.prepare('DELETE FROM annotations WHERE file_path = ?').run(filePath);
  },
};

/** PDF 북마크 — 클라우드 동기화 (기기 간 동일) */
export const bookmarks = {
  list(filePath) {
    return db.prepare(
      'SELECT id, file_path AS filePath, page_number AS pageNumber, title, created_at AS createdAt FROM bookmarks WHERE file_path = ? ORDER BY page_number ASC'
    ).all(filePath);
  },
  upsert({ id, filePath, pageNumber, title }) {
    const now = new Date().toISOString();
    const exists = db.prepare('SELECT id FROM bookmarks WHERE id = ?').get(id);
    if (exists) {
      db.prepare('UPDATE bookmarks SET file_path = @filePath, page_number = @pageNumber, title = @title WHERE id = @id')
        .run({ id, filePath, pageNumber, title });
    } else {
      db.prepare('INSERT INTO bookmarks (id, file_path, page_number, title, created_at) VALUES (@id, @filePath, @pageNumber, @title, @now)')
        .run({ id, filePath, pageNumber, title, now });
    }
    return { id, filePath, pageNumber, title, createdAt: now };
  },
  remove(id) {
    db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  },
  removeByFile(filePath) {
    db.prepare('DELETE FROM bookmarks WHERE file_path = ?').run(filePath);
  },
};
