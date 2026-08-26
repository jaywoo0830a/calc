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

  -- 🧭 개념 노드 (concept map) — 계층(parent_id)·이해 상태(status)·페이지 앵커
  CREATE TABLE IF NOT EXISTS concepts (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT '○', -- ● ◐ ○ △
    parent_id   TEXT NOT NULL DEFAULT '',  -- '' = 최상위 노드
    page_number INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0, -- 'order'는 SQL 예약어라 sort_order 사용
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_concepts_file ON concepts(file_path);

  -- 삭제 전파용 톰스톤 (기기 간 동기화 — 삭제된 항목이 되살아나지 않게)
  CREATE TABLE IF NOT EXISTS pdf_tombstones (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    deleted_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tombstones_file ON pdf_tombstones(file_path);

  -- 👣 페이지 따라가기 (교육용) — 파일별 최신 위치 (기기 식별 포함)
  CREATE TABLE IF NOT EXISTS pdf_positions (
    file_path  TEXT PRIMARY KEY,
    page       INTEGER NOT NULL DEFAULT 1,
    device     TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
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
    // 📐 스캔 디텍터 식별 (ml | classic | manual)
    if (!cols.some((c) => c.name === 'scanner')) {
      db.exec("ALTER TABLE annotations ADD COLUMN scanner TEXT NOT NULL DEFAULT ''");
    }
    // 📒 요약 주석 페이지 범위 (0 = 일반 이미지 주석)
    if (!cols.some((c) => c.name === 'range_start')) {
      db.exec('ALTER TABLE annotations ADD COLUMN range_start INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'range_end')) {
      db.exec('ALTER TABLE annotations ADD COLUMN range_end INTEGER NOT NULL DEFAULT 0');
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
/** 👣 PDF 페이지 위치 — 교육용 따라가기 (기기 간 동기화) */
export const pdfPosition = {
  get(filePath) {
    const r = db.prepare('SELECT file_path AS filePath, page, device, updated_at AS updatedAt FROM pdf_positions WHERE file_path = ?').get(filePath);
    return r || null;
  },
  upsert(filePath, page, device) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO pdf_positions (file_path, page, device, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET page = excluded.page, device = excluded.device, updated_at = excluded.updated_at
    `).run(filePath, Number(page) || 1, String(device || ''), now);
    return { filePath, page: Number(page) || 1, device: String(device || ''), updatedAt: now };
  },
};

/** PDF 주석(하이라이트/밑줄/코멘트) — 클라우드 동기화 (기기 간 동일 표시) */
function pruneTombstones() {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM pdf_tombstones WHERE deleted_at < ?').run(cutoff);
}

function mapAnnotationRow(r) {
  return {
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
    scanner: r.scanner || '',
    rangeStart: Number(r.range_start) || 0,
    rangeEnd: Number(r.range_end) || 0,
    updatedAt: r.updated_at,
  };
}

export const annotations = {
  list(filePath) {
    const rows = db.prepare(
      'SELECT * FROM annotations WHERE file_path = ? ORDER BY page_number ASC, created_at ASC'
    ).all(filePath);
    return rows.map(mapAnnotationRow);
  },

  /** 📒 요약 주석만 전체 문서에서 (Summaries 탭용 — 문서별/범위순) */
  listSummaries() {
    const rows = db.prepare(
      "SELECT * FROM annotations WHERE type = 'summary' ORDER BY file_path ASC, range_start ASC, created_at ASC"
    ).all();
    return rows.map(mapAnnotationRow);
  },
  meta(filePath) {
    pruneTombstones();
    return {
      items: db.prepare(
        'SELECT id, updated_at AS updatedAt FROM annotations WHERE file_path = ?'
      ).all(filePath),
      tombstones: db.prepare(
        "SELECT id, deleted_at AS deletedAt FROM pdf_tombstones WHERE kind = 'annotation' AND file_path = ?"
      ).all(filePath),
    };
  },
  upsert({ id, filePath, pageNumber, type, color, style, text, rect, status, attempts, wrong_count, dataUrl, aspect, scanner, rangeStart, rangeEnd }) {
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
      scanner: String(scanner || ''),
      rangeStart: Number(rangeStart) || 0,
      rangeEnd: Number(rangeEnd) || 0,
    };
    if (exists) {
      db.prepare(`
        UPDATE annotations
        SET file_path = @filePath, page_number = @pageNumber, type = @type,
            color = @color, style = @style, text = @text, rect = @rect,
            status = @status, attempts = @attempts, wrong_count = @wrong_count,
            data_url = @dataUrl, aspect = @aspect, scanner = @scanner,
            range_start = @rangeStart, range_end = @rangeEnd, updated_at = @now
        WHERE id = @id
      `).run({ ...data, now });
    } else {
      db.prepare(`
        INSERT INTO annotations (id, file_path, page_number, type, color, style, text, rect, status, attempts, wrong_count, data_url, aspect, scanner, range_start, range_end, created_at, updated_at)
        VALUES (@id, @filePath, @pageNumber, @type, @color, @style, @text, @rect, @status, @attempts, @wrong_count, @dataUrl, @aspect, @scanner, @rangeStart, @rangeEnd, @now, @now)
      `).run({ ...data, now });
    }
    // 재생성 시 삭제 톰스톤 제거 (다른 기기가 삭제를 반영하지 않도록)
    db.prepare("DELETE FROM pdf_tombstones WHERE id = ? AND kind = 'annotation'").run(id);
    return {
      id, filePath, pageNumber, type, color, style, text, rect,
      status: String(status || ''),
      attempts: Number(attempts) || 0,
      wrong_count: Number(wrong_count) || 0,
      dataUrl: String(dataUrl || ''),
      aspect: Number(aspect) || 0,
      scanner: String(scanner || ''),
      rangeStart: Number(rangeStart) || 0,
      rangeEnd: Number(rangeEnd) || 0,
      updatedAt: now,
    };
  },
  remove(id) {
    const row = db.prepare('SELECT file_path FROM annotations WHERE id = ?').get(id);
    db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
    if (row) {
      db.prepare(
        "INSERT OR REPLACE INTO pdf_tombstones (id, kind, file_path, deleted_at) VALUES (?, 'annotation', ?, ?)"
      ).run(id, row.file_path, new Date().toISOString());
    }
  },
  removeByFile(filePath) {
    const ids = db.prepare('SELECT id FROM annotations WHERE file_path = ?').all(filePath);
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT OR REPLACE INTO pdf_tombstones (id, kind, file_path, deleted_at) VALUES (?, 'annotation', ?, ?)"
    );
    for (const r of ids) ins.run(r.id, filePath, now);
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
  meta(filePath) {
    pruneTombstones();
    return {
      items: this.list(filePath),
      tombstones: db.prepare(
        "SELECT id, deleted_at AS deletedAt FROM pdf_tombstones WHERE kind = 'bookmark' AND file_path = ?"
      ).all(filePath),
    };
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
    db.prepare("DELETE FROM pdf_tombstones WHERE id = ? AND kind = 'bookmark'").run(id);
    return { id, filePath, pageNumber, title, createdAt: now };
  },
  remove(id) {
    const row = db.prepare('SELECT file_path FROM bookmarks WHERE id = ?').get(id);
    db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
    if (row) {
      db.prepare(
        "INSERT OR REPLACE INTO pdf_tombstones (id, kind, file_path, deleted_at) VALUES (?, 'bookmark', ?, ?)"
      ).run(id, row.file_path, new Date().toISOString());
    }
  },
  removeByFile(filePath) {
    const ids = db.prepare('SELECT id FROM bookmarks WHERE file_path = ?').all(filePath);
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT OR REPLACE INTO pdf_tombstones (id, kind, file_path, deleted_at) VALUES (?, 'bookmark', ?, ?)"
    );
    for (const r of ids) ins.run(r.id, filePath, now);
    db.prepare('DELETE FROM bookmarks WHERE file_path = ?').run(filePath);
  },
};

/** 🧭 개념 노드 (concept map) — 클라우드 동기화 (기기 간 동일 개념 지도)
 *  parent_id = '' → 최상위 노드 (JS에서는 null). children은 클라이언트가 파생.
 */
export const concepts = {
  list(filePath) {
    if (filePath) {
      return db.prepare(`
        SELECT id, file_path AS filePath, label, summary, status,
               parent_id AS parentId, page_number AS pageNumber,
               sort_order AS "order", created_at AS createdAt, updated_at AS updatedAt
        FROM concepts WHERE file_path = ? ORDER BY sort_order ASC, created_at ASC
      `).all(filePath).map((r) => ({ ...r, parentId: r.parentId || null }));
    }
    // 전체 문서의 개념 노드 (Concepts 탭용)
    return db.prepare(`
      SELECT id, file_path AS filePath, label, summary, status,
             parent_id AS parentId, page_number AS pageNumber,
             sort_order AS "order", created_at AS createdAt, updated_at AS updatedAt
      FROM concepts ORDER BY file_path ASC, sort_order ASC, created_at ASC
    `).all().map((r) => ({ ...r, parentId: r.parentId || null }));
  },
  meta(filePath) {
    pruneTombstones();
    return {
      items: db.prepare(
        'SELECT id, updated_at AS updatedAt FROM concepts WHERE file_path = ?'
      ).all(filePath),
      tombstones: db.prepare(
        "SELECT id, deleted_at AS deletedAt FROM pdf_tombstones WHERE kind = 'concept' AND file_path = ?"
      ).all(filePath),
    };
  },
  upsert({ id, filePath, label, summary, status, parentId, pageNumber, order }) {
    const now = new Date().toISOString();
    const data = {
      id,
      filePath,
      label: String(label || '').slice(0, 200),
      summary: String(summary || '').slice(0, 2000),
      status: String(status || '○').slice(0, 8),
      parentId: parentId ? String(parentId) : '',
      pageNumber: Number(pageNumber) || 1,
      order: Number.isFinite(Number(order)) ? Number(order) : 0,
    };
    const exists = db.prepare('SELECT id FROM concepts WHERE id = ?').get(id);
    if (exists) {
      db.prepare(`
        UPDATE concepts
        SET file_path = @filePath, label = @label, summary = @summary,
            status = @status, parent_id = @parentId, page_number = @pageNumber,
            sort_order = @order, updated_at = @now
        WHERE id = @id
      `).run({ ...data, now });
    } else {
      db.prepare(`
        INSERT INTO concepts (id, file_path, label, summary, status, parent_id, page_number, sort_order, created_at, updated_at)
        VALUES (@id, @filePath, @label, @summary, @status, @parentId, @pageNumber, @order, @now, @now)
      `).run({ ...data, now });
    }
    // 재생성 시 삭제 톰스톤 제거 (다른 기기가 삭제를 반영하지 않도록)
    db.prepare("DELETE FROM pdf_tombstones WHERE id = ? AND kind = 'concept'").run(id);
    return { ...data, parentId: data.parentId || null, updatedAt: now };
  },
  remove(id) {
    const row = db.prepare('SELECT file_path FROM concepts WHERE id = ?').get(id);
    db.prepare('DELETE FROM concepts WHERE id = ?').run(id);
    if (row) {
      db.prepare(
        "INSERT OR REPLACE INTO pdf_tombstones (id, kind, file_path, deleted_at) VALUES (?, 'concept', ?, ?)"
      ).run(id, row.file_path, new Date().toISOString());
    }
  },
  removeByFile(filePath) {
    const ids = db.prepare('SELECT id FROM concepts WHERE file_path = ?').all(filePath);
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT OR REPLACE INTO pdf_tombstones (id, kind, file_path, deleted_at) VALUES (?, 'concept', ?, ?)"
    );
    for (const r of ids) ins.run(r.id, filePath, now);
    db.prepare('DELETE FROM concepts WHERE file_path = ?').run(filePath);
  },
};

// ── 연습장 스니펫 (Three.js 탭 Practice 모드) ────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS practice (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'practice' CHECK (kind IN ('canvas','practice')),
    code       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export const practice = {
  list() {
    return db.prepare('SELECT id, name, kind, created_at, updated_at FROM practice ORDER BY updated_at DESC').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM practice WHERE id = ?').get(id);
  },
  upsert({ id, name, kind, code }) {
    const now = new Date().toISOString();
    const prev = db.prepare('SELECT created_at FROM practice WHERE id = ?').get(id);
    db.prepare(`
      INSERT INTO practice (id, name, kind, code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, kind = excluded.kind, code = excluded.code, updated_at = excluded.updated_at
    `).run(id, String(name), kind === 'canvas' ? 'canvas' : 'practice', String(code), prev ? prev.created_at : now, now);
    return db.prepare('SELECT * FROM practice WHERE id = ?').get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM practice WHERE id = ?').run(id);
  },
};
