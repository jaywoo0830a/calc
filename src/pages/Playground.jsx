import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { OrbitControls } from '../lib/OrbitControls.js';

// ── Helper: sample z = f(x,y) → BufferGeometry ────────────────────────────
function makeSurface(fn, xMin, xMax, yMin, yMax, nx, ny, color) {
  const dx = (xMax - xMin) / (nx - 1);
  const dy = (yMax - yMin) / (ny - 1);
  const verts = new Float32Array(nx * ny * 3);
  const colors = new Float32Array(nx * ny * 3);
  const c = new THREE.Color(color);
  let vi = 0;
  for (let j = 0; j < ny; j++) {
    const y = yMin + j * dy;
    for (let i = 0; i < nx; i++) {
      const x = xMin + i * dx;
      const z = fn(x, y);
      const shade = 0.6 + 0.4 * ((z + 1) / 2); // height-based brightness
      verts[vi] = x; verts[vi + 1] = z; verts[vi + 2] = y;
      colors[vi] = c.r * shade; colors[vi + 1] = c.g * shade; colors[vi + 2] = c.b * shade;
      vi += 3;
    }
  }
  // Indices for triangles
  const idx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side: THREE.DoubleSide }));
}

// ── Helper: arrow from p in direction d, scaled by magnitude ─────────────
function makeArrow(p, d, colorHex, scale = 1) {
  const dir = new THREE.Vector3(d.x, d.y, d.z).normalize();
  const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (len < 0.001) return new THREE.Group();
  const arrow = new THREE.ArrowHelper(dir, p, len * scale, colorHex, 0.15 * scale, 0.1 * scale);
  return arrow;
}

export default function Playground() {
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0xf8f4eb);
    el.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 50);
    camera.position.set(5, 4, 6);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const scene = new THREE.Scene();

    // ── Lights ────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const light = new THREE.DirectionalLight(0xffffff, 0.7);
    light.position.set(5, 10, 5);
    scene.add(light);

    // ── Grid (XZ plane) ──────────────────────────────────────────────
    const grid = new THREE.GridHelper(8, 20, 0x9b907e, 0xe5ddcc);
    grid.position.y = -2;
    scene.add(grid);

    // ── 3D Surface: z = sin(x)·cos(y) ─────────────────────────────────
    const surface = makeSurface(
      (x, y) => Math.sin(x) * Math.cos(y),
      -3, 3, -3, 3, 64, 64, 0x5c3d2e
    );
    scene.add(surface);

    // ── 2D Curve: y = sin(x) on the XZ plane ─────────────────────────
    const curvePts = [];
    for (let i = 0; i <= 200; i++) {
      const x = -3.5 + (i / 200) * 7;
      curvePts.push(new THREE.Vector3(x, 0, Math.sin(x)));
    }
    const curveGeo = new THREE.BufferGeometry().setFromPoints(curvePts);
    scene.add(new THREE.Line(curveGeo, new THREE.LineBasicMaterial({ color: 0x3d5a80, linewidth: 2 })));

    // ── Gradient vectors on the surface ──────────────────────────────
    const gradGroup = new THREE.Group();
    const h = 0.001;
    for (let ix = -2; ix <= 2; ix += 1) {
      for (let iy = -2; iy <= 2; iy += 1) {
        const x = ix, y = iy;
        const z = Math.sin(x) * Math.cos(y);
        const dzx = (Math.sin(x + h) * Math.cos(y) - Math.sin(x - h) * Math.cos(y)) / (2 * h);
        const dzy = (Math.sin(x) * Math.cos(y + h) - Math.sin(x) * Math.cos(y - h)) / (2 * h);
        const p = new THREE.Vector3(x, z + 0.05, y);
        const d = new THREE.Vector3(-dzx * 0.4, 0, -dzy * 0.4);
        gradGroup.add(makeArrow(p, d, 0xb5433a, 1));
      }
    }
    scene.add(gradGroup);

    // ── Coordinate basis (3x3 Identity Matrix visualization) ──────────
    const origin = new THREE.Vector3(-3.5, -2, -3.5);
    const basisGroup = new THREE.Group();
    basisGroup.add(makeArrow(origin, new THREE.Vector3(1, 0, 0), 0xb5433a, 1));  // X — red
    basisGroup.add(makeArrow(origin, new THREE.Vector3(0, 1, 0), 0x3d5a40, 1));  // Y — green
    basisGroup.add(makeArrow(origin, new THREE.Vector3(0, 0, 1), 0x3d5a80, 1));  // Z — blue
    scene.add(basisGroup);

    // ── Axis lines ──────────────────────────────────────────────────
    const axPts = [
      new THREE.Vector3(-4, 0, 0), new THREE.Vector3(4, 0, 0),
      new THREE.Vector3(0, -3, 0), new THREE.Vector3(0, 3, 0),
      new THREE.Vector3(0, 0, -4), new THREE.Vector3(0, 0, 4),
    ];
    const axGeo = new THREE.BufferGeometry().setFromPoints(axPts);
    scene.add(new THREE.LineSegments(axGeo, new THREE.LineBasicMaterial({ color: 0x2c2416 })));

    // ── Animate ──────────────────────────────────────────────────────
    let id;
    function animate() {
      id = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    const onResize = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      renderer.setSize(r.width, r.height);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(id);
      controls.dispose();
      renderer.dispose();
      window.removeEventListener('resize', onResize);
      el.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <main className="playground">
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>
      <div className="playground__legend">
        <span style={{color:'#5c3d2e'}}>■ Surface</span>
        <span style={{color:'#3d5a80'}}>■ 2D Curve</span>
        <span style={{color:'#b5433a'}}>→ Gradient ∇f</span>
        <span style={{color:'#3d5a40'}}>● Basis (Identity matrix)</span>
      </div>
      <div className="playground__stage" ref={containerRef} />
    </main>
  );
}
