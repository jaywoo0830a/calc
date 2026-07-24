import { useRef, useEffect } from 'react';

export default function Playground() {
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !window.mathbox || !window.THREE) return;

    const root = window.mathbox({
      element: el,
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
      expr: (emit, x, y) => { emit(x, y, Math.sin(x) * Math.cos(y)); },
      channels: 3, items: 2, width: 64, height: 64,
    });

    return () => three.renderer.dispose();
  }, []);

  return (
    <main className="playground" tabIndex={-1}>
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>
      <div className="playground__full">
        <div ref={containerRef} className="playground__stage" />
      </div>
    </main>
  );
}
