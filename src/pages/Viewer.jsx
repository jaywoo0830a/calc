import { useState, useCallback, useEffect } from 'react';
import { marked } from 'marked';
import katex from 'katex';
import JSZip from 'jszip';
import ZipTree from '../components/ZipTree.jsx';

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

/** src 를 마크다운 파일의 디렉토리(dir) 기준으로 절대경로화하여 blob map 에서 찾는다 */
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  // Escape key → exit fullscreen
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
    try {
      const zip = await JSZip.loadAsync(file);
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
      // 첫 번째 .md 파일 찾아서 렌더링
      const first = Object.keys(zip.files).find(p => p.endsWith('.md') && !zip.files[p].dir);
      if (first) {
        setSelectedPath(first);
        const dir = first.substring(0, first.lastIndexOf('/') + 1);
        const resolveImg = (src) => resolveImagePath(src, dir, blobs);
        setRendered(processContent(await zip.files[first].async('text'), resolveImg));
      }
    } catch (e) { setRendered('<p style="color:red">ZIP error: ' + e.message + '</p>'); }
  }, [indexImages]);

  const openFile = useCallback(async (node) => {
    if (!node || !node.file) return;
    setSelectedPath(node.path);
    try {
      const dir = node.path.substring(0, node.path.lastIndexOf('/') + 1);
      const resolveImg = (src) => resolveImagePath(src, dir, imageBlobs);
      setRendered(processContent(await node.file.async('text'), resolveImg));
    }
    catch (e) { setRendered('<p style="color:red">Read error: ' + e.message + '</p>'); }
  }, [imageBlobs]);

  return (
    <div className={'viewer' + (fullscreen ? ' viewer--fullscreen' : '')}>
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
      <div className="viewer__panes">
        {zipTree && (<>
          <div className={'viewer__sidebar' + (sidebarOpen ? ' viewer__sidebar--open' : '')}>
            <ZipTree tree={zipTree} selectedPath={selectedPath} onSelect={openFile} />
          </div>
          <button className="viewer__sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle sidebar">
            {sidebarOpen ? '\u25c0' : '\u25b6'}
          </button>
          <div className="viewer__overlay" onClick={() => setSidebarOpen(false)} />
        </>)}
        <div className={'viewer__preview' + (!zipTree ? ' viewer__preview--full' : '')}>
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
    </div>
  );
}
