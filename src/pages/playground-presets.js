// ── Shared setup / animation ──────────────────────────────────────────────────
const SETUP = `const { width, height } = container.getBoundingClientRect();
const r = new THREE.WebGLRenderer({ antialias: true });
r.setPixelRatio(Math.min(devicePixelRatio, 2));
r.setSize(width, height);
r.setClearColor(0xf8f4eb);
container.appendChild(r.domElement);
const cam = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
cam.position.set(5, 4, 6);
cam.lookAt(0, 0, 0);
const ctrl = new OrbitControls(cam, r.domElement);
ctrl.enableDamping = true;
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const l = new THREE.DirectionalLight(0xffffff, 0.7);
l.position.set(5, 10, 5);
scene.add(l);`;

const ANIM = `let id;
function anim() {
  id = requestAnimationFrame(anim);
  ctrl.update();
  r.render(scene, cam);
}
anim();
return () => {
  cancelAnimationFrame(id);
  ctrl.dispose();
  r.dispose();
  container.removeChild(r.domElement);
};`;

// ── 2D — vectors + curve y = f(x) ──────────────────────────────────────────
export const C2D = SETUP + `
cam.position.set(0, 0, 5);
cam.lookAt(0, 0, 0);
ctrl.enableRotate = false;

scene.add(new THREE.GridHelper(8, 16, 0x9b907e, 0xe5ddcc));

// Axes
const axPts = [
  new THREE.Vector3(-4, 0, 0), new THREE.Vector3(4, 0, 0),
  new THREE.Vector3(0, -4, 0), new THREE.Vector3(0, 4, 0),
];
scene.add(new THREE.LineSegments(
  new THREE.BufferGeometry().setFromPoints(axPts),
  new THREE.LineBasicMaterial({ color: 0x2c2416 })
));

// Example vectors
scene.add(new THREE.ArrowHelper(
  new THREE.Vector3(3, 2, 0).normalize(),
  new THREE.Vector3(0, 0, 0),
  Math.sqrt(13), 0xb5433a, 0.18, 0.1
));
scene.add(new THREE.ArrowHelper(
  new THREE.Vector3(-1, 3, 0).normalize(),
  new THREE.Vector3(0, 0, 0),
  Math.sqrt(10), 0x3d5a80, 0.18, 0.1
));

// Curve: y = sin(x)
const pts = [];
for (let i = 0; i <= 300; i++) {
  const x = -3.5 + i * 7 / 300;
  pts.push(new THREE.Vector3(x, Math.sin(x) * 1.5, 0.01));
}
scene.add(new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(pts),
  new THREE.LineBasicMaterial({ color: 0x3d5a40 })
));

${ANIM}`;

// ── 3D — basis vectors + surface z = f(x,y) ──────────────────────────────────
export const C3D = SETUP + `
scene.add(new THREE.GridHelper(6, 16, 0x9b907e, 0xe5ddcc));

// Axes
const axPts = [
  new THREE.Vector3(-3.5, 0, 0), new THREE.Vector3(3.5, 0, 0),
  new THREE.Vector3(0, -3.5, 0), new THREE.Vector3(0, 3.5, 0),
  new THREE.Vector3(0, 0, -3.5), new THREE.Vector3(0, 0, 3.5),
];
scene.add(new THREE.LineSegments(
  new THREE.BufferGeometry().setFromPoints(axPts),
  new THREE.LineBasicMaterial({ color: 0x2c2416 })
));

// Basis vectors (i, j, k)
const O = new THREE.Vector3(-3, -2, -3);
scene.add(new THREE.ArrowHelper(
  new THREE.Vector3(1, 0, 0), O, 1, 0xb5433a, 0.15, 0.08
));
scene.add(new THREE.ArrowHelper(
  new THREE.Vector3(0, 1, 0), O, 1, 0x3d5a40, 0.15, 0.08
));
scene.add(new THREE.ArrowHelper(
  new THREE.Vector3(0, 0, 1), O, 1, 0x3d5a80, 0.15, 0.08
));

// Surface: z = sin(x) * cos(y)
const nx = 50, ny = 50;
const verts = new Float32Array(nx * ny * 3);
const colors = new Float32Array(nx * ny * 3);
let vi = 0;
for (let j = 0; j < ny; j++) {
  const y = -2.5 + j * 5 / (ny - 1);
  for (let i = 0; i < nx; i++) {
    const x = -2.5 + i * 5 / (nx - 1);
    const z = Math.sin(x) * Math.cos(y);
    verts[vi] = x;
    verts[vi + 1] = z;
    verts[vi + 2] = y;
    const s = 0.5 + 0.5 * ((z + 1) / 2);
    colors[vi] = 0.36 * s;
    colors[vi + 1] = 0.24 * s;
    colors[vi + 2] = 0.18 * s;
    vi++;
  }
}
const idx = [];
for (let j = 0; j < ny - 1; j++) {
  for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
    idx.push(a, b, e, a, e, d);
  }
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
geo.setIndex(idx);
geo.computeVertexNormals();
scene.add(new THREE.Mesh(
  geo,
  new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.5, side: THREE.DoubleSide,
  })
));

${ANIM}`;

// ── Complex — de Moivre: unit circle + vectors ───────────────────────────────
export const CCX = SETUP + `
cam.position.set(0, 0, 5);
cam.lookAt(0, 0, 0);
ctrl.enableRotate = false;

const R = 2.5;

// Grid
scene.add(new THREE.GridHelper(R * 2, 20, 0x9b907e, 0xe5ddcc));

// Unit circle
const circ = [];
for (let i = 0; i <= 128; i++) {
  const a = i / 128 * Math.PI * 2;
  circ.push(new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
}
scene.add(new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(circ),
  new THREE.LineBasicMaterial({ color: 0x9b907e })
));

// Axes
const axPts = [
  new THREE.Vector3(-R, 0, 0), new THREE.Vector3(R, 0, 0),
  new THREE.Vector3(0, -R, 0), new THREE.Vector3(0, R, 0),
];
scene.add(new THREE.LineSegments(
  new THREE.BufferGeometry().setFromPoints(axPts),
  new THREE.LineBasicMaterial({ color: 0x2c2416 })
));

// de Moivre: (cos θ + i sin θ)^n = cos(nθ) + i sin(nθ)
const theta = Math.PI / 6;  // angle
const n = 3;                // power

// Original vector at angle θ
const v1 = new THREE.Vector3(Math.cos(theta) * R, Math.sin(theta) * R, 0);
scene.add(new THREE.ArrowHelper(
  v1.clone().normalize(), new THREE.Vector3(0, 0, 0), R, 0xb5433a, 0.2, 0.12
));

// Vector at angle nθ (de Moivre result)
const v2 = new THREE.Vector3(Math.cos(n * theta) * R, Math.sin(n * theta) * R, 0);
scene.add(new THREE.ArrowHelper(
  v2.clone().normalize(), new THREE.Vector3(0, 0, 0.02), R, 0x3d5a80, 0.2, 0.12
));

// Arc showing the multiplied angle
const arc = [];
for (let i = 0; i <= 32; i++) {
  const a = n * theta * i / 32;
  arc.push(new THREE.Vector3(Math.cos(a) * R * 0.15, Math.sin(a) * R * 0.15, 0.03));
}
scene.add(new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(arc),
  new THREE.LineBasicMaterial({ color: 0x3d5a40 })
));

${ANIM}`;

// ── Presets ──────────────────────────────────────────────────────────────────
export const PRESETS = {
  '2d': [
    { label: 'y = sin(x)', code: C2D },
    { label: 'y = x²',
      code: C2D.replace('Math.sin(x) * 1.5', 'x * x / 3') },
    { label: 'y = cos(2x)',
      code: C2D.replace('Math.sin(x) * 1.5', 'Math.cos(2 * x)') },
  ],
  '3d': [
    { label: 'sin(x) cos(y)', code: C3D },
    { label: 'x² + y²',
      code: C3D.replace('Math.sin(x) * Math.cos(y)', '(x * x + y * y) / 4') },
    { label: 'cos(x) + cos(y)',
      code: C3D.replace('Math.sin(x) * Math.cos(y)', '(Math.cos(x) + Math.cos(y)) / 2') },
  ],
  'complex': [
    { label: 'θ = π/6, n = 3', code: CCX },
    { label: 'θ = π/4, n = 2',
      code: CCX.replace('Math.PI / 6', 'Math.PI / 4').replace('n = 3', 'n = 2') },
    { label: 'θ = π/3, n = 4',
      code: CCX.replace('Math.PI / 6', 'Math.PI / 3').replace('n = 3', 'n = 4') },
    { label: 'θ = π/2, n = 5',
      code: CCX.replace('Math.PI / 6', 'Math.PI / 2').replace('n = 3', 'n = 5') },
  ],
};
