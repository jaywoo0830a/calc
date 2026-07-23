import { useState, useCallback, useRef, useEffect } from 'react';

// ── Debug log helper ─────────────────────────────────────────────────────────
let logId = 0;
function createLog(msg, status) {
  return { id: ++logId, time: Date.now(), msg, status };
}

export default function Proxy() {
  const [url, setUrl] = useState(() => sessionStorage.getItem('proxy:url') || '');
  const [proxySrc, setProxySrc] = useState(() => sessionStorage.getItem('proxy:src') || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [debug, setDebug] = useState(false);
  const [logs, setLogs] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const iframeRef = useRef(null);
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);

  const addLog = useCallback((msg, status = 'info') => {
    setLogs((prev) => [...prev, createLog(msg, status)]);
  }, []);

  useEffect(() => { sessionStorage.setItem('proxy:url', url); }, [url]);
  useEffect(() => { sessionStorage.setItem('proxy:src', proxySrc); }, [proxySrc]);

  useEffect(() => {
    if (loading) {
      startTimeRef.current = Date.now();
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed(Math.round((Date.now() - startTimeRef.current) / 100) / 10);
      }, 100);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [loading]);

  const runDiagnostics = useCallback(async (targetRaw) => {
    const target = targetRaw || url;
    setDebug(true);
    setLogs([]);
    logId = 0;
    addLog('Starting diagnostics…', 'info');

    addLog('GET /api/ping …', 'info');
    try {
      const t0 = Date.now();
      const pingRes = await fetch('/api/ping');
      const ping = await pingRes.json();
      addLog(`API server OK — uptime ${Math.round(ping.uptime)}s, node ${ping.node} (${Date.now() - t0}ms)`, 'ok');
    } catch (e) {
      addLog(`API server UNREACHABLE: ${e.message}`, 'err');
      return;
    }

    addLog('GET /api/resolve?host=google.com …', 'info');
    try {
      const t0 = Date.now();
      const dnsRes = await fetch('/api/resolve?host=google.com');
      const dns = await dnsRes.json();
      if (dns.ok) {
        const ips = dns.addresses.map(a => a.address).join(', ');
        addLog(`DNS OK — google.com → [${ips}] (${Date.now() - t0}ms, resolve ${dns.timings.dns}ms)`, 'ok');
      } else {
        addLog(`DNS FAIL: ${dns.error} (code: ${dns.code})`, 'err');
      }
    } catch (e) {
      addLog(`DNS check error: ${e.message}`, 'err');
    }

    if (target) {
      const probeUrl = target.startsWith('http') ? target : `https://${target}`;
      addLog(`GET /api/probe?url=${probeUrl} …`, 'info');
      try {
        const t0 = Date.now();
        const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(probeUrl)}`);
        const probe = await probeRes.json();
        if (probe.ok) {
          addLog(`Probe OK — HTTP ${probe.status}, server: ${probe.headers.server || '?'}, TTFB ${probe.timings.ttfb}ms (roundtrip ${Date.now() - t0}ms)`, 'ok');
        } else {
          addLog(`Probe FAIL: ${probe.error} (code: ${probe.code || 'N/A'})`, 'err');
        }
      } catch (e) {
        addLog(`Probe error: ${e.message}`, 'err');
      }
    }
    addLog('Diagnostics complete.', 'info');
  }, [url, addLog]);

  useEffect(() => { runDiagnostics(); }, []); // eslint-disable-line

  const normalizeUrl = useCallback((raw) => {
    let u = raw.trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) {
      if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u) || u.includes('.')) {
        u = 'https://' + u;
      } else {
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
    const src = `/api/proxy?url=${encodeURIComponent(target)}&_t=${Date.now()}`;
    setUrl(target);
    setProxySrc(src);
    addLog(`NAVIGATE → ${target}`, 'info');
    addLog(`Iframe src: ${src}`, 'info');
  }, [url, normalizeUrl, addLog]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') navigate();
  }, [navigate]);

  const handleIframeLoad = useCallback(() => {
    const dt = Date.now() - startTimeRef.current;
    setLoading(false);
    addLog(`Iframe onLoad fired (${dt}ms)`, 'ok');
  }, [addLog]);

  const handleIframeError = useCallback(() => {
    setLoading(false);
    setError('Page failed to load. The site may block embedding.');
    addLog('Iframe onError — page failed to load', 'err');
  }, [addLog]);

  useEffect(() => {
    if (!proxySrc && inputRef.current) inputRef.current.focus();
  }, [proxySrc]);

  const statusIcon = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' };
  const statusClass = { ok: 'ok', err: 'err', warn: 'warn', info: 'info' };

  return (
    <main className="proxy" tabIndex={-1}>
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">Proxy</span>
      </nav>

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
        <button className="proxy__go" onClick={() => navigate()} disabled={!url.trim() || loading} aria-label="Go">
          {loading ? '⏳' : '→'}
        </button>
        {proxySrc && (
          <button className="proxy__reload" onClick={() => {
            setLoading(true); setError(null);
            setProxySrc(`/api/proxy?url=${encodeURIComponent(url)}&_t=${Date.now()}`);
            addLog('RELOAD', 'info');
          }} aria-label="Reload">↻</button>
        )}
        <button
          className={'proxy__debug-btn' + (debug ? ' proxy__debug-btn--active' : '')}
          onClick={() => { setDebug(!debug); if (!debug) runDiagnostics(); }}
          aria-label="Toggle debug"
        >🐛</button>
      </div>

      {error && (
        <div className="proxy__error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {debug && (
        <div className="proxy__debug">
          <div className="proxy__debug-header">
            <span>🔍 Debug Log</span>
            <span className="proxy__debug-meta">{loading && `⏱ ${elapsed}s elapsed`}</span>
            <button onClick={() => runDiagnostics()} className="proxy__debug-rerun">Re-run</button>
            <button onClick={() => setDebug(false)} className="proxy__debug-close">×</button>
          </div>
          <div className="proxy__debug-log">
            {logs.length === 0 && <div className="proxy__debug-empty">Running diagnostics…</div>}
            {logs.map((l) => (
              <div key={l.id} className={`proxy__debug-line proxy__debug-line--${statusClass[l.status]}`}>
                <span className="proxy__debug-icon">{statusIcon[l.status]}</span>
                <span className="proxy__debug-msg">{l.msg}</span>
                <span className="proxy__debug-time">{new Date(l.time).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className="proxy__loading">
          <span className="proxy__spinner" />
          <span>Loading… ({elapsed}s)</span>
        </div>
      )}

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
