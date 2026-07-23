import express from 'express';
import multer from 'multer';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import https from 'node:https';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

// ── Connection Pooling Agents (keepAlive) ───────────────────────────────────
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  scheduling: 'fifo',
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  scheduling: 'fifo',
});

// ── 응답에서 제거할 헤더 (iframe 차단 방지) ─────────────────────────────────
const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
]);

// ── 클라이언트 요청에서 제거할 헤더 ──────────────────────────────────────────
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'via',
]);

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

// ── ALL /proxy ──────────────────────────────────────────────────────────────────
app.all('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing ?url=' });

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const startTime = Date.now();
  let responded = false;

  const fail = (code, msg) => {
    if (responded) return;
    responded = true;
    if (!res.headersSent) {
      res.status(code).send(msg);
    } else {
      res.end();
    }
  };

  // ── 전역 안전장치: 20초 내 무응답 시 강제 종료 ──────────────────────────
  const safetyTimer = setTimeout(() => {
    console.error(`Proxy SAFETY TIMEOUT [${req.method} ${targetUrl}] — no response in 20s`);
    fail(504, 'Proxy safety timeout (20s)');
  }, 20000);

  // ── 요청 헤더 구성 ──────────────────────────────────────────────────────
  const reqHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lk)) continue;
    reqHeaders[key] = value;
  }
  reqHeaders['host'] = parsed.host;
  if (!reqHeaders['accept'])          reqHeaders['accept']          = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  if (!reqHeaders['accept-language']) reqHeaders['accept-language'] = reqHeaders['accept-language'] || 'en-US,en;q=0.9,ko;q=0.8';
  if (!reqHeaders['accept-encoding']) reqHeaders['accept-encoding'] = 'gzip, deflate, br';
  if (!reqHeaders['cache-control'])   reqHeaders['cache-control']   = 'no-cache';
  if (!reqHeaders['sec-fetch-dest'])  reqHeaders['sec-fetch-dest']  = 'iframe';
  if (!reqHeaders['sec-fetch-mode'])  reqHeaders['sec-fetch-mode']  = 'navigate';
  if (!reqHeaders['sec-fetch-site'])  reqHeaders['sec-fetch-site']  = 'cross-site';
  if (!reqHeaders['user-agent'])      reqHeaders['user-agent']      =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  // ── 요청 전송 (ECONNRESET 시 fresh connection으로 1회 자동 재시도) ──────
  // HARD_TIMEOUT: Node.js socket timeout 은 TCP 연결단계에서 작동 안 할 수 있어
  //               별도 setTimeout 으로 강제 차단
  const HARD_TIMEOUT = 15000; // 15초

  sendRequest(0);

  function sendRequest(attempt) {
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const agent = attempt > 0
      ? new (isHttps ? https.Agent : http.Agent)({ keepAlive: false, timeout: HARD_TIMEOUT })
      : (isHttps ? httpsAgent : httpAgent);

    console.error(`Proxy [${attempt}] ${req.method} ${targetUrl}`);

    let hardTimer;
    let finished = false;

    const cleanup = () => {
      finished = true;
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    };

    // ── 하드 타임아웃: 15초 내 연결/응답 없으면 강제 종료 ─────────────────
    hardTimer = setTimeout(() => {
      if (finished) return;
      console.error(`Proxy HARD TIMEOUT [${attempt}] after ${Date.now() - startTime}ms`);
      proxyReq.destroy();
      fail(504, `Connection timeout — cannot reach ${parsed.hostname}:${parsed.port || 443}. Firewall?`);
    }, HARD_TIMEOUT);

    const proxyReq = transport.request(
      parsed.href,
      { method: req.method, headers: reqHeaders, agent, timeout: HARD_TIMEOUT, rejectUnauthorized: false },
      (proxyRes) => {
        if (responded || finished) return;
        cleanup();
        clearTimeout(safetyTimer);
        const statusCode = proxyRes.statusCode || 502;
        const contentType = proxyRes.headers['content-type'] || '';

        console.error(`Proxy ← ${statusCode} ${contentType.slice(0, 50)} (${Date.now() - startTime}ms)`);

        if (statusCode >= 300 && statusCode < 400 && proxyRes.headers['location']) {
          proxyRes.headers['location'] = proxyUrl(proxyRes.headers['location'], targetUrl);
        }

        const resHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
          if (key.toLowerCase() === 'content-security-policy') {
            resHeaders[key] = String(value).replace(/frame-ancestors\s+[^;]+;?/gi, 'frame-ancestors *;');
            continue;
          }
          resHeaders[key] = value;
        }
        resHeaders['access-control-allow-origin'] = '*';
        resHeaders['access-control-allow-credentials'] = 'true';
        resHeaders['x-proxied-by'] = 'CalcProxy/2.0';

        res.writeHead(statusCode, resHeaders);
        responded = true;

        if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
          return bufferAndRewrite(proxyRes, res, targetUrl, 'html');
        }
        if (contentType.includes('text/css')) {
          return bufferAndRewrite(proxyRes, res, targetUrl, 'css');
        }

        proxyRes.pipe(res);
        proxyRes.on('error', (e) => {
          console.error('Proxy response stream error:', e.message);
          if (!res.writableEnded) res.end();
        });
      }
    );

    proxyReq.on('error', (e) => {
      if (responded || finished) return;
      cleanup();
      console.error(`Proxy [${attempt}] ERROR: ${e.code || 'ERR'} ${e.message}`);

      if (attempt === 0 && (e.code === 'ECONNRESET' || e.message.includes('socket hang up'))) {
        console.error('→ Retrying with fresh connection…');
        return sendRequest(1);
      }

      const code = e.code === 'ENOTFOUND' ? 502 : (e.code === 'ETIMEDOUT' ? 504 : 502);
      fail(code, `Proxy error: ${e.message}`);
    });

    proxyReq.on('timeout', () => {
      if (responded || finished) return;
      cleanup();
      console.error(`Proxy socket timeout [${attempt}] after ${Date.now() - startTime}ms`);
      proxyReq.destroy();
      fail(504, 'Upstream timeout (15s)');
    });

    req.once('close', () => {
      if (!responded && !finished) {
        cleanup();
        proxyReq.destroy();
        clearTimeout(safetyTimer);
      }
    });

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
  }
});

// ── HTML/CSS 버퍼링 + 타임아웃 보호 ──────────────────────────────────────────
function bufferAndRewrite(proxyRes, res, targetUrl, type) {
  const BUFFER_TIMEOUT = 15000;  // 15초 내에 전체 응답이 안 오면 지금까지 받은 것만 전송
  const MAX_BUFFER_SIZE = 5 * 1024 * 1024; // 5MB

  let body = '';
  let timer;

  const send = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (res.writableEnded) return;

    try {
      if (type === 'html') body = rewriteUrls(body, targetUrl);
      else body = rewriteCssUrls(body, targetUrl);
    } catch (e) {
      console.error('Rewrite error:', e.message);
    }
    res.end(body);
  };

  // 타임아웃: 15초 지나면 지금까지 받은 내용으로 응답 종료
  timer = setTimeout(() => {
    console.error(`Proxy buffer timeout [${type}] after 15s, sending partial (${body.length} bytes)`);
    proxyRes.destroy(); // 업스트림 연결 중단
    if (body.length === 0) {
      body = '<p><em>Proxy: upstream response timed out</em></p>';
    }
    send();
  }, BUFFER_TIMEOUT);

  proxyRes.setEncoding('utf8');
  proxyRes.on('data', (chunk) => {
    body += chunk;
    // 용량 초과 시 즉시 전송
    if (body.length > MAX_BUFFER_SIZE) {
      if (timer) { clearTimeout(timer); timer = null; }
      proxyRes.destroy();
      send();
    }
  });

  proxyRes.on('end', () => {
    send();
  });

  proxyRes.on('error', (e) => {
    console.error(`Proxy buffer error [${type}]:`, e.message);
    if (timer) { clearTimeout(timer); timer = null; }
    if (body.length > 0) {
      send();
    } else if (!res.writableEnded) {
      res.end();
    }
  });
}

// ── URL 재작성: HTML 속성 ─────────────────────────────────────────────────────
function proxyUrl(origUrl, pageBaseUrl) {
  try {
    const resolved = new URL(origUrl, pageBaseUrl);
    // data: / javascript: / blob: / mailto: / tel: 등은 건너뜀
    if (/^(data|javascript|blob|mailto|tel|ftp|file):/i.test(resolved.protocol)) return origUrl;
    return `/api/proxy?url=${encodeURIComponent(resolved.href)}`;
  } catch { return origUrl; }
}

function rewriteUrls(html, pageBaseUrl) {
  // 1. X-Frame-Options / CSP 제거용 메타 주입
  const metaInjection = '<meta http-equiv="Content-Security-Policy" content="frame-ancestors *">';

  // 2. 주요 속성 재작성
  const attrPatterns = [
    { regex: /\s(src|href|action)\s*=\s*"([^"]+)"/gi,   group: 2, multi: false },
    { regex: /\s(src|href|action)\s*=\s*'([^']+)'/gi,   group: 2, multi: false },
  ];

  for (const { regex, group, multi } of attrPatterns) {
    html = html.replace(regex, (match, attr, url) => {
      if (/^(data:|javascript:|blob:|mailto:|#|about:|tel:)/i.test(url)) return match;
      const newUrl = proxyUrl(url, pageBaseUrl);
      return match.replace(url, newUrl);
    });
  }

  // srcset: 여러 URL+descriptor 쌍을 개별 처리
  html = html.replace(/\s(srcset)\s*=\s*"([^"]+)"/gi, (match, attr, value) => {
    const parts = value.split(/\s*,\s*/);
    const rewritten = parts.map((part) => {
      const m = part.match(/^(\S+)(.*)$/);
      if (!m) return part;
      const url = m[1];
      const desc = m[2];
      if (/^(data:|javascript:|blob:|mailto:|#|about:|tel:)/i.test(url)) return part;
      return proxyUrl(url, pageBaseUrl) + desc;
    });
    return ` ${attr}="${rewritten.join(', ')}"`;
  });

  // 3. <head> 바로 뒤에 CSP 완화 메타 삽입
  html = html.replace(/<head[^>]*>/i, (m) => m + metaInjection);

  return html;
}

// ── URL 재작성: CSS url() ─────────────────────────────────────────────────────
function rewriteCssUrls(css, pageBaseUrl) {
  return css.replace(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, url) => {
    if (/^(data:|#|about:)/i.test(url)) return match;
    const newUrl = proxyUrl(url.trim(), pageBaseUrl);
    return `url("${newUrl}")`;
  });
}

// ── Diagnostics ────────────────────────────────────────────────────────────────
app.get('/ping', (_, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    uptime: process.uptime(),
    node: process.version,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
  });
});

// DNS resolve 테스트: 서버가 google.com 등을 resolve 할 수 있는지 확인
app.get('/resolve', async (req, res) => {
  const host = req.query.host || 'google.com';
  const { lookup } = await import('node:dns').catch(() => ({ lookup: null }));
  const timings = {};

  // node:dns/promises
  try {
    const t0 = Date.now();
    const dns = await import('node:dns/promises');
    const result = await dns.lookup(host, { all: true });
    timings.dns = Date.now() - t0;
    res.json({ ok: true, host, addresses: result, timings });
  } catch (e) {
    res.json({ ok: false, host, error: e.message, code: e.code });
  }
});

// 프록시 연결 테스트: 실제 TCP 연결까지만 시도하고 응답
app.get('/probe', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing ?url=' });

  let parsed;
  try { parsed = new URL(targetUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const timings = {};
  const tStart = Date.now();
  const HARD_TIMEOUT = 8000;

  let hardTimer = setTimeout(() => {
    probeReq.destroy();
    res.json({ ok: false, target: targetUrl, error: `TCP connect timeout (8s) — port ${parsed.port || 443} blocked?`, timings });
  }, HARD_TIMEOUT);

  const probeReq = transport.request(
    parsed.href,
    { method: 'HEAD', timeout: HARD_TIMEOUT, rejectUnauthorized: false,
      headers: { 'user-agent': 'CalcProxy-Probe/1.0' } },
    (probeRes) => {
      clearTimeout(hardTimer);
      timings.ttfb = Date.now() - tStart;
      probeRes.resume();
      probeRes.on('end', () => {
        res.json({
          ok: true,
          target: targetUrl,
          status: probeRes.statusCode,
          headers: {
            server: probeRes.headers['server'],
            'content-type': probeRes.headers['content-type'],
          },
          timings,
        });
      });
    }
  );

  probeReq.on('error', (e) => {
    clearTimeout(hardTimer);
    res.json({ ok: false, target: targetUrl, error: e.message, code: e.code, timings });
  });

  probeReq.on('timeout', () => {
    clearTimeout(hardTimer);
    probeReq.destroy();
    res.json({ ok: false, target: targetUrl, error: 'timeout (8s)', timings });
  });

  probeReq.end();
});

// health check
app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`calc-api running on :${PORT}`));
