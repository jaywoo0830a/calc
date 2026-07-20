import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { marked } from 'marked';
import katex from 'katex';
import JSZip from 'jszip';
import ZipTree from '../components/ZipTree.jsx';
import { listZips, saveZip, loadZip as loadZipFromDB, deleteZip } from '../lib/storage.js';

import 'katex/contrib/auto-render';
import 'katex/contrib/mhchem';
import 'katex/contrib/copy-tex';
import 'katex/dist/katex.min.css';

function processContent(markdown, resolveImage) {
  const mathBlocks = [];
  let out = markdown
    .replace(/\$\$([\s\S]*?)\$\$/g, (m) => { mathBlocks.push(m); return '%%MATH' + (mathBlocks.length - 1) + '%%'; })
    .replace(/(?<!\$)\$(?!\$)([\s\S]*?)(?<!\$)\$(?!\$)/g, (m) => { mathBlocks.push(m); return '%%MATH' + (mathBlocks.length - 1) + '%%'; });
  let html = marked.parse(out, { breaks: true, gfm: true });
  if (resolveImage) {
    // <img> 태그의 src 속성을 찾아 blob URL로 치환 (alt 등 다른 속성이 앞에 와도 대응)
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
  const [readability, setReadability] = useState(0);  // 0~5 가독성 단계

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

  const loadZip = useCallback(async (file) => {
    setFileName(file.name);
    scrollPositions.current = {};  // 새 ZIP → 스크롤 위치 초기화
    try {
      const zip = await JSZip.loadAsync(file);
      const blobs = await indexImages(zip);
      setImageBlobs(blobs);

      // IndexedDB에 저장 (원본 blob)
      const blob = file instanceof Blob ? file : new Blob([await file.arrayBuffer()]);
      saveZip(file.name, blob).then(refreshStored).catch(() => {});

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
    scrollPositions.current = {};  // 새 ZIP → 스크롤 위치 초기화
    try {
      const zip = await JSZip.loadAsync(stored.blob);
      const blobs = await indexImages(zip);
      setImageBlobs(blobs);
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

  // 저장된 ZIP 삭제
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
    try {
      const dir = node.path.substring(0, node.path.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir, imageBlobs);
      setContent(processContent(await node.file.async('text'), resolveImg));
    }
    catch (e) { setContent('<p style="color:red">Read error: ' + e.message + '</p>'); }
  }, [imageBlobs, selectedPath]);

  return (
    <div className={'viewer' + (fullscreen ? ' viewer--fullscreen' : '')} style={readabilityVars}>
      {!fullscreen && (
        <nav className="calculator__nav">
          <a href="/" className="calculator__nav-tab">Calc</a>
          <span className="calculator__nav-tab calculator__nav-tab--active">Viewer</span>
        </nav>
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
        {toc.length > 0 && (<>
          <div className={'viewer__toc-sidebar' + (tocOpen ? ' viewer__toc-sidebar--open' : '')}>
            <div className="viewer__toc-title">📑 On this page</div>
            {toc.map((h) => (
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
            ))}
          </div>
          <button className="viewer__toc-toggle" onClick={() => setTocOpen(!tocOpen)} aria-label="Toggle outline" />
        </>)}
        {/* overlay: 항상 마지막에 렌더링 → 어떤 사이드바든 sibling selector 로 감지 */}
        {(zipTree || toc.length > 0) && (
          <div className="viewer__overlay" onClick={() => { setSidebarOpen(false); setTocOpen(false); }} />
        )}
        <div className={'viewer__preview' + (!zipTree ? ' viewer__preview--full' : '')} ref={previewRef}>
          {rendered
            ? <div className="viewer__content markdown-body" dangerouslySetInnerHTML={{ __html: rendered }} />
            : <div className="viewer__empty">Upload a ZIP archive to get started</div>}
        </div>
      </div>
      {rendered && (
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
