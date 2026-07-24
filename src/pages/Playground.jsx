import { useRef, useEffect, useState } from 'react';

export default function Playground() {
  const containerRef = useRef(null);
  const cleanupRef = useRef(null);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      if (window.mathbox && window.THREE) {
        clearInterval(check);
        setStatus('ready');
        initScene();
      } else if (attempts > 80) {
        clearInterval(check);
        setStatus('error');
      }
    }, 250);
    return () => {
      clearInterval(check);
      if (cleanupRef.current) cleanupRef.current();
    };
  }, []);

  function initScene() {
    const container = containerRef.current;
    if (!container) return;

    const root = window.mathbox({
      element: container,
      plugins: ['core', 'controls', 'cursor'],
      controls: { klass: window.THREE.OrbitControls },
    });
    const three = root.three;
    three.camera.position.set(3, 2.5, 3);
    three.renderer.setClearColor(new window.THREE.Color(0xf8f4eb), 1);

    const view = root.cartesian({ range: [[-4, 4], [-4, 4], [-4, 4]] });
    view.axis({ axis: 1, detail: 8 });
    view.axis({ axis: 2, detail: 8 });
    view.axis({ axis: 3, detail: 8 });

    view.area({
      axes: [1, 3],
      expr: function (emit, x, y) {
        emit(x, y, Math.sin(x) * Math.cos(y));
      },
      channels: 3,
      items: 2,
      width: 64,
      height: 64,
    });

    cleanupRef.current = () => three.renderer.dispose();
  }

  return (
    <main className="playground" tabIndex={-1}>
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>
      <div className="playground__full">
        {status === 'loading' && (
          <div className="playground__status">Loading Three.js + Mathbox2…</div>
        )}
        {status === 'error' && (
          <div className="playground__status playground__status--err">
            Failed to load 3D libraries. Check console.
          </div>
        )}
        <div ref={containerRef} className="playground__stage" />
      </div>
    </main>
  );
}
