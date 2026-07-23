import { useState, useCallback, useRef, useEffect } from 'react';

export default function Proxy() {
  const [url, setUrl] = useState(() => sessionStorage.getItem('proxy:url') || '');
  const [proxySrc, setProxySrc] = useState(() => sessionStorage.getItem('proxy:src') || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const iframeRef = useRef(null);
  const inputRef = useRef(null);

  // 세션 유지
  useEffect(() => { sessionStorage.setItem('proxy:url', url); }, [url]);
  useEffect(() => { sessionStorage.setItem('proxy:src', proxySrc); }, [proxySrc]);

  // URL 정규화 (https:// 자동 추가)
  const normalizeUrl = useCallback((raw) => {
    let u = raw.trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) {
      // 도메인처럼 보이면 https:// 추가
      if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u) || u.includes('.')) {
        u = 'https://' + u;
      } else {
        // 검색어로 간주 → Google 검색
        u = 'https://www.google.com/search?q=' + encodeURIComponent(raw.trim());
      }
    }
    return u;
  }, []);

  const navigate = useCallback((rawUrl) => {
    const target = normalizeUrl(rawUrl || url);
    if (!target) return;

    setError(null);
    setLoading(true);
    const src = `/api/proxy?url=${encodeURIComponent(target)}`;
    setUrl(target);
    setProxySrc(src);
  }, [url, normalizeUrl]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') navigate();
  }, [navigate]);

  const handleIframeLoad = useCallback(() => {
    setLoading(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setLoading(false);
    setError('Page failed to load. The site may block embedding.');
  }, []);

  // 초기 포커스
  useEffect(() => {
    if (!proxySrc && inputRef.current) inputRef.current.focus();
  }, [proxySrc]);

  return (
    <main className="proxy" tabIndex={-1}>
      {/* ── Navigation tabs (Calculator / Viewer 패턴과 동일) ── */}
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">Proxy</span>
      </nav>

      {/* ── URL Bar ── */}
      <div className="proxy__bar">
        <span className="proxy__icon">🌐</span>
        <input
          ref={inputRef}
          className="proxy__input"
          type="text"
          placeholder="Enter URL or search…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoCapitalize="off"
        />
        <button
          className="proxy__go"
          onClick={() => navigate()}
          disabled={!url.trim() || loading}
          aria-label="Go"
        >
          {loading ? '⏳' : '→'}
        </button>
        {proxySrc && (
          <button
            className="proxy__reload"
            onClick={() => {
              setLoading(true);
              setError(null);
              // iframe src를 강제 리프레시 (쿼리스트링에 타임스탬프 추가)
              const baseUrl = url;
              const src = `/api/proxy?url=${encodeURIComponent(baseUrl)}&_t=${Date.now()}`;
              setProxySrc(src);
            }}
            aria-label="Reload"
          >
            ↻
          </button>
        )}
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="proxy__error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* ── Loading overlay ── */}
      {loading && (
        <div className="proxy__loading">
          <span className="proxy__spinner" />
          <span>Loading…</span>
        </div>
      )}

      {/* ── Iframe ── */}
      {proxySrc ? (
        <iframe
          ref={iframeRef}
          className="proxy__frame"
          src={proxySrc}
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-presentation allow-downloads"
          onLoad={handleIframeLoad}
          onError={handleIframeError}
          title="Proxy Browser"
        />
      ) : (
        <div className="proxy__empty">
          <p className="proxy__empty-icon">🌍</p>
          <p className="proxy__empty-text">Enter a URL above to browse</p>
          <p className="proxy__empty-hint">
            Example: <code>en.wikipedia.org</code>
          </p>
        </div>
      )}
    </main>
  );
}
