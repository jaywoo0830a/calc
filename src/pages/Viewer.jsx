import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { marked } from 'marked';
import katex from 'katex';
import JSZip from 'jszip';
import hljs from 'highlight.js';
import ZipTree from '../components/ZipTree.jsx';
import PdfViewer from '../components/PdfViewer.jsx';
import MarkdownAnnotator from '../components/MarkdownAnnotator.jsx';
import { listZips, saveZip, loadZip as loadZipFromDB, deleteZip } from '../lib/storage.js';

import 'katex/contrib/auto-render';
import 'katex/contrib/mhchem';
import 'katex/contrib/copy-tex';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

function processContent(markdown, resolveImage) {
  // ── 토크나이저: 문자 단위로 $$ / $ 블록을 안전하게 추출 ──
  const mathBlocks = [];
  let out = '';
  let i = 0;
  const len = markdown.length;

  while (i < len) {
    // Escape 문자 — 다음 글자와 함께 그대로 통과
    if (markdown[i] === '\\' && i + 1 < len) {
      out += markdown[i] + markdown[i + 1];
      i += 2;
      continue;
    }
    // $$ display math
    if (markdown[i] === '$' && markdown[i + 1] === '$') {
      const start = i;
      i += 2;
      while (i < len) {
        if (markdown[i] === '\\' && i + 1 < len) { i += 2; continue; }
        if (markdown[i] === '$' && markdown[i + 1] === '$') { i += 2; break; }
        i++;
      }
      mathBlocks.push(markdown.slice(start, i));
      out += '%%MATH' + (mathBlocks.length - 1) + '%%';
      continue;
    }
    // $ inline math (allow multi-line within same paragraph)
    if (markdown[i] === '$') {
      const start = i;
      i++;
      while (i < len) {
        // paragraph break (blank line) → stop, inline math shouldn't span paragraphs
        if (markdown[i] === '\n' && i + 1 < len && markdown[i + 1] === '\n') break;
        if (markdown[i] === '\\' && i + 1 < len) { i += 2; continue; }
        if (markdown[i] === '$') { i++; break; }
        i++;
      }
      const raw = markdown.slice(start, i);
      if (raw.startsWith('$') && raw.endsWith('$') && raw.length > 2 && !raw.startsWith('$$')) {
        mathBlocks.push(raw);
        out += '%%MATH' + (mathBlocks.length - 1) + '%%';
      } else {
        out += raw;
      }
      continue;
    }
    out += markdown[i];
    i++;
  }

  let html = marked.parse(out, { breaks: true, gfm: true });
  if (resolveImage) {
    html = html.replace(/<img\s[^>]*\bsrc="([^"]+)"/g, (match, src) => {
      if (/^(https?:|data:|blob:)/.test(src)) return match;
      const blob = resolveImage(src);
      return blob ? match.replace(src, blob) : match;
    });
  }
  html = html.replace(/%%MATH(\d+)%%/g, (_, i) => {
    const m = mathBlocks[+i];
    const tex = m.startsWith('$$') ? m.slice(2, -2).trim() : m.slice(1, -1).trim();
    try { return katex.renderToString(tex, { displayMode: m.startsWith('$$'), throwOnError: false, trust: true, strict: false }); }
    catch { return m; }
  });

  // ── Apply syntax highlighting to code blocks ──────────────────────────
  html = html.replace(/<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g, (match, lang, code) => {
    const decoded = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    try {
      if (lang && hljs.getLanguage(lang)) {
        const highlighted = hljs.highlight(decoded, { language: lang }).value;
        return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
      }
      const auto = hljs.highlightAuto(decoded);
      return `<pre><code class="hljs language-${auto.language || ''}">${auto.value}</code></pre>`;
    } catch {
      return match;
    }
  });

  return html;
}

/** 렌더링된 HTML에서 h1~h3 제목을 추출하여 TOC 배열과 ID 주입된 HTML 반환 */
function extractToc(html) {
  const toc = [];
  let counter = 0;
  const withIds = html.replace(/<(h[123])([^>]*)>([^<]*)<\/\1>/gi, (match, tag, attrs, text) => {
    const id = `hd-${counter++}`;
    const clean = text.replace(/<[^>]+>/g, '').trim();
    toc.push({ id, tag: tag.toLowerCase(), text: clean || '(empty)' });
    return `<${tag}${attrs} id="${id}">${text}</${tag}>`;
  });
  return { html: withIds, toc };
}
function resolveImagePath(src, dir, blobMap) {
  // 이미 절대 URL 이면 그대로
  if (/^(https?:|data:|blob:|\/)/.test(src)) return blobMap[src] || null;

  // 상대 경로 → dir 기준 절대 경로로 정규화
  const parts = (dir + src).split('/');
  const resolved = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { resolved.pop(); continue; }
    resolved.push(p);
  }
  const normalized = resolved.join('/');

  // blobMap 에서 여러 변형 시도
  return blobMap[normalized]
    || blobMap[resolved[resolved.length - 1]]  // 파일명만
    || blobMap[src]                              // 원본 그대로
    || null;
}

export default function Viewer() {
  const [fileName, setFileName] = useState('');
  const [rendered, setRendered] = useState('');
  const [zipId, setZipId] = useState('');              // IndexedDB 키 (상태 복원용)
  const [pdfUrl, setPdfUrl] = useState('');          // PDF blob URL
  const [zipTree, setZipTree] = useState(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [imageBlobs, setImageBlobs] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [storedZips, setStoredZips] = useState([]);
  const [toc, setToc] = useState([]);
  const previewRef = useRef(null);
  const scrollPositions = useRef({});
  const [readability, setReadability] = useState(0);
  const zipRef = useRef(null);

  // ── Search state ────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchIndex = useRef({});  // { path: textContent }
  const searchDebounce = useRef(null);

  // ── 세션 복원: Calc ↔ Viewer 전환 시 상태 유지 ──
  useEffect(() => {
    const saved = sessionStorage.getItem('viewer_state');
    if (!saved) return;
    try {
      const state = JSON.parse(saved);
      if (state.zipId && state.selectedPath) {
        setZipId(state.zipId);
        setFileName(state.fileName || '');
        setReadability(state.readability || 0);
        loadZipFromDB(state.zipId).then((stored) => {
          if (!stored) return;
          JSZip.loadAsync(stored.blob).then(async (zip) => {
            zipRef.current = zip;
            const blobs = await indexImages(zip);
            setImageBlobs(blobs);
            buildSearchIndex(zip);
            const tree = { name: 'root', children: {}, isDir: true };
            for (const [path, f] of Object.entries(zip.files)) {
              const parts = path.split('/'); let node = tree;
              for (let i = 0; i < parts.length; i++) {
                const p = parts[i]; if (!p) continue;
                const last = i === parts.length - 1;
                if (!node.children[p]) node.children[p] = { name: p, children: last ? null : {}, isDir: !last, file: last ? f : null, path };
                node = node.children[p];
              }
            }
            setZipTree(tree);
            setSelectedPath(state.selectedPath);
            if (state.scrollPositions) scrollPositions.current = state.scrollPositions;
            const f = zip.files[state.selectedPath];
            if (f && !f.dir) {
              if (state.selectedPath.endsWith('.pdf')) {
                const blob = await f.async('blob');
                setPdfUrl(URL.createObjectURL(blob));
              } else {
                const dir = state.selectedPath.substring(0, state.selectedPath.lastIndexOf('/') + 1);
                const resolveImg = (src) => resolveImagePath(src, dir, blobs);
                setContent(processContent(await f.async('text'), resolveImg));
              }
            }
          }).catch(() => {});
        }).catch(() => {});
      }
    } catch {}
  }, []);

  // ── 상태 변경 시 sessionStorage에 저장 ──
  useEffect(() => {
    if (!zipId || !selectedPath) return;
    sessionStorage.setItem('viewer_state', JSON.stringify({
      zipId, fileName, selectedPath,
      scrollPositions: scrollPositions.current, readability,
    }));
  }, [zipId, fileName, selectedPath, readability]);  // 0~5 가독성 단계

  // 가독성 스케일: [font, line-height, letter-spacing, paragraph-gap] 승수
  const READABILITY_SCALES = [
    [1,    1,    1,    1    ],  // 0: 기본
    [1.1,  1.08, 1.5,  1.2  ],  // 1
    [1.2,  1.16, 2.0,  1.4  ],  // 2
    [1.35, 1.25, 2.5,  1.7  ],  // 3
    [1.55, 1.38, 3.2,  2.0  ],  // 4
    [1.8,  1.55, 4.0,  2.5  ],  // 5: 최대
  ];

  const readabilityVars = {
    '--md-font-scale':   READABILITY_SCALES[readability][0],
    '--md-lh-scale':     READABILITY_SCALES[readability][1],
    '--md-ls-scale':     READABILITY_SCALES[readability][2],
    '--md-para-scale':   READABILITY_SCALES[readability][3],
    '--md-heading-scale': Math.min(READABILITY_SCALES[readability][0] * 0.85, 1.5),
  };   // 파일별 스크롤 위치 저장

  // 마운트 시 저장된 ZIP 목록 불러오기
  useEffect(() => { listZips().then(setStoredZips).catch(() => {}); }, []);

  // 저장된 ZIP 목록 갱신 함수
  const refreshStored = useCallback(async () => {
    try { setStoredZips(await listZips()); } catch {}
  }, []);

  // HTML 렌더링 + TOC 추출
  const setContent = useCallback((html) => {
    const { html: withIds, toc: headings } = extractToc(html);
    setRendered(withIds);
    setToc(headings);
  }, []);

  // 문서 전환 시 이전 스크롤 위치 저장 + 새 문서 스크롤 복원
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const saved = scrollPositions.current[selectedPath];
    if (saved != null) {
      // requestAnimationFrame 으로 DOM 렌더 후 복원
      requestAnimationFrame(() => { el.scrollTop = saved; });
    } else {
      el.scrollTop = 0;
    }
  }, [rendered, selectedPath]);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const indexImages = useCallback(async (zip) => {
    const blobs = {};
    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir || !/\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(path)) continue;
      const data = await file.async('blob');
      const url = URL.createObjectURL(data);
      blobs[path] = url;
      const base = path.split('/').pop();
      blobs[base] = url; blobs['./' + base] = url; blobs['./' + path] = url;
    }
    return blobs;
  }, []);

  // ── Cleanup blob URLs to prevent memory leaks ────────────────────────
  const blobUrlsRef = useRef(new Set());
  // Revoke old blob URLs when new imageBlobs arrive
  useEffect(() => {
    const oldUrls = blobUrlsRef.current;
    const newUrls = new Set();
    for (const url of Object.values(imageBlobs)) {
      if (typeof url === 'string' && url.startsWith('blob:')) newUrls.add(url);
    }
    // Revoke URLs that are no longer in use
    for (const url of oldUrls) {
      if (!newUrls.has(url)) URL.revokeObjectURL(url);
    }
    blobUrlsRef.current = newUrls;
  }, [imageBlobs]);
  // Revoke old PDF blob URL
  useEffect(() => {
    const prev = blobUrlsRef.current;
    return () => {
      if (pdfUrl && pdfUrl.startsWith('blob:')) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  // ── Build search index from text files in ZIP ──────────────────────────
  const buildSearchIndex = useCallback(async (zip) => {
    const idx = {};
    const textExts = ['.md', '.txt', '.html', '.htm', '.xml', '.json', '.csv', '.tex', '.rst', '.yml', '.yaml', '.toml'];
    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const ext = '.' + path.split('.').pop().toLowerCase();
      if (!textExts.includes(ext) && ext !== '.pdf') continue;
      try {
        const text = await file.async('text');
        idx[path] = text;
      } catch { /* binary, skip */ }
    }
    searchIndex.current = idx;
  }, []);

  // ── Search handler ─────────────────────────────────────────────────────
  const handleSearch = useCallback((query) => {
    setSearchQuery(query);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!query.trim()) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    searchDebounce.current = setTimeout(() => {
      const q = query.toLowerCase();
      const results = [];
      for (const [path, text] of Object.entries(searchIndex.current)) {
        const lower = text.toLowerCase();
        let idx = lower.indexOf(q);
        if (idx === -1) continue;
        // Collect all match positions
        const matches = [];
        let pos = 0;
        while (pos < lower.length) {
          const found = lower.indexOf(q, pos);
          if (found === -1) break;
          matches.push(found);
          pos = found + 1;
        }
        for (const matchPos of matches) {
          // Extract snippet around match
          const start = Math.max(0, matchPos - 60);
          const end = Math.min(text.length, matchPos + q.length + 60);
          let snippet = text.slice(start, end);
          if (start > 0) snippet = '…' + snippet;
          if (end < text.length) snippet = snippet + '…';
          // Highlight the match
          const displayName = path.split('/').pop();
          results.push({ path, displayName, snippet, matchPos: matchPos - start + (start > 0 ? 1 : 0) });
        }
      }
      // Limit to 20 results, sort by path
      results.sort((a, b) => a.path.localeCompare(b.path));
      setSearchResults(results.slice(0, 20));
      setSearchOpen(results.length > 0);
    }, 200);
  }, []);

  const navigateToSearchResult = useCallback((result) => {
    setSearchOpen(false);
    setSearchQuery('');
    if (result.path.endsWith('.pdf')) {
      const zip = zipRef.current;
      if (!zip) return;
      const file = zip.files[result.path];
      if (!file) return;
      file.async('blob').then((blob) => {
        setPdfUrl(URL.createObjectURL(blob));
        setSelectedPath(result.path);
        setRendered('');
      });
    } else {
      // Use the tree node selection path
      const zip = zipRef.current;
      if (!zip) return;
      const file = zip.files[result.path];
      if (!file) return;
      setSelectedPath(result.path);
      const dir = result.path.substring(0, result.path.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir, imageBlobs);
      file.async('text').then((txt) => setContent(processContent(txt, resolveImg)));
    }
  }, [imageBlobs, setContent]);

  const loadZip = useCallback(async (file) => {
    setFileName(file.name);
    scrollPositions.current = {};  // 새 ZIP → 스크롤 위치 초기화
    try {
      const zip = await JSZip.loadAsync(file);
      zipRef.current = zip;                          // 크로스 링크용 보관
      const blobs = await indexImages(zip);
      setImageBlobs(blobs);
      buildSearchIndex(zip);                         // 검색 인덱스 구축

      // IndexedDB에 저장 (원본 blob) → ID 보관
      const blob = file instanceof Blob ? file : new Blob([await file.arrayBuffer()]);
      saveZip(file.name, blob).then((id) => { setZipId(id); refreshStored(); }).catch(() => {});

      const tree = { name: 'root', children: {}, isDir: true };
      for (const [path, f] of Object.entries(zip.files)) {
        const parts = path.split('/'); let node = tree;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]; if (!p) continue;
          const last = i === parts.length - 1;
          if (!node.children[p]) node.children[p] = { name: p, children: last ? null : {}, isDir: !last, file: last ? f : null, path };
          node = node.children[p];
        }
      }
      setZipTree(tree);
      // 첫 번째 .md 파일 찾아서 렌더링
      const first = Object.keys(zip.files).find(p => p.endsWith('.md') && !zip.files[p].dir);
      if (first) {
        setSelectedPath(first);
        const dir = first.substring(0, first.lastIndexOf('/') + 1);
        const resolveImg = (src) => resolveImagePath(src, dir, blobs);
        setContent(processContent(await zip.files[first].async('text'), resolveImg));
      }
    } catch (e) { setContent('<p style="color:red">ZIP error: ' + e.message + '</p>'); }
  }, [indexImages, refreshStored]);

  // IndexedDB에서 저장된 ZIP 불러오기
  const handleLoadStored = useCallback(async (entry) => {
    const stored = await loadZipFromDB(entry.id);
    if (!stored) return;
    setFileName(stored.name);
    setZipId(entry.id);                             // 세션 복원용
    scrollPositions.current = {};
    try {
      const zip = await JSZip.loadAsync(stored.blob);
      zipRef.current = zip;                          // 크로스 링크용 보관
      const blobs = await indexImages(zip);
      setImageBlobs(blobs);
      buildSearchIndex(zip);                         // 검색 인덱스 구축
      const tree = { name: 'root', children: {}, isDir: true };
      for (const [path, f] of Object.entries(zip.files)) {
        const parts = path.split('/'); let node = tree;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]; if (!p) continue;
          const last = i === parts.length - 1;
          if (!node.children[p]) node.children[p] = { name: p, children: last ? null : {}, isDir: !last, file: last ? f : null, path };
          node = node.children[p];
        }
      }
      setZipTree(tree);
      const first = Object.keys(zip.files).find(p => p.endsWith('.md') && !zip.files[p].dir);
      if (first) {
        setSelectedPath(first);
        const dir = first.substring(0, first.lastIndexOf('/') + 1);
        const resolveImg = (src) => resolveImagePath(src, dir, blobs);
        setContent(processContent(await zip.files[first].async('text'), resolveImg));
      }
    } catch (e) { setContent('<p style="color:red">ZIP error: ' + e.message + '</p>'); }
  }, [indexImages]);

  // ZIP 내 문서 간 크로스 링크 처리
  const navigateTo = useCallback(async (href) => {
    const zip = zipRef.current;
    if (!zip) return;
    const [targetPath, hash] = href.split('#');
    const isMd = targetPath.endsWith('.md');
    const isPdf = targetPath.endsWith('.pdf');
    if (!isMd && !isPdf) return;

    // 상대경로 → 절대경로
    const dir = selectedPath.substring(0, selectedPath.lastIndexOf('/') + 1);
    const parts = (dir + targetPath).split('/');
    const resolved = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') { resolved.pop(); continue; }
      resolved.push(p);
    }
    const fullPath = resolved.join('/');

    const file = zip.files[fullPath];
    if (!file || file.dir) return;

    if (previewRef.current) {
      scrollPositions.current[selectedPath] = previewRef.current.scrollTop;
    }
    setSelectedPath(fullPath);

    if (isPdf) {
      const blob = await file.async('blob');
      setPdfUrl(URL.createObjectURL(blob));
      setRendered('');
      return;
    }
    setPdfUrl('');
    try {
      const dir2 = fullPath.substring(0, fullPath.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir2, imageBlobs);
      setContent(processContent(await file.async('text'), resolveImg));
      if (hash) {
        setTimeout(() => {
          const el = document.getElementById(hash);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }
    } catch (e) { setContent('<p style="color:red">Read error: ' + e.message + '</p>'); }
  }, [selectedPath, imageBlobs, setContent]);

  const handleContentClick = useCallback((e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    // 외부 URL은 통과
    if (/^(https?:|data:|blob:|\/\/)/.test(href)) return;
    // 같은 문서 내 해시 링크
    if (href.startsWith('#')) {
      e.preventDefault();
      const el = document.getElementById(href.slice(1));
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // .md 또는 .pdf 파일 링크 → 내부 네비게이션
    if (/\.(md|pdf)(#|$)/.test(href)) {
      e.preventDefault();
      navigateTo(href);
    }
  }, [navigateTo]);
  const handleDeleteStored = useCallback(async (id, e) => {
    e.stopPropagation();
    await deleteZip(id);
    await refreshStored();
  }, [refreshStored]);

  const openFile = useCallback(async (node) => {
    if (!node || !node.file) return;
    // 현재 문서의 스크롤 위치 저장
    if (selectedPath && previewRef.current) {
      scrollPositions.current[selectedPath] = previewRef.current.scrollTop;
    }
    setSelectedPath(node.path);
    // PDF 파일 처리
    if (node.name.endsWith('.pdf')) {
      const blob = await node.file.async('blob');
      const url = URL.createObjectURL(blob);
      setPdfUrl(url);
      setRendered('');
      return;
    }
    setPdfUrl('');
    try {
      const dir = node.path.substring(0, node.path.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir, imageBlobs);
      setContent(processContent(await node.file.async('text'), resolveImg));
    }
    catch (e) { setContent('<p style="color:red">Read error: ' + e.message + '</p>'); }
  }, [imageBlobs, selectedPath, setContent]);

  return (
    <div className={'viewer' + (fullscreen ? ' viewer--fullscreen' : '')} style={readabilityVars}>
      {!fullscreen && (
        <nav className="calculator__nav">
          <a href="/" className="calculator__nav-tab">Calc</a>
          <span className="calculator__nav-tab calculator__nav-tab--active">Viewer</span>
          <a href="/playground" className="calculator__nav-tab">Three.js</a>
          <a href="/math" className="calculator__nav-tab">Math Space</a>
        </nav>
      )}
      {!fullscreen && zipTree && (
        <div className="viewer__search-area">
          <div className="viewer__search-bar">
            <span className="viewer__search-icon">🔍</span>
            <input
              className="viewer__search-input"
              type="text"
              placeholder="Search in all documents…"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              onFocus={() => { if (searchResults.length > 0) setSearchOpen(true); }}
              onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); } }}
            />
            {searchQuery && (
              <button className="viewer__search-clear" onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchOpen(false); }}>×</button>
            )}
          </div>
          {searchOpen && searchResults.length > 0 && (
            <div className="viewer__search-results">
              {searchResults.map((r, i) => (
                <div
                  key={i}
                  className="viewer__search-result"
                  onMouseDown={(e) => { e.preventDefault(); navigateToSearchResult(r); }}
                >
                  <span className="viewer__search-result-file">{r.displayName}</span>
                  <span className="viewer__search-result-snippet">
                    {r.snippet.slice(0, r.matchPos)}
                    <mark>{r.snippet.slice(r.matchPos, r.matchPos + searchQuery.length)}</mark>
                    {r.snippet.slice(r.matchPos + searchQuery.length)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {!fullscreen && (
        <div className="viewer__upload"
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.name.endsWith('.zip')) loadZip(f); }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={() => document.getElementById('zipInput').click()}>
          <input id="zipInput" type="file" accept=".zip" onChange={(e) => { const f = e.target.files[0]; if (f) loadZip(f); }} hidden />
          {fileName
            ? <span><strong>{fileName}</strong> &mdash; drop another ZIP</span>
            : <span>Drop a <strong>ZIP</strong> archive here, or click to browse</span>}
        </div>
      )}
      {!fullscreen && storedZips.length > 0 && (
        <div className="viewer__stored">
          <span className="viewer__stored-title">📦 Saved archives</span>
          {storedZips.map((entry) => (
            <div key={entry.id} className="viewer__stored-item" onClick={() => handleLoadStored(entry)}>
              <span className="viewer__stored-name">{entry.name}</span>
              <button
                className="viewer__stored-delete"
                onClick={(e) => handleDeleteStored(entry.id, e)}
                aria-label={`Delete ${entry.name}`}
              >🗑️</button>
            </div>
          ))}
        </div>
      )}
      <div className="viewer__panes">
        {zipTree && (<>
          <div className={'viewer__sidebar' + (sidebarOpen ? ' viewer__sidebar--open' : '')}>
            <ZipTree tree={zipTree} selectedPath={selectedPath} onSelect={openFile} />
          </div>
          <button className="viewer__sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle file tree" />
        </>)}
        {(toc.length > 0 || pdfUrl) && (<>
          <div className={'viewer__toc-sidebar' + (tocOpen ? ' viewer__toc-sidebar--open' : '')}>
            <div className="viewer__toc-title">📑 On this page</div>
            {toc.length > 0 ? (
              toc.map((h) => (
                <div
                  key={h.id}
                  className={`viewer__toc-item viewer__toc-item--${h.tag}`}
                  onClick={() => {
                    const el = document.getElementById(h.id);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {h.text}
                </div>
              ))
            ) : (
              <div className="viewer__toc-item" style={{ fontStyle: 'italic', cursor: 'default' }}>
                PDF — 서버 변환됨
              </div>
            )}
          </div>
          <button className="viewer__toc-toggle" onClick={() => setTocOpen(!tocOpen)} aria-label="Toggle outline" />
        </>)}
        {/* overlay: 항상 마지막에 렌더링 → 어떤 사이드바든 sibling selector 로 감지 */}
        {(zipTree || toc.length > 0) && (
          <div className="viewer__overlay" onClick={() => { setSidebarOpen(false); setTocOpen(false); }} />
        )}
        <div className={'viewer__preview' + (!zipTree ? ' viewer__preview--full' : '')} ref={previewRef}>
          {pdfUrl ? (
            <PdfViewer url={pdfUrl} filePath={selectedPath} />
          ) : rendered ? (
            <MarkdownAnnotator html={rendered} filePath={selectedPath} onLinkClick={navigateTo} />
          ) : (
            <div className="viewer__empty">Upload a ZIP archive to get started</div>
          )}
        </div>
      </div>
      {(rendered || pdfUrl) && (
        <button
          className="viewer__fullscreen-btn"
          onClick={() => setFullscreen(!fullscreen)}
          aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {fullscreen ? '⊠' : '⛶'}
        </button>
      )}
      {rendered && (
        <div className="viewer__readability">
          <button
            className="viewer__readability-btn"
            onClick={() => setReadability(Math.max(0, readability - 1))}
            disabled={readability === 0}
            aria-label="Decrease readability"
            title="가독성 낮추기"
          >➖</button>
          <span className="viewer__readability-level">{readability === 0 ? '👁️' : readability}</span>
          <button
            className="viewer__readability-btn"
            onClick={() => setReadability(Math.min(5, readability + 1))}
            disabled={readability === 5}
            aria-label="Increase readability"
            title="가독성 높이기"
          >➕</button>
        </div>
      )}
    </div>
  );
}
