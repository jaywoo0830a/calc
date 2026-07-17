import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import katex from 'katex';

// Load all KaTeX extensions
import 'katex/contrib/auto-render';
import 'katex/contrib/mhchem';
import 'katex/contrib/copy-tex';
import 'katex/dist/katex.min.css';

/** Render inline/delimited math with KaTeX */
function renderMath(text) {
  // Block math: $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), {
        displayMode: true,
        throwOnError: false,
        trust: true,
        strict: false,
      });
    } catch {
      return `<pre>${math}</pre>`;
    }
  });

  // Inline math: $...$ (but not $$)
  text = text.replace(/(?<!\$)\$(?!\$)([\s\S]*?)(?<!\$)\$(?!\$)/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), {
        displayMode: false,
        throwOnError: false,
        trust: true,
        strict: false,
      });
    } catch {
      return `<code>${math}</code>`;
    }
  });

  return text;
}

/** Process markdown → HTML → KaTeX math */
function processContent(markdown) {
  // Pre-process: protect math blocks from marked parser
  const mathBlocks = [];
  let protected_ = markdown
    .replace(/\$\$([\s\S]*?)\$\$/g, (match) => {
      mathBlocks.push(match);
      return `%%MATHBLOCK${mathBlocks.length - 1}%%`;
    })
    .replace(/(?<!\$)\$(?!\$)([\s\S]*?)(?<!\$)\$(?!\$)/g, (match) => {
      mathBlocks.push(match);
      return `%%MATHBLOCK${mathBlocks.length - 1}%%`;
    });

  // Parse markdown
  let html = marked.parse(protected_, { breaks: true, gfm: true });

  // Restore and render math blocks
  html = html.replace(/%%MATHBLOCK(\d+)%%/g, (_, i) => {
    const math = mathBlocks[parseInt(i)];
    if (math.startsWith('$$')) {
      try {
        return katex.renderToString(math.slice(2, -2).trim(), {
          displayMode: true,
          throwOnError: false,
          trust: true,
          strict: false,
        });
      } catch { return math; }
    } else {
      try {
        return katex.renderToString(math.slice(1, -1).trim(), {
          displayMode: false,
          throwOnError: false,
          trust: true,
          strict: false,
        });
      } catch { return math; }
    }
  });

  return html;
}

const SAMPLE = `# Welcome to the Viewer

Upload a **Markdown** file or paste content below.

## Math Examples

### Inline math
Einstein's equation: $E = mc^2$

The quadratic formula: $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$

### Block math
$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

### Chemistry (mhchem)
$\\ce{H2O}$ — water

$\\ce{CO2 + C -> 2CO}$

### Physics
$\\vec{F} = m\\vec{a}$

$\\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0}$

### Matrices
$$
\\begin{pmatrix}
a & b \\\\
c & d
\\end{pmatrix}
$$

## Code Block
\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)
\`\`\`

> Blockquote: Math is the language of nature.
`;

export default function Viewer() {
  const [content, setContent] = useState('');
  const [rendered, setRendered] = useState('');
  const [fileName, setFileName] = useState('');
  const [viewSample, setViewSample] = useState(false);
  const textareaRef = useRef(null);
  const outputRef = useRef(null);

  // Process content when it changes
  useEffect(() => {
    const source = viewSample ? SAMPLE : content;
    if (!source.trim()) {
      setRendered('');
      return;
    }
    try {
      const html = processContent(source);
      setRendered(html);
    } catch (e) {
      setRendered(`<p style="color:red">Render error: ${e.message}</p>`);
    }
  }, [content, viewSample]);

  // Handle file upload
  const handleFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    setViewSample(false);
    const reader = new FileReader();
    reader.onload = (e) => setContent(e.target.result);
    reader.readAsText(file);
  }, []);

  // Drag & drop
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="viewer">
      {/* Navigation tabs */}
      <nav className="nav-bar">
        <a href="/" className="nav-tab">Calc</a>
        <span className="nav-tab active">Viewer</span>
      </nav>

      {/* Upload zone */}
      <div
        className="upload-zone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => document.getElementById('fileInput').click()}
      >
        <input
          id="fileInput"
          type="file"
          accept=".md,.txt,.markdown,.tex,.html"
          onChange={(e) => handleFile(e.target.files[0])}
          hidden
        />
        {fileName ? (
          <span>📎 <strong>{fileName}</strong> — drop another file or paste below</span>
        ) : (
          <span>📂 Drop a Markdown file here, or <strong>click to browse</strong></span>
        )}
      </div>

      {/* Sample toggle */}
      <div className="viewer-toolbar">
        <button
          className={`viewer-btn ${viewSample ? 'active' : ''}`}
          onClick={() => { setViewSample(!viewSample); if (!viewSample) setFileName(''); }}
        >
          {viewSample ? '✕ Hide Sample' : '📖 View Sample'}
        </button>
        {content && !viewSample && (
          <button className="viewer-btn" onClick={() => { setContent(''); setFileName(''); }}>
            ✕ Clear
          </button>
        )}
      </div>

      {/* Editor + Preview (side-by-side on desktop, stacked on mobile) */}
      <div className="viewer-panes">
        <div className="viewer-pane editor-pane">
          <textarea
            ref={textareaRef}
            className="viewer-editor"
            value={viewSample ? SAMPLE : content}
            onChange={(e) => { setContent(e.target.value); setViewSample(false); }}
            placeholder="Paste Markdown content here..."
            spellCheck={false}
          />
        </div>
        <div className="viewer-pane preview-pane">
          <div
            ref={outputRef}
            className="viewer-preview markdown-body"
            dangerouslySetInnerHTML={{ __html: rendered || '<p style="color:var(--color-text-dim)">Rendered output will appear here...</p>' }}
          />
        </div>
      </div>
    </div>
  );
}
