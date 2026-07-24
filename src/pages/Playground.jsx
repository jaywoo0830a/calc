import { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from '../lib/OrbitControls.js';
import { create, all } from 'mathjs';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';

const math = create(all, { number: 'number', precision: 15 });

const STARTER = `// Three.js live editor — use THREE, OrbitControls, container, math
const { width, height } = container.getBoundingClientRect();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(width, height);
renderer.setClearColor(0xf8f4eb);
container.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
camera.position.set(4, 3, 4);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const light = new THREE.DirectionalLight(0xffffff, 0.7);
light.position.set(5, 10, 5);
scene.add(light);

// Grid + axes
scene.add(new THREE.GridHelper(6, 20, 0x9b907e, 0xe5ddcc));

// Torus knot
const geo = new THREE.TorusKnotGeometry(1, 0.3, 128, 32);
const mat = new THREE.MeshStandardMaterial({ color: 0x5c3d2e, roughness: 0.3 });
scene.add(new THREE.Mesh(geo, mat));

let id;
function animate() {
  id = requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

return () => {
  cancelAnimationFrame(id);
  controls.dispose();
  renderer.dispose();
  container.removeChild(renderer.domElement);
};
`;

const PRESETS = [
  {
    label: 'Torus Knot',
    code: STARTER,
  },
  {
    label: 'Surface',
    code: `const { width, height } = container.getBoundingClientRect();
const r = new THREE.WebGLRenderer({ antialias: true });
r.setPixelRatio(Math.min(devicePixelRatio,2)); r.setSize(width,height);
r.setClearColor(0xf8f4eb); container.appendChild(r.domElement);
const cam = new THREE.PerspectiveCamera(45,width/height,0.1,100);
cam.position.set(5,4,6); cam.lookAt(0,0,0);
const ctrl = new OrbitControls(cam,r.domElement); ctrl.enableDamping=true;
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff,0.5));
const l = new THREE.DirectionalLight(0xffffff,0.7); l.position.set(5,10,5); scene.add(l);
scene.add(new THREE.GridHelper(8,20,0x9b907e,0xe5ddcc));
// Surface: z = sin(x)*cos(y)
const nx=80,ny=80; const v=new Float32Array(nx*ny*3); const col=new Float32Array(nx*ny*3);
let vi=0;
for(let j=0;j<ny;j++){const y=-3+j*6/(ny-1);
for(let i=0;i<nx;i++){const x=-3+i*6/(nx-1); const z=Math.sin(x)*Math.cos(y);
v[vi]=x;v[vi+1]=z;v[vi+2]=y;
const s=0.6+0.4*((z+1)/2); col[vi]=0.36*s;col[vi+1]=0.24*s;col[vi+2]=0.18*s; vi+=3;}}
const idx=[]; for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){const a=j*nx+i,b=a+1,c=a+nx,d=c+1;idx.push(a,b,d,a,d,c);}
const geo=new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.BufferAttribute(v,3));
geo.setAttribute('color',new THREE.BufferAttribute(col,3)); geo.setIndex(idx); geo.computeVertexNormals();
scene.add(new THREE.Mesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.5,side:THREE.DoubleSide})));
let id;function anim(){id=requestAnimationFrame(anim);ctrl.update();r.render(scene,cam);}anim();
return()=>{cancelAnimationFrame(id);ctrl.dispose();r.dispose();container.removeChild(r.domElement);};`,
  },
  {
    label: 'Vectors',
    code: `const { width, height } = container.getBoundingClientRect();
const r = new THREE.WebGLRenderer({ antialias: true });
r.setPixelRatio(Math.min(devicePixelRatio,2)); r.setSize(width,height);
r.setClearColor(0xf8f4eb); container.appendChild(r.domElement);
const cam = new THREE.PerspectiveCamera(45,width/height,0.1,100);
cam.position.set(5,4,6); cam.lookAt(0,0,0);
const ctrl = new OrbitControls(cam,r.domElement); ctrl.enableDamping=true;
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff,0.5));
scene.add(new THREE.GridHelper(8,20,0x9b907e,0xe5ddcc));
// Vector field: F(x,y) = (-y, x)
for(let x=-3;x<=3;x+=0.8){for(let y=-3;y<=3;y+=0.8){
  const len=Math.sqrt(x*x+y*y)+0.1; const dx=-y/len*0.5, dy=x/len*0.5;
  const arrow=new THREE.ArrowHelper(
    new THREE.Vector3(dx,0,dy).normalize(),
    new THREE.Vector3(x,0.05,y), Math.sqrt(dx*dx+dy*dy), 0xb5433a, 0.12, 0.08);
  scene.add(arrow);
}}
let id;function anim(){id=requestAnimationFrame(anim);ctrl.update();r.render(scene,cam);}anim();
return()=>{cancelAnimationFrame(id);ctrl.dispose();r.dispose();container.removeChild(r.domElement);};`,
  },
];

export default function Playground() {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const canvasRef = useRef(null);
  const cleanupRef = useRef(null);
  const [error, setError] = useState(null);

  const run = useCallback((code) => {
    setError(null);
    const el = canvasRef.current;
    if (!el) return;
    if (cleanupRef.current) {
      try { cleanupRef.current(); } catch (e) { /* ok */ }
      cleanupRef.current = null;
    }
    el.innerHTML = '';
    try {
      const fn = new Function('THREE', 'OrbitControls', 'container', 'math', '"use strict";\n' + code);
      const result = fn(THREE, OrbitControls, el, math);
      if (typeof result === 'function') cleanupRef.current = result;
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;
    const state = EditorState.create({
      doc: STARTER,
      extensions: [
        lineNumbers(), history(), bracketMatching(), javascript(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px', backgroundColor: '#f8f4eb' },
          '.cm-scroller': { fontFamily: "'Fira Code','Cascadia Code','Consolas',monospace", lineHeight: '1.6' },
          '.cm-content': { padding: '8px 0' },
          '.cm-gutters': { borderRight: '1px solid #e5ddcc', backgroundColor: '#f8f4eb', color: '#9b907e' },
          '.cm-activeLine': { backgroundColor: 'rgba(92,61,46,0.04)' },
        }),
      ],
    });
    viewRef.current = new EditorView({ state, parent: editorRef.current });
    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  }, []);

  // Initial render
  useEffect(() => { setTimeout(() => run(STARTER), 200); }, [run]);

  const handleRender = () => {
    const code = viewRef.current?.state.doc.toString() || '';
    run(code);
  };

  const loadPreset = (code) => {
    if (viewRef.current) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: code },
      });
    }
    run(code);
  };

  return (
    <main className="playground">
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>
      <div className="playground__presets">
        {PRESETS.map((p, i) => (
          <button key={i} className="playground__chip" onClick={() => loadPreset(p.code)}>{p.label}</button>
        ))}
      </div>
      <div className="playground__split">
        <div className="playground__editor-pane">
          <div className="playground__toolbar">
            <span>JavaScript</span>
            <button className="playground__render-btn" onClick={handleRender}>▶ Render</button>
          </div>
          <div ref={editorRef} className="playground__editor" />
          {error && <div className="playground__error">{error}</div>}
        </div>
        <div className="playground__preview-pane">
          <div ref={canvasRef} className="playground__canvas" />
        </div>
      </div>
      <div className="playground__help">
        THREE · OrbitControls · container · math · Return cleanup fn · Ctrl+Enter to render
      </div>
    </main>
  );
}
