import { useState, useEffect, useCallback, useRef } from 'react';
import { Document, Page } from 'react-pdf';
import { getAnnotations, saveAnnotation, deleteAnnotation } from '../lib/storage.js';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

const COLORS = {
  highlight: { bg: 'rgba(255, 230, 100, 0.45)', label: '🟡 형광펜' },
  underline: { border: '2px solid #e74c3c', label: '🔴 밑줄' },
  comment: { bg: 'rgba(255, 200, 100, 0.7)', label: '💬 주석' },
};

function annoRect(a, pageEl) {
  if (!pageEl) return null;
  const pw = pageEl.offsetWidth;
  const ph = pageEl.offsetHeight;
  return {
    left: a.rect.x * pw,
    top: a.rect.y * ph,
    width: a.rect.w * pw,
    height: a.rect.h * ph,
  };
}

export default function PdfAnnotator({ url, filePath }) {
  const [numPages, setNumPages] = useState(0);
  const [annotations, setAnnotations] = useState([]);
  const [tool, setTool] = useState('highlight');
  const [activeComment, setActiveComment] = useState(null);
  const [commentText, setCommentText] = useState('');
  const pageRefs = useRef({});

  // ── Load annotations from IndexedDB ─────────────────────
  useEffect(() => {
    if (!filePath) return;
    getAnnotations(filePath).then(setAnnotations).catch(() => {});
  }, [filePath]);

  // ── Text selection → highlight / underline ──────────────
  const handleMouseUp = useCallback((pageNumber) => (e) => {
    if (tool === 'comment') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

    const range = sel.getRangeAt(0);
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;

    // Check selection is within this page
    if (!pageEl.contains(range.commonAncestorContainer)) return;

    const pageRect = pageEl.getBoundingClientRect();
    const rects = range.getClientRects();

    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const annotation = {
        filePath,
        pageNumber,
        type: tool,
        color: tool === 'underline' ? '#e74c3c' : '#ffe664',
        text: sel.toString().trim(),
        rect: {
          x: (r.left - pageRect.left) / pageRect.width,
          y: (r.top - pageRect.top) / pageRect.height,
          w: r.width / pageRect.width,
          h: r.height / pageRect.height,
        },
      };
      saveAnnotation(annotation).then((saved) => {
        setAnnotations((prev) => [...prev, saved]);
      });
    }
    sel.removeAllRanges();
  }, [tool, filePath]);

  // ── Click → comment note ────────────────────────────────
  const handlePageClick = useCallback((pageNumber) => (e) => {
    if (tool !== 'comment') return;
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;
    const pageRect = pageEl.getBoundingClientRect();
    const x = (e.clientX - pageRect.left) / pageRect.width;
    const y = (e.clientY - pageRect.top) / pageRect.height;

    setActiveComment({ pageNumber, x, y });
    setCommentText('');
  }, [tool]);

  const submitComment = useCallback(() => {
    if (!activeComment || !commentText.trim()) {
      setActiveComment(null);
      return;
    }
    const annotation = {
      filePath,
      pageNumber: activeComment.pageNumber,
      type: 'comment',
      color: '#ffc864',
      text: commentText.trim(),
      rect: { x: activeComment.x, y: activeComment.y, w: 0.03, h: 0.03 },
    };
    saveAnnotation(annotation).then((saved) => {
      setAnnotations((prev) => [...prev, saved]);
    });
    setActiveComment(null);
    setCommentText('');
  }, [activeComment, commentText, filePath]);

  // ── Delete annotation ────────────────────────────────────
  const removeAnnotation = useCallback((id) => {
    deleteAnnotation(id).then(() => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
    });
  }, []);

  // ── Filter annotations by page ──────────────────────────
  const pageAnnotations = useCallback((pageNumber) => {
    return annotations.filter((a) => a.pageNumber === pageNumber);
  }, [annotations]);

  return (
    <div className="pdf-annotator">
      {/* Toolbar */}
      <div className="pdf-annotator__toolbar">
        <div className="pdf-annotator__tools">
          {Object.entries(COLORS).map(([key, val]) => (
            <button
              key={key}
              className={'pdf-annotator__tool' + (tool === key ? ' pdf-annotator__tool--active' : '')}
              onClick={() => setTool(key)}
            >
              {val.label}
            </button>
          ))}
        </div>
      </div>

      {/* Comment input overlay */}
      {activeComment && (
        <div
          className="pdf-annotator__comment-input"
          style={{
            left: `${activeComment.x * 100}%`,
            top: `${activeComment.y * 100}%`,
          }}
        >
          <textarea
            autoFocus
            rows={3}
            placeholder="주석을 입력하세요…"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) submitComment();
              if (e.key === 'Escape') { setActiveComment(null); setCommentText(''); }
            }}
          />
          <div className="pdf-annotator__comment-actions">
            <button onClick={submitComment}>저장</button>
            <button onClick={() => { setActiveComment(null); setCommentText(''); }}>취소</button>
          </div>
        </div>
      )}

      {/* PDF Document */}
      <div className="pdf-annotator__document">
        <Document
          file={url}
          onLoadSuccess={({ numPages }) => setNumPages(numPages)}
          loading={<div className="pdf-annotator__loading">PDF 불러오는 중…</div>}
          error={<div className="pdf-annotator__error">PDF를 불러올 수 없습니다</div>}
        >
          {Array.from({ length: numPages }, (_, i) => {
            const pageNumber = i + 1;
            const annos = pageAnnotations(pageNumber);
            return (
              <div
                key={pageNumber}
                className="pdf-annotator__page-wrapper"
                ref={(el) => { if (el) pageRefs.current[pageNumber] = el; }}
                onMouseUp={handleMouseUp(pageNumber)}
                onClick={handlePageClick(pageNumber)}
              >
                <Page
                  pageNumber={pageNumber}
                  width={Math.min(window.innerWidth - 48, 800)}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                />
                {/* Annotation overlay */}
                {annos.map((a) => (
                  <AnnotationOverlay
                    key={a.id}
                    annotation={a}
                    pageEl={pageRefs.current[pageNumber]}
                    onDelete={removeAnnotation}
                  />
                ))}
                <div className="pdf-annotator__page-number">
                  {pageNumber} / {numPages}
                </div>
              </div>
            );
          })}
        </Document>
      </div>
    </div>
  );
}

/** Renders a single annotation overlay */
function AnnotationOverlay({ annotation, pageEl, onDelete }) {
  const rect = annoRect(annotation, pageEl);

  if (annotation.type === 'comment') {
    return (
      <div
        className="pdf-annotator__comment-marker"
        style={{
          left: rect ? rect.left : `${annotation.rect.x * 100}%`,
          top: rect ? rect.top : `${annotation.rect.y * 100}%`,
        }}
        title={annotation.text}
      >
        <span className="pdf-annotator__comment-icon">💬</span>
        <span className="pdf-annotator__comment-tooltip">{annotation.text}</span>
        <button
          className="pdf-annotator__delete-btn"
          onClick={(e) => { e.stopPropagation(); onDelete(annotation.id); }}
        >
          ×
        </button>
      </div>
    );
  }

  if (!rect) return null;

  return (
    <div
      className={'pdf-annotator__mark pdf-annotator__mark--' + annotation.type}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        backgroundColor: annotation.type === 'highlight' ? COLORS.highlight.bg : 'transparent',
        borderBottom: annotation.type === 'underline' ? COLORS.underline.border : 'none',
      }}
      title={annotation.text}
    >
      <button
        className="pdf-annotator__delete-btn"
        onClick={(e) => { e.stopPropagation(); onDelete(annotation.id); }}
      >
        ×
      </button>
    </div>
  );
}
