import express from 'express';
import multer from 'multer';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { problems, archives, archivesDir } from './db.js';
const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

// ZIP 아카이브 업로드 — 디스크 스토리지 (메모리 부담 없이 100MB까지)
const uploadZip = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, archivesDir),
    filename: (req, file, cb) => cb(null, randomUUID() + '.upload'),
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (/\.zip$/i.test(file.originalname || '')) cb(null, true);
    else cb(new Error('ZIP 파일만 업로드할 수 있습니다'));
  },
});

// ── XML entity decode ──────────────────────────────────────────────────────────
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decodeXml = (s) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] || m);

// ── pdftohtml XML → 시맨틱 HTML (제목 계층 재구성) ─────────────────────────────
function xmlToSemanticHtml(xml) {
  // 1. fontspec 파싱: id → size (속성 순서 무관)
  const fontSizes = {};
  for (const m of xml.matchAll(/<fontspec\s+[^>]*\bid="(\d+)"[^>]*\bsize="(\d+)"[^>]*\/?>/g)) {
    fontSizes[m[1]] = parseInt(m[2], 10);
  }
  // size가 id보다 먼저 나오는 경우도 커버
  for (const m of xml.matchAll(/<fontspec\s+[^>]*\bsize="(\d+)"[^>]*\bid="(\d+)"[^>]*\/?>/g)) {
    if (!fontSizes[m[2]]) fontSizes[m[2]] = parseInt(m[1], 10);
  }

  // 폰트 크기 목록 (내림차순, 중복제거)
  const uniqueSizes = [...new Set(Object.values(fontSizes))].sort((a, b) => b - a);

  // 상위 최대 6개 크기에 heading level 매핑
  const headingSizeToLevel = {};
  const maxHeadings = Math.min(uniqueSizes.length, 6);
  for (let i = 0; i < maxHeadings; i++) {
    headingSizeToLevel[uniqueSizes[i]] = i + 1;
  }

  // 2. page 파싱 (속성 순서 무관)
  const pages = [];
  for (const m of xml.matchAll(/<page\s+[^>]*\bnumber="(\d+)"[^>]*>/g)) {
    pages.push({ number: parseInt(m[1], 10), start: m.index });
  }
  // 마지막 page 종료지점
  for (let i = 0; i < pages.length; i++) {
    pages[i].end = i + 1 < pages.length ? pages[i + 1].start : xml.length;
  }

  // text 태그: 각 속성을 개별 정규식으로 추출 (순서 무관)
  const textBlockRe = /<text\s+([^>]*?)>(.*?)<\/text>/gs;
  const attrRe = /\b(top|left|width|height|font)="(\d+)"/g;

  const allTexts = [];
  for (const m of xml.matchAll(textBlockRe)) {
    const attrsStr = m[1];
    const rawContent = m[2];
    const attr = {};
    for (const am of attrsStr.matchAll(attrRe)) {
      attr[am[1]] = parseInt(am[2], 10);
    }
    if (attr.top === undefined) continue; // 필수 속성 누락

    // 인라인 태그 (<b>, <i>) 보존하며 엔티티 디코드
    const innerHtml = decodeXml(rawContent)
      .replace(/<b>/g, '<b>').replace(/<\/b>/g, '</b>')
      .replace(/<i>/g, '<i>').replace(/<\/i>/g, '</i>');

    allTexts.push({
      top: attr.top,
      left: attr.left || 0,
      width: attr.width || 0,
      height: attr.height || 12,
      fontId: String(attr.font || 0),
      fontSize: fontSizes[String(attr.font || 0)] || 12,
      text: rawContent.replace(/<[^>]*>/g, ''), // 순수 텍스트 (heading 판별용)
      html: innerHtml,                           // HTML 보존 (최종 출력용)
    });
  }

  if (allTexts.length === 0) return '<p><em>(No text extracted)</em></p>';

  // ── 각 text를 페이지별로 분류 ──────────────────────────────────────────────
  const pageTexts = [];
  for (const page of pages) {
    const pageContent = xml.slice(page.start, page.end);
    const items = [];
    for (const m of pageContent.matchAll(textBlockRe)) {
      const attrsStr = m[1];
      const rawContent = m[2];
      const attr = {};
      for (const am of attrsStr.matchAll(attrRe)) {
        attr[am[1]] = parseInt(am[2], 10);
      }
      if (attr.top === undefined) continue;

      const innerHtml = decodeXml(rawContent)
        .replace(/<b>/g, '<b>').replace(/<\/b>/g, '</b>')
        .replace(/<i>/g, '<i>').replace(/<\/i>/g, '</i>');

      items.push({
        top: attr.top,
        left: attr.left || 0,
        width: attr.width || 0,
        height: attr.height || 12,
        fontId: String(attr.font || 0),
        fontSize: fontSizes[String(attr.font || 0)] || 12,
        text: rawContent.replace(/<[^>]*>/g, ''),
        html: innerHtml,
      });
    }
    if (items.length > 0) pageTexts.push({ number: page.number, items });
  }

  // 페이지가 안 잡혔으면 전체를 한 페이지로
  if (pageTexts.length === 0) {
    pageTexts.push({ number: 1, items: allTexts });
  }

  // ── 각 페이지 내에서 y-좌표로 라인 그룹화 ──────────────────────────────────
  const Y_TOLERANCE = 4; // 같은 줄로 간주할 y좌표 오차 (px)

  function buildLines(items) {
    // y 기준 정렬
    const sorted = [...items].sort((a, b) => a.top - b.top || a.left - b.left);

    const lines = [];
    for (const item of sorted) {
      // 같은 y 줄 찾기
      let line = lines.find(
        (l) => Math.abs(l.y - item.top) <= Y_TOLERANCE
      );
      if (!line) {
        line = { y: item.top, items: [] };
        lines.push(line);
      }
      line.items.push(item);
    }

    // 각 라인 내에서 left→right 정렬 후 텍스트 합치기
    return lines.map((line) => {
      line.items.sort((a, b) => a.left - b.left);
      // 같은 라인에서 폰트 크기가 섞여있으면 가장 큰 것 기준
      const maxFontSize = Math.max(...line.items.map((t) => t.fontSize));
      const maxHeight = Math.max(...line.items.map((t) => t.height));
      // 순수 텍스트 (heading 판별용)
      const fullText = line.items.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
      // HTML 보존 버전 (<b>/<i> 유지)
      const fullHtml = line.items.map((t) => t.html).join(' ').replace(/\s+/g, ' ').trim();
      // left margin: 가장 왼쪽 item의 left
      const leftMargin = Math.min(...line.items.map((t) => t.left));
      return {
        y: line.y,
        text: fullText,
        html: fullHtml,
        fontSize: maxFontSize,
        height: maxHeight,
        leftMargin,
        headingLevel: null,
      };
    });
  }

  // ── 제목 판별 휴리스틱 ─────────────────────────────────────────────────────
  function classifyHeadings(lines) {
    // 전체 라인의 평균 텍스트 길이 계산
    const avgLen = lines.reduce((s, l) => s + l.text.length, 0) / Math.max(lines.length, 1);

    for (const line of lines) {
      const text = line.text;
      const len = text.length;

      // 조건 1: 폰트 크기가 heading 매핑에 포함되어야 함
      const hLevel = headingSizeToLevel[line.fontSize];
      if (!hLevel) continue;

      // 조건 2: 텍스트가 짧아야 함 (평균의 60% 미만, 또는 200자 미만)
      if (len > 200) continue;
      if (len > avgLen * 0.7) continue;

      // 조건 3: 문장 종결 부호로 끝나지 않아야 함 (제목은 보통 마침표 없음)
      // 예외: 물음표, 느낌표는 제목일 수 있으니 허용
      if (/[.,;:]$/.test(text) && len > 50) continue;

      // 조건 4: 너무 짧은 잔여 텍스트는 제외 (2자 미만)
      if (len < 2) continue;

      line.headingLevel = hLevel;
    }

    // 보정: h1이 없고 h2만 있으면 한 단계씩 올리기
    const usedLevels = new Set(lines.filter((l) => l.headingLevel).map((l) => l.headingLevel));
    if (!usedLevels.has(1) && usedLevels.size > 0) {
      const minLevel = Math.min(...usedLevels);
      for (const line of lines) {
        if (line.headingLevel) line.headingLevel -= (minLevel - 1);
      }
    }
  }

  // ── 페이지별 처리 후 HTML 조립 ─────────────────────────────────────────────
  const htmlParts = [];

  for (const page of pageTexts) {
    const lines = buildLines(page.items);
    classifyHeadings(lines);

    // y좌표로 정렬
    lines.sort((a, b) => a.y - b.y);

    // 이전 라인과의 간격으로 문단 구분
    const PARA_GAP = 8; // y 간격이 이보다 크면 새 문단

    let paraOpen = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = lines[i - 1];

      // 이전 라인과의 간격
      const gap = prev ? line.y - (prev.y + prev.height) : 999;

      // heading이면 무조건 새 블록 시작
      if (line.headingLevel) {
        if (paraOpen) { htmlParts.push('</p>'); paraOpen = false; }
        const hTag = `h${line.headingLevel}`;
        htmlParts.push(`<${hTag}>${line.html}</${hTag}>`);
        continue;
      }

      // 빈 줄 / 큰 간격 → 문단 분리
      if (gap > PARA_GAP || !prev) {
        if (paraOpen) { htmlParts.push('</p>'); paraOpen = false; }
        if (line.html) {
          htmlParts.push('<p>');
          htmlParts.push(line.html);
          paraOpen = true;
        }
        continue;
      }

      // 같은 문단 내 연속 라인
      if (paraOpen) {
        // 왼쪽 여백이 크게 다르면 새 문단 시작 (들여쓰기/블록인용 감지)
        if (Math.abs(line.leftMargin - prev.leftMargin) > 20) {
          htmlParts.push('</p>');
          paraOpen = false;
          if (line.html) {
            htmlParts.push('<p>');
            htmlParts.push(line.html);
            paraOpen = true;
          }
        } else {
          htmlParts.push('\n' + line.html);
        }
      }
    }

    if (paraOpen) { htmlParts.push('</p>'); paraOpen = false; }
  }

  return htmlParts.join('') || '<p><em>(No structured content)</em></p>';
}

// ── POST /pdf ─────────────────────────────────────────────────────────────────
app.post('/pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file' });

  const id = randomUUID();
  const tmpDir = join(tmpdir(), 'calc-pdf-' + id);
  const pdfPath = join(tmpDir, 'input.pdf');

  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(pdfPath, req.file.buffer);

    // Step 1: pdftohtml -xml → 폰트 크기 + 위치 정보가 담긴 XML
    const xml = await new Promise((resolve, reject) => {
      execFile('pdftohtml', ['-xml', '-stdout', '-i', '-noframes', pdfPath], {
        timeout: 30000,
        maxBuffer: 50 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });

    // Step 2: XML → 시맨틱 HTML (제목 계층 재구성)
    const semanticHtml = xmlToSemanticHtml(xml);

    // Step 3: pandoc → GFM Markdown
    const md = await new Promise((resolve, reject) => {
      const child = execFile('pandoc', [
        '-f', 'html+tex_math_dollars',
        '-t', 'gfm+tex_math_dollars',
        '--wrap=none',
        '--standalone=false',
        '--markdown-headings=atx',
        '--eol=lf',
      ], {
        timeout: 30000,
        maxBuffer: 50 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
      child.stdin.write(semanticHtml);
      child.stdin.end();
    });

    res.type('text').send(md);
  } catch (e) {
    console.error('PDF conversion error:', e.message);
    res.status(500).json({ error: 'PDF conversion failed: ' + e.message });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── 푼/틀린 문제 CRUD ──────────────────────────────────────────────────────────
app.get('/problems', (req, res) => {
  try {
    res.json(problems.list({ status: req.query.status, doc: req.query.doc }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 선택 기반 등록 — 같은 선택(문제)은 서버에서 upsert
app.post('/problems', (req, res) => {
  try {
    const { docId, docPath, ref, text, status } = req.body || {};
    if (!docId || !text) return res.status(400).json({ error: 'docId and text are required' });
    res.json(problems.upsert({ docId, docPath, ref, text, status }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/problems/:id', (req, res) => {
  try {
    const { status, attempts } = req.body || {};
    const rec = problems.update(req.params.id, { status, attempts });
    if (!rec) return res.status(404).json({ error: 'Problem not found' });
    res.json(rec);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 특정 문서의 문제 전체 삭제 (재업로드/패치 후 정리용)
app.delete('/problems', (req, res) => {
  try {
    const { doc } = req.query;
    if (!doc) return res.status(400).json({ error: 'doc query param required' });
    problems.removeByDoc(doc);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/problems/:id', (req, res) => {
  try {
    problems.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ZIP 아카이브 (서버 저장 — 어떤 기기에서든 같은 라이브러리) ────────────────
app.get('/archives', (req, res) => {
  try {
    res.json(archives.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/archives', uploadZip.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'no file' });
  const id = randomUUID();
  try {
    await rename(file.path, join(archivesDir, id + '.zip'));
    archives.create({ id, name: file.originalname, size: file.size });
    res.json({ id, name: file.originalname, size: file.size, savedAt: new Date().toISOString() });
  } catch (e) {
    try { await rm(file.path, { force: true }); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.get('/archives/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]{1,64}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  const meta = archives.get(id);
  const filePath = join(archivesDir, id + '.zip');
  if (!meta || !existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  res.setHeader('X-Archive-Name', encodeURIComponent(meta.name));
  res.download(filePath, meta.name);
});

app.delete('/archives/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]{1,64}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  archives.remove(id);
  try { await rm(join(archivesDir, id + '.zip'), { force: true }); } catch {}
  res.json({ ok: true });
});

// health check
app.get('/health', (_, res) => res.json({ ok: true }));

// 업로드/요청 에러 → JSON 응답 (multer fileFilter/size 초과 포함)
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'request error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`calc-api running on :${PORT}`));
