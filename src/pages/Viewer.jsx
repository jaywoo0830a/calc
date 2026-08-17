import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { marked } from 'marked';
import { pushRecent, clearRecent, registerRecentNavigate } from '../lib/recentHistory.js';
import katex from 'katex';
import JSZip from 'jszip';
import hljs from 'highlight.js';
import ZipTree from '../components/ZipTree.jsx';
import PdfViewer from '../components/PdfViewer.jsx';
import SolverTimer from '../components/SolverTimer.jsx';
import RandomPicker from '../components/RandomPicker.jsx';
import ViewerProblemsFab from '../components/ViewerProblemsFab.jsx';
import useProblemJump from '../hooks/useProblemJump.js';
import { getZipEntry, setZipEntry, deleteZipEntry, zipEntries } from '../lib/zipCache.js';
import { listZips, saveZip, loadZip as loadZipFromDB, deleteZip } from '../lib/storage.js';
import { api } from '../lib/api.js';

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
    const decoded = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
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

/** HTML entity decode — handles &#39;, &amp;, etc. */
function decodeEntities(text) {
  const el = document.createElement('span');
  el.innerHTML = text;
  return el.textContent;
}

/** 렌더링된 HTML에서 h1~h3 제목을 추출하여 TOC 배열과 ID 주입된 HTML 반환 */
function extractToc(html) {
  const toc = [];
  let counter = 0;
  const withIds = html.replace(/<(h[123])([^>]*)>([^<]*)<\/\1>/gi, (match, tag, attrs, text) => {
    const id = `hd-${counter++}`;
    const clean = decodeEntities(text.replace(/<[^>]+>/g, '').trim());
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
  const [storedOpen, setStoredOpen] = useState(false); // Saved archives — 기본 접힘
  const [toc, setToc] = useState([]);
  // ── 푼/틀린 문제 관리 (서버 DB) ────────────────────────
  const [problems, setProblems] = useState([]);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [problemsFilter, setProblemsFilter] = useState('all'); // all | solved | wrong
  const [problemsScope, setProblemsScope] = useState('current'); // current(현재 문서) | all(전체)
  const [pdfInitialPage, setPdfInitialPage] = useState(null);  // 문제 점프용 시작 페이지
  const [loading, setLoading] = useState(false);               // ZIP 로딩 표시
  const [mdToast, setMdToast] = useState(null);                // 등록 피드백 (PDF와 통일)
  const [dlProgress, setDlProgress] = useState(null);          // 서버 ZIP 다운로드 진행률 { loaded, total }
  const previewRef = useRef(null);
  const scrollPositions = useRef({});
  const pdfState = useRef({});   // { path: { page, scrollTop } } PDF 읽기 위치 보존
  const [readability, setReadability] = useState(0);
  const zipRef = useRef(null);
  const navSeq = useRef(0); // 문서 전환 경합 방지 — 최신 탐색만 적용
  const zipIdRef = useRef('');   // 이벤트/비동기 콜백에서 최신 zipId 참조
  const stateRef = useRef({ zipId: '', fileName: '', selectedPath: '', readability: 0 }); // 세션 저장용 최신 스냅샷
  const zipInfoRef = useRef({ zipId: '', zipName: '' }); // Recent 기록용 현재 ZIP 정보 (활성화 시 동기 갱신)
  const [zipStamp, setZipStamp] = useState(0);           // ZIP 활성화 신호 — Recent 재기록 트리거

  // ── 문제 점프 (위치 탐색 + 스크롤) — useProblemJump 훅으로 분리 ──
  const { queueJump, pendingJumpRef } = useProblemJump({
    previewRef, navSeqRef: navSeq, rendered, selectedPath, onToast: setMdToast,
  });

  // ZIP별 문서 키 — ZIP을 바꿔도 스크롤/PDF 위치가 유지되도록 zipId 포함
  const posKey = useCallback((path) => (zipIdRef.current || '') + '|' + (path || ''), []);

  // 세션 상태 저장 (문서 전환 + PDF 페이지 변경 시 호출)
  const persistState = useCallback(() => {
    const s = stateRef.current;
    if (!s.zipId || !s.selectedPath) return;
    try {
      sessionStorage.setItem('viewer_state', JSON.stringify({
        zipId: s.zipId, fileName: s.fileName, selectedPath: s.selectedPath,
        scrollPositions: scrollPositions.current, pdfState: pdfState.current, readability: s.readability,
      }));
    } catch {}
  }, []);

  // zipId/상태를 ref에 동기화 (posKey/persistState가 항상 최신 값 사용)
  useEffect(() => {
    zipIdRef.current = zipId;
    stateRef.current = { zipId, fileName, selectedPath, readability };
  }, [zipId, fileName, selectedPath, readability]);

  // ZIP 메모리 캐시 등록 + 크기 제한 (최대 3개 — 현재 ZIP은 항상 유지)
  // (모듈 레벨 캐시 — 탭 전환으로 컴포넌트가 언마운트돼도 유지돼 재파싱을 피한다)
  const cacheZip = useCallback((id, entry) => {
    setZipEntry(id, entry, zipIdRef.current);
  }, []);

  // 서버에서 ZIP 다운로드 시 진행률 표시 (로컬 캐시 히트면 콜백이 안 불려 바로 완료)
  const loadZipWithProgress = useCallback(async (id) => {
    setDlProgress(null);
    try {
      return await loadZipFromDB(id, (loaded, total) => setDlProgress({ loaded, total }));
    } finally {
      setDlProgress(null);
    }
  }, []);

  // ── Search state ────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchIndex = useRef({});  // { path: textContent }
  const searchDebounce = useRef(null);

  // ── 세션 복원: Calc ↔ Viewer 전환 시 상태 유지 ──
  // 메모리 캐시(모듈 레벨)에 있으면 다운로드/파싱 없이 즉시 복원한다.
  useEffect(() => {
    const saved = sessionStorage.getItem('viewer_state');
    if (!saved) return;
    const seq = ++navSeq.current; // 이 복원보다 새로운 탐색이 있으면 무시
    setLoading(true);
    try {
      const state = JSON.parse(saved);
      if (!state.zipId || !state.selectedPath) { setLoading(false); return; }

      const applyEntry = (entry, zip, blobs, idx, tree) => {
        zipRef.current = zip;
        searchIndex.current = idx;
        zipIdRef.current = state.zipId;
        zipInfoRef.current = { zipId: state.zipId, zipName: entry.fileName || state.fileName || '' };
        setZipId(state.zipId);
        setFileName(entry.fileName || state.fileName || '');
        setReadability(state.readability || 0);
        setImageBlobs(blobs);
        setZipTree(tree);
        setZipStamp((s) => s + 1);
        setSelectedPath(state.selectedPath);
        if (state.scrollPositions) scrollPositions.current = state.scrollPositions;
        if (state.pdfState) pdfState.current = state.pdfState;
      };

      const renderDoc = async (zip, blobs) => {
        const f = zip.files[state.selectedPath];
        if (!f || f.dir) { setLoading(false); return; }
        if (state.selectedPath.endsWith('.pdf')) {
          const blob = await f.async('blob');
          if (seq !== navSeq.current) return;
          const url = URL.createObjectURL(blob);
          pdfBlobUrlsRef.current.add(url);
          setToc([]);
          setPdfUrl(url);
          setLoading(false);
        } else {
          const dir = state.selectedPath.substring(0, state.selectedPath.lastIndexOf('/') + 1);
          const resolveImg = (src) => resolveImagePath(src, dir, blobs);
          const html = processContent(await f.async('text'), resolveImg);
          if (seq !== navSeq.current) return;
          setContent(html);
          setLoading(false);
        }
      };

      // ① 메모리 캐시 히트 — 탭 전환 후 돌아온 경우: 파싱 없이 즉시 복원
      const cached = getZipEntry(state.zipId);
      if (cached) {
        applyEntry(cached, cached.zip, cached.blobs, cached.searchIndex, cached.tree);
        renderDoc(cached.zip, cached.blobs);
        return;
      }

      // ② 캐시 없음(새로고침 등) — IndexedDB/서버에서 다시 로드 + 파싱
      loadZipWithProgress(state.zipId).then((stored) => {
        if (!stored) { setLoading(false); return; }
        JSZip.loadAsync(stored.blob).then(async (zip) => {
          const blobs = await indexImages(zip);
          if (seq !== navSeq.current) return; // 최신 탐색으로 대체됨
          const idx = await buildSearchIndex(zip);
          const tree = buildZipTree(zip);
          if (seq !== navSeq.current) return;
          const entry = { zip, fileName: stored.name || state.fileName || '', tree, blobs, searchIndex: idx };
          cacheZip(state.zipId, entry);
          applyEntry(entry, zip, blobs, idx, tree);
          renderDoc(zip, blobs);
        }).catch(() => { if (seq === navSeq.current) setLoading(false); });
      }).catch(() => { if (seq === navSeq.current) setLoading(false); });
    } catch {}
  }, []);

  // ── 상태 변경 시 sessionStorage에 저장 (PDF 위치 포함) ──
  useEffect(() => {
    persistState();
  }, [zipId, fileName, selectedPath, readability, persistState]);  // 0~5 가독성 단계

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

  // 문제 목록 로드
  const refreshProblems = useCallback(() => {
    api.listProblems().then(setProblems).catch(() => {});
  }, []);
  useEffect(() => { refreshProblems(); }, [refreshProblems]);

  // HTML 렌더링 + TOC 추출
  const setContent = useCallback((html) => {
    const { html: withIds, toc: headings } = extractToc(html);
    setRendered(withIds);
    setToc(headings);
  }, []);

  // 문서 전환 시 이전 스크롤 위치 저장 + 새 문서 스크롤 복원 (ZIP별 키)
  // (유효한 문제 점프가 대기 중이면 건너뜀 — 점프 effect가 중심 정렬 스크롤 담당)
  useEffect(() => {
    const el = previewRef.current;
    if (!el || pdfUrl) return; // PDF는 PdfAnnotator가 자체 복원
    const pending = pendingJumpRef.current;
    if (pending && pending.seq === navSeq.current) return;
    const saved = scrollPositions.current[posKey(selectedPath)];
    if (saved != null) {
      // requestAnimationFrame 으로 DOM 렌더 후 복원
      requestAnimationFrame(() => { el.scrollTop = saved; });
    } else {
      el.scrollTop = 0;
    }
  }, [rendered, selectedPath, pdfUrl, posKey]);

  // PDF 페이지/스크롤 위치 보고 수신 (ZIP별 보존 + 세션 저장 — 스크롤마다 저장하지 않도록 디바운스)
  useEffect(() => {
    let saveTimer = null;
    const onPage = (e) => {
      const { path, page, scrollTop } = e.detail || {};
      if (!path || !page) return;
      pdfState.current[posKey(path)] = { page, scrollTop: scrollTop || 0 };
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persistState(), 400);
    };
    window.addEventListener('viewer:pdf-page', onPage);
    return () => {
      window.removeEventListener('viewer:pdf-page', onPage);
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [posKey, persistState]);
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
  const blobUrlsRef = useRef(new Set());  const pdfBlobUrlsRef = useRef(new Set()); // PDF blob URL 별도 추적 (급전환 시 누수 방지)  // Revoke old blob URLs when new imageBlobs arrive
  useEffect(() => {
    const oldUrls = blobUrlsRef.current;
    const newUrls = new Set();
    const collect = (blobs) => {
      for (const url of Object.values(blobs)) {
        if (typeof url === 'string' && url.startsWith('blob:')) newUrls.add(url);
      }
    };
    // 현재 ZIP + 캐시에 남아있는 모든 ZIP의 이미지 URL은 유지 (Recent 전환 대비)
    collect(imageBlobs);
    for (const [, entry] of zipEntries()) collect(entry.blobs);
    // Revoke URLs that are no longer in use
    for (const url of oldUrls) {
      if (!newUrls.has(url)) URL.revokeObjectURL(url);
    }
    blobUrlsRef.current = newUrls;
  }, [imageBlobs]);
  // Revoke orphaned PDF blob URLs (PDF→PDF 급전환 시 누락 방지)
  useEffect(() => {
    const keep = new Set();
    if (pdfUrl && pdfUrl.startsWith('blob:')) keep.add(pdfUrl);
    for (const url of pdfBlobUrlsRef.current) {
      if (!keep.has(url)) URL.revokeObjectURL(url);
    }
    pdfBlobUrlsRef.current = keep;
  }, [pdfUrl]);

  // 언마운트 시 남은 blob URL 전체 해제 + 검색 디바운스 정리 (메모리 누수 방지)
  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
      for (const url of pdfBlobUrlsRef.current) URL.revokeObjectURL(url);
      blobUrlsRef.current.clear();
      pdfBlobUrlsRef.current.clear();
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, []);

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
    return idx;
  }, []);

  // ZIP 파일 구조 → 트리 (Recent에서 ZIP 전환 시 재구축용)
  const buildZipTree = useCallback((zip) => {
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
    return tree;
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
        if (typeof text !== 'string') { console.warn('[search-index] non-string entry', path, typeof text, text); continue; }
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
    const seq = ++navSeq.current;                    // 검색 결과 이동 = 최신 탐색
    setSearchOpen(false);
    setSearchQuery('');
    if (selectedPath && previewRef.current) {
      scrollPositions.current[posKey(selectedPath)] = previewRef.current.scrollTop;
    }
    if (result.path.endsWith('.pdf')) {
      const zip = zipRef.current;
      if (!zip) return;
      const file = zip.files[result.path];
      if (!file) return;
      file.async('blob').then((blob) => {
        if (seq !== navSeq.current) return;
        const url = URL.createObjectURL(blob);
        pdfBlobUrlsRef.current.add(url);
        setPdfUrl(url);
        setSelectedPath(result.path);
        setRendered('');
        setToc([]);
        setPdfInitialPage(pdfState.current[posKey(result.path)]?.page || null);
        setLoading(false);
      });
    } else {
      // Use the tree node selection path
      const zip = zipRef.current;
      if (!zip) return;
      const file = zip.files[result.path];
      if (!file) return;
      setSelectedPath(result.path);
      setPdfUrl('');            // PDF → 마크다운 전환 시 PDF 뷰어 해제 (누락 버그 수정)
      setPdfInitialPage(null);
      const dir = result.path.substring(0, result.path.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir, imageBlobs);
      file.async('text').then((txt) => {
        if (seq !== navSeq.current) return;
        setContent(processContent(txt, resolveImg));
        setLoading(false);
      });
    }
  }, [imageBlobs, setContent, selectedPath, posKey]);

  const loadZip = useCallback(async (file) => {
    if (file.size > 1024 * 1024 * 1024) {          // 클라이언트 사전 차단 — JSZip 파싱 전
      setMdToast('ZIP too large — max 1 GB');
      return;
    }
    const seq = ++navSeq.current;                    // 새 업로드 = 최신 탐색
    setLoading(true);
    setFileName(file.name);
    try {
      const zip = await JSZip.loadAsync(file);
      if (seq !== navSeq.current) return;            // 더 새로운 업로드/탐색이 시작됨
      zipRef.current = zip;                          // 크로스 링크용 보관
      const blobs = await indexImages(zip);
      if (seq !== navSeq.current) return;
      const idx = await buildSearchIndex(zip);        // 검색 인덱스 구축 (ref도 내부에서 갱신)
      const tree = buildZipTree(zip);
      if (seq !== navSeq.current) return;

      // 클라우드(서버) 업로드 — 네트워크 장애면 로컬에 저장 (둘 다 지원).
      // 서버가 거부(용량 초과 등)하면 로컬 폴백 없이 에러 토스트.
      let id = '';
      try {
        const blob = file instanceof Blob ? file : new Blob([await file.arrayBuffer()]);
        id = await saveZip(file.name, blob);
        if (id.startsWith('local_')) setMdToast('Offline — saved on this device');
        refreshStored();
      } catch (e) {
        setMdToast('Upload failed — ' + (e && e.message ? e.message : 'check the server'));
      }
      if (!id) id = 'mem-' + Date.now();
      if (seq !== navSeq.current) return;

      setZipId(id);
      zipIdRef.current = id;
      zipInfoRef.current = { zipId: id, zipName: file.name };
      setZipStamp((s) => s + 1);
      setImageBlobs(blobs);
      searchIndex.current = idx;
      setZipTree(tree);
      cacheZip(id, { zip, fileName: file.name, tree, blobs, searchIndex: idx });
      // 처음엔 빈 상태로 시작 — 사용자가 사이드바에서 파일을 직접 선택
      setSelectedPath('');
      setPdfUrl('');
      setRendered('');
      setToc([]);
      setLoading(false);
    } catch (e) {
      if (seq === navSeq.current) { setLoading(false); setContent('<p style="color:red">ZIP error: ' + e.message + '</p>'); }
    }
  }, [indexImages, buildSearchIndex, buildZipTree, refreshStored, cacheZip]);

  // IndexedDB에서 저장된 ZIP 불러오기 (이미 열려 있던 ZIP은 캐시 재사용)
  const handleLoadStored = useCallback(async (entry) => {
    const seq = ++navSeq.current;                    // 새로 불러온 ZIP = 최신 탐색
    setLoading(true);

    // 이미 열려 있던 ZIP → 캐시에서 즉시 전환 (빈 상태로 시작)
    const cached = getZipEntry(entry.id);
    if (cached) {
      if (seq !== navSeq.current) return;
      zipRef.current = cached.zip;
      zipIdRef.current = entry.id;
      zipInfoRef.current = { zipId: entry.id, zipName: cached.fileName };
      setZipStamp((s) => s + 1);
      setZipId(entry.id);
      setFileName(cached.fileName);
      setImageBlobs(cached.blobs);
      searchIndex.current = cached.searchIndex;
      setZipTree(cached.tree);
      setSelectedPath('');
      setPdfUrl('');
      setRendered('');
      setToc([]);
      setLoading(false);
      return;
    }

    const stored = await loadZipWithProgress(entry.id).catch(() => {
      setLoading(false);
      setMdToast("Couldn't load the ZIP from the server");
      return null;
    });
    if (!stored) { setLoading(false); return; }
    setFileName(stored.name);
    setZipId(entry.id);                             // 세션 복원용
    try {
      const zip = await JSZip.loadAsync(stored.blob);
      if (seq !== navSeq.current) return;
      zipRef.current = zip;                          // 크로스 링크용 보관
      const blobs = await indexImages(zip);
      if (seq !== navSeq.current) return;
      const idx = await buildSearchIndex(zip);        // 검색 인덱스 구축 (ref도 내부에서 갱신)
      const tree = buildZipTree(zip);
      if (seq !== navSeq.current) return;
      setImageBlobs(blobs);
      searchIndex.current = idx;
      setZipTree(tree);
      cacheZip(entry.id, { zip, fileName: stored.name, tree, blobs, searchIndex: idx });
      zipInfoRef.current = { zipId: entry.id, zipName: stored.name };
      setZipStamp((s) => s + 1);
      // 처음엔 빈 상태로 시작 — 사용자가 사이드바에서 파일을 직접 선택
      setSelectedPath('');
      setPdfUrl('');
      setRendered('');
      setToc([]);
      setLoading(false);
    } catch (e) {
      if (seq === navSeq.current) { setLoading(false); setContent('<p style="color:red">ZIP error: ' + e.message + '</p>'); }
    }
  }, [indexImages, buildSearchIndex, buildZipTree, cacheZip]);

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
    const seq = ++navSeq.current;                    // 이 링크 이동이 최신 탐색

    if (previewRef.current) {
      scrollPositions.current[posKey(selectedPath)] = previewRef.current.scrollTop;
    }
    setSelectedPath(fullPath);

    if (isPdf) {
      const blob = await file.async('blob');
      if (seq !== navSeq.current) return;
      const url = URL.createObjectURL(blob);
      pdfBlobUrlsRef.current.add(url);
      setPdfUrl(url);
      setRendered('');
      setToc([]);
      setPdfInitialPage(pdfState.current[posKey(fullPath)]?.page || null);
      setLoading(false);
      return;
    }
    setPdfUrl('');
    setPdfInitialPage(null);
    try {
      const dir2 = fullPath.substring(0, fullPath.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir2, imageBlobs);
      const html = processContent(await file.async('text'), resolveImg);
      if (seq !== navSeq.current) return;
      setContent(html);
      setLoading(false);
      if (hash) {
        setTimeout(() => {
          const el = document.getElementById(hash);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }
    } catch (e) { setContent('<p style="color:red">Read error: ' + e.message + '</p>'); }
  }, [selectedPath, imageBlobs, setContent, posKey]);

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

  // 등록 피드백 자동 해제
  useEffect(() => {
    if (!mdToast) return;
    const t = setTimeout(() => setMdToast(null), 2000);
    return () => clearTimeout(t);
  }, [mdToast]);

  // ── RangeSelect(✂️ Selecting) → 문제 등록 (마크다운 문서) ──
  // PDF가 열려 있으면 PdfAnnotator가 처리하므로 여기선 건너뛴다.
  useEffect(() => {
    if (pdfUrl) return;
    const onMark = (e) => {
      const { text, status, ref } = e.detail || {};
      if (!text || !status || !selectedPath) return;
      api.saveProblem({
        docId: selectedPath,
        docPath: selectedPath,
        // ref는 RangeSelect가 선택 확정 시점에 계산해 전달한다.
        // (버튼 클릭으로 선택이 지워진 뒤에는 계산 불가 — 여기서 다시 안 구함)
        ref: ref || '',
        text: String(text).slice(0, 500),
        status,
      }).then(() => {
        refreshProblems();
        setMdToast(status === 'solved' ? '✓ Marked as solved' : '✗ Marked as wrong');
      }).catch(() => {
        setMdToast('Failed to save — check server');
      });
    };
    window.addEventListener('problems:mark', onMark);
    return () => window.removeEventListener('problems:mark', onMark);
  }, [pdfUrl, selectedPath, refreshProblems]);

  // 다른 ZIP의 문서로 전환 — 메모리 캐시 또는 IndexedDB에서 로드 후 문서 오픈
  // opts.jump: 문제 점프용 (점프 대기 등록 / PDF 시작 페이지)
  const switchToZipDoc = useCallback(async (targetZipId, path, opts = {}) => {
    const seq = ++navSeq.current;                    // ZIP 전환 = 최신 탐색
    setLoading(true);
    try {
      let entry = getZipEntry(targetZipId);
      if (!entry) {
        const stored = await loadZipWithProgress(targetZipId);
        if (!stored) { setLoading(false); return; }
        const zip = await JSZip.loadAsync(stored.blob);
        const blobs = await indexImages(zip);
        const idx = await buildSearchIndex(zip);
        const tree = buildZipTree(zip);
        entry = { zip, fileName: stored.name, tree, blobs, searchIndex: idx };
        cacheZip(targetZipId, entry);
      }
      if (seq !== navSeq.current) return;
      zipRef.current = entry.zip;
      zipIdRef.current = targetZipId;
      zipInfoRef.current = { zipId: targetZipId, zipName: entry.fileName };
      setZipStamp((s) => s + 1);
      setZipId(targetZipId);
      setFileName(entry.fileName);
      setImageBlobs(entry.blobs);
      searchIndex.current = entry.searchIndex;
      setZipTree(entry.tree);

      const file = entry.zip.files[path];
      if (!file || file.dir) { setLoading(false); return; }
      setSelectedPath(path);
      if (path.endsWith('.pdf')) {
        const blob = await file.async('blob');
        if (seq !== navSeq.current) return;
        const url = URL.createObjectURL(blob);
        pdfBlobUrlsRef.current.add(url);
        setPdfUrl(url);
        setRendered('');
        setToc([]);
        setPdfInitialPage(opts.jump?.ref ? Number(opts.jump.ref) || null : (pdfState.current[posKey(path)]?.page || null));
        setLoading(false);
        return;
      }
      const dir = path.substring(0, path.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir, entry.blobs);
      const txt = await file.async('text');
      if (seq !== navSeq.current) return;
      setPdfUrl('');
      setPdfInitialPage(null);
      setContent(processContent(txt, resolveImg));
      if (opts.jump) queueJump(opts.jump, seq);
      setLoading(false);
    } catch (e) {
      if (seq === navSeq.current) { setLoading(false); setContent('<p style="color:red">ZIP error: ' + e.message + '</p>'); }
    }
  }, [indexImages, buildSearchIndex, buildZipTree, cacheZip, posKey, setContent]);

  // ── 푼/틀린 문제 패널 ──────────────────────────────────
  const jumpToProblem = useCallback((p) => {
    const { doc_path } = p || {};
    console.log('[problem-jump] entry', doc_path, (p && p.text || '').slice(0, 40));
    const zip = zipRef.current;
    // 현재 ZIP에 없으면 다른 열린 ZIP에서 찾아 전환 후 점프
    if (!zip || !zip.files[doc_path] || zip.files[doc_path].dir) {
      for (const [id, entry] of zipEntries()) {
        const f = entry.zip.files[doc_path];
        if (f && !f.dir) { switchToZipDoc(id, doc_path, { jump: p }); return; }
      }
      // 어느 ZIP에도 없는 문서 — 패널 닫고 안내
      console.warn('[problem-jump] document not found in any open zip:', doc_path);
      setMdToast("Couldn't find the document for this problem");
      setProblemsOpen(false);
      return;
    }
    const file = zip.files[doc_path];
    const seq = ++navSeq.current;                    // 문제 점프 = 최신 탐색
    setSelectedPath(doc_path);
    if (doc_path.endsWith('.pdf')) {
      setPdfInitialPage(p.ref ? Number(p.ref) || null : null);
      file.async('blob').then((blob) => {
        if (seq !== navSeq.current) return;
        const url = URL.createObjectURL(blob);
        pdfBlobUrlsRef.current.add(url);
        setPdfUrl(url);
        setRendered('');
        setToc([]);
        setLoading(false);
      });
    } else {
      setPdfInitialPage(null);
      setPdfUrl('');
      // 같은 문서가 이미 렌더링되어 있으면 재렌더 없이 기존 DOM에서 바로 점프
      // (파일 재읽기/재렌더 체인이 실패 지점이 될 수 있어 우회 — 빠르고 안정적)
      if (doc_path === selectedPath && rendered) {
        queueJump(p, seq);
        setProblemsOpen(false);
        return;
      }
      const dir = doc_path.substring(0, doc_path.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir, imageBlobs);
      file.async('text').then((txt) => {
        if (seq !== navSeq.current) return;
        setContent(processContent(txt, resolveImg));
        setLoading(false);
        // 렌더링 완료 후 위치 탐색 (useProblemJump effect가 처리)
        queueJump(p, seq);
      }).catch(() => {
        setMdToast('Failed to open the document');
      });
    }
    setProblemsOpen(false);
  }, [imageBlobs, setContent, switchToZipDoc, selectedPath, rendered, queueJump]);

  // 상태 지정(맞음/틀림) — 같은 상태 재클릭도 "한 번 더 풀었다"로 attempts 기록
  const setProblemStatus = useCallback((p, status) => {
    api.updateProblem(p.id, { status, attempts: p.attempts + 1 }).then(refreshProblems).catch(() => {});
  }, [refreshProblems]);

  const removeProblem = useCallback((p) => {
    api.deleteProblem(p.id).then(refreshProblems).catch(() => {});
  }, [refreshProblems]);

  // 문제 문서가 열려 있는 ZIP들 중 어딘가에 존재하는지 (점프 가능 여부)
  const isDocInCurrentZip = useCallback((docPath) => {
    if (zipRef.current && zipRef.current.files && zipRef.current.files[docPath] && !zipRef.current.files[docPath].dir) return true;
    for (const [, entry] of zipEntries()) {
      const f = entry.zip.files && entry.zip.files[docPath];
      if (f && !f.dir) return true;
    }
    return false;
  }, []);

  // 현재 문서 기준 필터: 'current'면 열린 문서만, 'all'이면 전체 (문서별 그룹)
  const effectiveScope = (problemsScope === 'current' && selectedPath) ? 'current' : 'all';
  const docProblems = useMemo(() => {
    let list = problems;
    if (effectiveScope === 'current') {
      list = list.filter((p) => p.doc_path === selectedPath);
    }
    if (problemsFilter !== 'all') {
      list = list.filter((p) => p.status === problemsFilter);
    }
    return list;
  }, [problems, problemsFilter, effectiveScope, selectedPath]);

  const groupedProblems = useMemo(() => {
    const groups = new Map();
    for (const p of docProblems) {
      if (!groups.has(p.doc_path)) groups.set(p.doc_path, []);
      groups.get(p.doc_path).push(p);
    }
    return [...groups.entries()];
  }, [docProblems]);

  const handleDeleteStored = useCallback(async (id, e) => {
    e.stopPropagation();
    await deleteZip(id);
    // 메모리 캐시에서도 제거 — 다시 불러올 수 없으므로 이미지 blob URL 즉시 해제 (현재 ZIP이 아니어야 안전)
    const cached = getZipEntry(id);
    if (cached && id !== zipIdRef.current) {
      deleteZipEntry(id);
      for (const url of Object.values(cached.blobs || {})) {
        if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
    }
    await refreshStored();
  }, [refreshStored]);

  const openFile = useCallback(async (node) => {
    if (!node || !node.file) return;
    const seq = ++navSeq.current;                    // 트리 클릭 = 최신 탐색
    // 현재 문서의 스크롤 위치 저장
    if (selectedPath && previewRef.current) {
      scrollPositions.current[posKey(selectedPath)] = previewRef.current.scrollTop;
    }
    setSelectedPath(node.path);
    // PDF 파일 처리
    if (node.name.endsWith('.pdf')) {
      const blob = await node.file.async('blob');
      if (seq !== navSeq.current) return;
      const url = URL.createObjectURL(blob);
      pdfBlobUrlsRef.current.add(url);
      setPdfUrl(url);
      setRendered('');
      setToc([]);
      setPdfInitialPage(pdfState.current[posKey(node.path)]?.page || null);
      setLoading(false);
      return;
    }
    setPdfUrl('');
    setPdfInitialPage(null);
    try {
      const dir = node.path.substring(0, node.path.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir, imageBlobs);
      const html = processContent(await node.file.async('text'), resolveImg);
      if (seq !== navSeq.current) return;
      setContent(html);
      setLoading(false);
    }
    catch (e) { setContent('<p style="color:red">Read error: ' + e.message + '</p>'); }
  }, [imageBlobs, selectedPath, setContent, posKey]);

  // ── 최근 문서 히스토리 (전역 플로팅 🕘 버튼과 공유) ──
  // 문서가 열릴 때마다 (트리/크로스링크/검색/문제점프/복원) 히스토리에 기록.
  // ZIP을 여러 개 열어도 목록이 유지되어 🕘에서 서로 전환할 수 있다.
  useEffect(() => {
    // zipId/fileName state는 ZIP 로딩 타이밍에 따라 낡을 수 있어(예: 업로드 시작 시
    // fileName이 먼저 바뀌고 zipId는 나중에 커밋), ZIP을 실제로 활성화한 순간
    // 동기 갱신하는 zipInfoRef에서 읽어 안전하게 기록한다.
    if (!selectedPath) return;
    const { zipId: z, zipName } = zipInfoRef.current;
    pushRecent({ zipId: z, zipName, path: selectedPath });
  }, [selectedPath, zipStamp]);

  // 히스토리 항목 클릭 → 해당 문서를 트리 없이 다시 열기 (다른 ZIP이면 전환)
  const openRecent = useCallback((item) => {
    const { zipId: itemZipId, path } = item;
    const zip = zipRef.current;

    // 다른 ZIP의 문서면 해당 ZIP으로 전환 후 열기.
    // (현재 ZIP에 그 경로가 없어도 동작해야 하므로 파일 존재 확인보다 먼저 처리)
    if (itemZipId && itemZipId !== zipId) {
      switchToZipDoc(itemZipId, path);
      return;
    }
    // 저장 실패로 ID가 없던 낡은 항목 — 현재 ZIP으로 잘못 열지 않도록 무시
    if (!itemZipId && zipId) return;

    if (!zip) return;
    const file = zip.files[path];
    if (!file || file.dir) return;

    const seq = ++navSeq.current;                    // 히스토리 이동 = 최신 탐색
    if (selectedPath && previewRef.current) {
      scrollPositions.current[posKey(selectedPath)] = previewRef.current.scrollTop;
    }
    setSelectedPath(path);
    if (path.endsWith('.pdf')) {
      file.async('blob').then((blob) => {
        if (seq !== navSeq.current) return;
        const url = URL.createObjectURL(blob);
        pdfBlobUrlsRef.current.add(url);
        setPdfUrl(url);
        setRendered('');
        setToc([]);
        setPdfInitialPage(pdfState.current[posKey(path)]?.page || null);
        setLoading(false);
      });
      return;
    }
    setPdfUrl('');
    setPdfInitialPage(null);
    const dir = path.substring(0, path.lastIndexOf('/') + 1);
    const resolveImg = (src) => resolveImagePath(src, dir, imageBlobs);
    file.async('text').then((txt) => {
      if (seq !== navSeq.current) return;
      setContent(processContent(txt, resolveImg));
      setLoading(false);
    }).catch(() => { setLoading(false); });
  }, [imageBlobs, selectedPath, setContent, zipId, switchToZipDoc, posKey]);

  // 전역 🕘 버튼이 문서를 열도록 내비게이션 핸들러 등록
  useEffect(() => registerRecentNavigate(openRecent), [openRecent]);

  // Viewer를 떠나면 핸들러 해제 + 히스토리 정리
  useEffect(() => () => { registerRecentNavigate(null); clearRecent(); }, []);

  return (
    <div className={'viewer' + (fullscreen ? ' viewer--fullscreen' : '')} style={readabilityVars}>
      {!fullscreen && (
        <nav className="calculator__nav">
          <Link to="/" className="calculator__nav-tab">Calc</Link>
          <span className="calculator__nav-tab calculator__nav-tab--active">Viewer</span>
          <Link to="/playground" className="calculator__nav-tab">Three.js</Link>
          <Link to="/math" className="calculator__nav-tab">Math Space</Link>
          <Link to="/vocab" className="calculator__nav-tab">Vocab</Link>
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
          <button
            className="viewer__stored-toggle"
            onClick={() => setStoredOpen(!storedOpen)}
            title={storedOpen ? 'Collapse saved archives' : 'Expand saved archives'}
          >
            <span className="viewer__stored-title">📦 Saved archives ({storedZips.length})</span>
            <span className="viewer__stored-arrow">{storedOpen ? '▴' : '▾'}</span>
          </button>
          {storedOpen && storedZips.map((entry) => (
            <div key={entry.id} className="viewer__stored-item" onClick={() => handleLoadStored(entry)}>
              <span className="viewer__stored-name">
                {entry.name}
                {entry.source === 'local' && (
                  <em className="viewer__stored-badge" title="Saved on this device only">💾 Local</em>
                )}
              </span>
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
                PDF document
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
            <PdfViewer url={pdfUrl} filePath={selectedPath} initialPage={pdfInitialPage} initialScrollTop={pdfState.current[posKey(selectedPath)]?.scrollTop} />
          ) : rendered ? (
            <div className="viewer__content markdown-body" dangerouslySetInnerHTML={{ __html: rendered }} onClick={handleContentClick} />
          ) : !loading ? (
            <div className="viewer__empty">{zipTree ? 'Select a file from the sidebar to start reading' : 'Upload a ZIP archive to get started'}</div>
          ) : null}
          {loading && (
            <div className="viewer__loading-overlay">
              <div className="viewer__spinner" />
              {dlProgress ? (
                <>
                  <span>
                    Downloading…{' '}
                    {dlProgress.total > 0
                      ? Math.min(100, Math.round((dlProgress.loaded / dlProgress.total) * 100)) + '%'
                      : (dlProgress.loaded / 1048576).toFixed(0) + ' MB'}
                  </span>
                  <div className="viewer__progress">
                    <div
                      className="viewer__progress-bar"
                      style={{
                        width: (dlProgress.total > 0
                          ? Math.min(100, (dlProgress.loaded / dlProgress.total) * 100)
                          : 10) + '%',
                      }}
                    />
                  </div>
                </>
              ) : (
                <span>Loading…</span>
              )}
            </div>
          )}
        </div>
      </div>
      {/* 좌하단 플로팅 문제 버튼 — 항상 표시 (PDF 풀스크린 포함, 포털로 렌더링).
          PDF에서는 PdfAnnotator의 Problems 사이드바를 토글한다. */}
      <ViewerProblemsFab
        active={problemsOpen && !pdfUrl}
        pdfMode={!!pdfUrl}
        onToggle={() => {
          if (pdfUrl) {
            window.dispatchEvent(new CustomEvent('pdf:toggle-problems'));
            return;
          }
          setProblemsOpen(!problemsOpen);
          if (!problemsOpen) refreshProblems();
        }}
      />
      {/* 좌하단 플로팅 10분 문제 풀이 타이머 (마크다운/PDF 공통) */}
      <SolverTimer />
      {/* 좌하단 플로팅 🎲 랜덤 숫자 뽑기 */}
      <RandomPicker
        toc={toc}
        onJumpHeading={(id) => {
          const el = document.getElementById(id);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      />
      {/* 하단 우측 컨트롤 — 가로 정렬 */}
      <div className="viewer__controls">
        {rendered && (
          <div className="viewer__readability">
            <button
              className="viewer__readability-btn"
              onClick={() => setReadability(Math.max(0, readability - 1))}
              disabled={readability === 0}
              aria-label="Decrease readability"
              title="Decrease readability"
            >➖</button>
            <span className="viewer__readability-level">{readability === 0 ? '👁️' : readability}</span>
            <button
              className="viewer__readability-btn"
              onClick={() => setReadability(Math.min(5, readability + 1))}
              disabled={readability === 5}
              aria-label="Increase readability"
              title="Increase readability"
            >➕</button>
          </div>
        )}
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
      </div>
      {mdToast && <div className="viewer__md-toast">{mdToast}</div>}

      {/* 푼/틀린 문제 관리 (마크다운 전용 — PDF는 자체 패널 사용) */}
      {!pdfUrl && problemsOpen && (
        <div className="viewer__problems-panel">
          <div className="viewer__problems-header">
            <span className="viewer__problems-title">📋 Problems ({docProblems.length})</span>
            <button className="viewer__problems-close" onClick={() => setProblemsOpen(false)}>×</button>
          </div>
          <div className="viewer__problems-toolbar">
            <div className="viewer__problems-scope">
              <button
                className={'viewer__problems-filter' + (effectiveScope === 'current' ? ' viewer__problems-filter--active' : '')}
                onClick={() => setProblemsScope('current')}
                disabled={!selectedPath}
                title="Show problems in the currently open document"
              >This doc</button>
              <button
                className={'viewer__problems-filter' + (effectiveScope === 'all' ? ' viewer__problems-filter--active' : '')}
                onClick={() => setProblemsScope('all')}
                title="Show problems from all documents"
              >All docs</button>
            </div>
            <div className="viewer__problems-filters">
              <button
                className={'viewer__problems-filter' + (problemsFilter === 'all' ? ' viewer__problems-filter--active' : '')}
                onClick={() => setProblemsFilter('all')}
              >All</button>
              <button
                className={'viewer__problems-filter' + (problemsFilter === 'solved' ? ' viewer__problems-filter--active' : '')}
                onClick={() => setProblemsFilter('solved')}
              >✓ Solved</button>
              <button
                className={'viewer__problems-filter' + (problemsFilter === 'wrong' ? ' viewer__problems-filter--active' : '')}
                onClick={() => setProblemsFilter('wrong')}
              >✗ Wrong</button>
            </div>
          </div>
          <div className="viewer__problems-list">
            {docProblems.length === 0 ? (
              <div className="viewer__problems-empty">
                {effectiveScope === 'current' && selectedPath ? (
                  <>No problems in <strong>{selectedPath}</strong> yet.<br />Select problem text and press ✓ / ✗.</>
                ) : (
                  <>No problems registered yet.<br />Select problem text in a document and press ✓ / ✗.</>
                )}
              </div>
            ) : (
              groupedProblems.map(([docPath, items]) => (
                <div key={docPath} className="viewer__problems-group">
                  <div className="viewer__problems-group-title">{docPath}</div>
                  {items.map((p) => {
                    const missing = effectiveScope === 'all' && !!zipRef.current && !isDocInCurrentZip(p.doc_path);
                    return (
                      <div key={p.id} className={'viewer__problem-item viewer__problem-item--' + p.status}>
                        <button className="viewer__problem-open" onClick={() => jumpToProblem(p)} title="Open in document">
                          <span className="viewer__problem-status">{p.status === 'solved' ? '✓' : '✗'}</span>
                          <span className="viewer__problem-body">
                            <span className="viewer__problem-src">{p.doc_path}{p.ref ? ` · p.${p.ref}` : ''}</span>
                            <span className="viewer__problem-text">{p.text}</span>
                            <span className="viewer__problem-meta">
                              {p.attempts} attempt{p.attempts === 1 ? '' : 's'} · {p.wrong_count} wrong
                              {missing && <span className="viewer__problem-missing"> · not in current archive</span>}
                            </span>
                          </span>
                        </button>
                        <div className="viewer__problem-actions">
                          <button
                            className="viewer__problem-solve"
                            onClick={() => setProblemStatus(p, 'solved')}
                            title="Mark as solved (again)"
                          >✓</button>
                          <button
                            className="viewer__problem-wrong"
                            onClick={() => setProblemStatus(p, 'wrong')}
                            title="Mark as wrong (again)"
                          >✗</button>
                          <button className="viewer__problem-delete" onClick={() => removeProblem(p)} title="Delete">🗑️</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
