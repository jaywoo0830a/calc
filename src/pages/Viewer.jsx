import { useState, useEffect, useCallback } from 'react';
import { marked } from 'marked';
import katex from 'katex';
import JSZip from 'jszip';
import ZipTree from '../components/ZipTree.jsx';

import 'katex/contrib/auto-render';
import 'katex/contrib/mhchem';
import 'katex/contrib/copy-tex';
import 'katex/dist/katex.min.css';

// ---- Markdown + KaTeX processor ----

function processContent(markdown, resolveImage) {
  const mathBlocks = [];
  let out = markdown
    .replace(/\$\$([\s\S]*?)\$\$/g, (m) => { mathBlocks.push(m); return `%%MATH${mathBlocks.length - 1}%%`; })
    .replace(/(?<!\$)\$(?!\$)([\s\S]*?)(?<!\$)\$(?!\$)/g, (m) => { mathBlocks.push(m); return `%%MATH${mathBlocks.length - 1}%%`; });

  let html = marked.parse(out, { breaks: true, gfm: true });

  // Resolve relative image paths → blob URLs from ZIP
  if (resolveImage) {
    html = html.replace(/<img\s+src="([^"]+)"/g, (match, src) => {
      if (/^(https?:|data:)/.test(src)) return match;
      const blob = resolveImage(src);
      return blob ? match.replace(src, blob) : match;
    });
  }

  html = html.replace(/%%MATH(\d+)%%/g, (_, i) => {
    const m = mathBlocks[+i];
    const isBlock = m.startsWith('$$');
    const tex = isBlock ? m.slice(2, -2).trim() : m.slice(1, -1).trim();
    try {
      return katex.renderToString(tex, { displayMode: isBlock, throwOnError: false, trust: true, strict: false });
    } catch { return m; }
  });

  return html;
}

// ---- Viewer ----

export default function Viewer() {
  const [fileName, setFileName] = useState('');
  const [rendered, setRendered] = useState('');
  const [zipTree, setZipTree] = useState(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [imageBlobs, setImageBlobs] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Resolve all images in ZIP → blob URLs
  const indexImages = useCallback(async (zip) => {
    const blobs = {};
    const re = /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i;
    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir || !re.test(path)) continue;
      const data = await file.async('blob');
      const url = URL.createObjectURL(data);
      blobs[path] = url;
      const base = path.split('/').pop();
      blobs[base] = url;
      blobs['./' + base] = url;
      blobs['./' + path] = url;
    }
    return blobs;
  }, []);

  // Load ZIP
  const loadZip = useCallback(async (file) => {
    setFileName(file.name);
    try {
      const zip = await JSZip.loadAsync(file);
      const blobs = await indexImages(zip);
      setImageBlobs(blobs);

      // Build tree
      const tree = { name: 'root', children: {}, isDir: true };
      for (const [path, f] of Object.entries(zip.files)) {
        const parts = path.split('/');
        let node = tree;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (!p) continue;
          const last = i === parts.length - 1;
          if (!node.children[p]) node.children[p] = { name: p, children: last ? null : {}, isDir: !last, file: last ? f : null, path };
          node = node.children[p];
        }
      }
      setZipTree(tree);

      // Auto-open first .md file
      const first = Object.keys(zip.files).find(p => p.endsWith('.md') && !zip.files[p].dir);
      if (first) {
        setSelectedPath(first);
        const text = await zip.files[first].async('text');
        setRendered(processContent(text, (img) => blobs[img] || null));
      }
    } catch (e) {
      setRendered(`<p style="color:red">ZIP error: ${e.message}</p>`);
    }
  }, [indexImages]);

  // Click tree node
  const openFile = useCallback(async (node) => {
    if (!node?.file) return;
    setSelectedPath(node.path);
    try {
      const text = await node.file.async('text');
      setRendered(processContent(text, (img) => imageBlobs[img] || null));
    } catch (e) {
      setRendered(`<p style="color:red">Read error: ${e.message}</p>`);
    }
  }, [imageBlobs]);

  // Drag & drop
  const onDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f?.name.endsWith('.zip')) loadZip(f);
  }, [loadZip]);

  const onDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };

  return (
    <div className="viewer">
      <nav className="nav-bar">
        <a href="/" className="nav-tab">Calc</a>
        <span className="nav-tab active">Viewer</span>
      </nav>

      <div className="upload-zone" onDrop={onDrop} onDragOver={onDragOver} onClick={() => document.getElementById('zipInput').click()}>
        <input id="zipInput" type="file" accept=".zip" onChange={(e) => { const f = e.target.files[0]; if (f) loadZip(f); }} hidden />
        {fileName
          ? <span>📦 <strong>{fileName}</strong> — drop another ZIP to switch</span>
          : <span>📂 Drop a <strong>ZIP</strong> archive here, or click to browse</span>
        }
      </div>

      <div className="viewer-panes">
        {zipTree && (
          <>
            <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle sidebar">
              {sidebarOpen ? '◀' : '▶'}
            </button>
            <div className={`viewer-pane viewer-sidebar ${sidebarOpen ? 'open' : ''}`}>
              <ZipTree tree={zipTree} selectedPath={selectedPath} onSelect={openFile} />
            </div>
            {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
          </>
        )}
        <div className={`viewer-pane preview-pane ${!zipTree ? 'full' : ''}`}>
          {rendered
            ? <div className="viewer-preview markdown-body" dangerouslySetInnerHTML={{ __html: rendered }} />
            : <div className="viewer-empty">Upload a ZIP archive to get started</div>
          }
        </div>
      </div>
    </div>
  );
}
