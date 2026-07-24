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

function setup3D() { return "const{width,height}=container.getBoundingClientRect();const r=new THREE.WebGLRenderer({antialias:true});r.setPixelRatio(Math.min(devicePixelRatio,2));r.setSize(width,height);r.setClearColor(0xf8f4eb);container.appendChild(r.domElement);const cam=new THREE.PerspectiveCamera(45,width/height,0.1,100);cam.position.set(5,4,6);cam.lookAt(0,0,0);const ctrl=new OrbitControls(cam,r.domElement);ctrl.enableDamping=true;const scene=new THREE.Scene();scene.add(new THREE.AmbientLight(0xffffff,0.5));const l=new THREE.DirectionalLight(0xffffff,0.7);l.position.set(5,10,5);scene.add(l);"; }
function anim3D() { return "let id;function anim(){id=requestAnimationFrame(anim);ctrl.update();r.render(scene,cam);}anim();return()=>{cancelAnimationFrame(id);ctrl.dispose();r.dispose();container.removeChild(r.domElement);};"; }

// ── 2D: flat coordinate plane with grid and axes ──────────────────────────
const C2D = setup3D() +
"cam.position.set(0,0,5);cam.lookAt(0,0,0);ctrl.enableRotate=false;"+
"scene.add(new THREE.GridHelper(10,20,0x9b907e,0xe5ddcc));"+
"const ax=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-5,0,0),new THREE.Vector3(5,0,0),new THREE.Vector3(0,-5,0),new THREE.Vector3(0,5,0)]);"+
"scene.add(new THREE.LineSegments(ax,new THREE.LineBasicMaterial({color:0x2c2416})));"+
"// Add your 2D objects below:\n"+
anim3D();

// ── 3D: grid on XZ plane with XYZ axes ────────────────────────────────────
const C3D = setup3D() +
"scene.add(new THREE.GridHelper(8,20,0x9b907e,0xe5ddcc));"+
"const ax3=new THREE.BufferGeometry().setFromPoints(["+
"new THREE.Vector3(-4,0,0),new THREE.Vector3(4,0,0),"+
"new THREE.Vector3(0,-4,0),new THREE.Vector3(0,4,0),"+
"new THREE.Vector3(0,0,-4),new THREE.Vector3(0,0,4)]);"+
"scene.add(new THREE.LineSegments(ax3,new THREE.LineBasicMaterial({color:0x2c2416})));"+
"// Add your 3D objects below:\n"+
anim3D();

// ── Complex Plane: vector field + domain coloring ─────────────────────────
const CCX = setup3D() +
"cam.position.set(0,0,5);cam.lookAt(0,0,0);ctrl.enableRotate=false;"+
"const fnExpr='z^2';const compiled=math.compile(fnExpr);const R=2.5;const S=256;"+
"// Domain coloring background\n"+
"const cv=document.createElement('canvas');cv.width=cv.height=S;const ctx=cv.getContext('2d');const img=ctx.createImageData(S,S);"+
"for(let py=0;py<S;py++){for(let px=0;px<S;px++){const x=(px/S-0.5)*2*R;const y=(py/S-0.5)*2*R;"+
"try{const fz=compiled.evaluate({z:math.complex(x,y)});const arg=math.arg(fz);const mag=math.abs(fz);"+
"const hue=((arg+Math.PI)/(2*Math.PI))*360;const L=0.3+0.7/(1+mag*0.3);const sat=0.7;"+
"const cc=(1-Math.abs(2*L-1))*sat;const x2=cc*(1-Math.abs((hue/60)%2-1));const m=L-cc/2;let rr,gg,bb;"+
"if(hue<60){rr=cc;gg=x2;bb=0}else if(hue<120){rr=x2;gg=cc;bb=0}else if(hue<180){rr=0;gg=cc;bb=x2}"+
"else if(hue<240){rr=0;gg=x2;bb=cc}else if(hue<300){rr=x2;gg=0;bb=cc}else{rr=cc;gg=0;bb=x2};"+
"const i=(py*S+px)*4;img.data[i]=Math.round((rr+m)*255);img.data[i+1]=Math.round((gg+m)*255);img.data[i+2]=Math.round((bb+m)*255);img.data[i+3]=255;}catch{}}}"+
"ctx.putImageData(img,0,0);"+
"const tex=new THREE.CanvasTexture(cv);tex.minFilter=THREE.LinearFilter;"+
"scene.add(new THREE.Mesh(new THREE.PlaneGeometry(R*2,R*2),new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:0.5})));"+
"// Vector field: arrows showing f(z) at each grid point\n"+
"const step=0.4;const maxMag=5;"+
"for(let x=-R;x<=R;x+=step){for(let y=-R;y<=R;y+=step){"+
"try{const fz=compiled.evaluate({z:math.complex(x,y)});const u=math.re(fz);const v=math.im(fz);"+
"const mag=Math.sqrt(u*u+v*v);if(mag<0.001)continue;const s=Math.min(mag,maxMag)/maxMag*step*0.8;"+
"const nx=u/mag*s;const ny=v/mag*s;"+
"const hue=((Math.atan2(v,u)+Math.PI)/(2*Math.PI))*360;"+
"const c=new THREE.Color().setHSL(hue/360,0.8,0.4+0.3*Math.min(mag/maxMag,1));"+
"scene.add(new THREE.ArrowHelper(new THREE.Vector3(nx,ny,0).normalize(),new THREE.Vector3(x,y,0.01),s,c.getHex(),0.06,0.04));"+
"}catch{}}}"+
"// Axes\n"+
"const ax2=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-R,0,0),new THREE.Vector3(R,0,0),new THREE.Vector3(0,-R,0),new THREE.Vector3(0,R,0)]);"+
"scene.add(new THREE.LineSegments(ax2,new THREE.LineBasicMaterial({color:0x2c2416})));"+
anim3D();

const MODES = [
  { id: '2d', label: '2D', code: C2D },
  { id: '3d', label: '3D', code: C3D },
  { id: 'complex', label: 'Complex', code: CCX },
];

const PRESETS = {
  '2d': [
    { label: 'Vector (3,2)', code: C2D.replace('// Add your 2D objects below:', 'scene.add(new THREE.ArrowHelper(new THREE.Vector3(3,2,0).normalize(),new THREE.Vector3(0,0,0),Math.sqrt(13),0xb5433a,0.2,0.12));') },
    { label: 'Matrix 2x2', code: C2D.replace('// Add your 2D objects below:', 'const M=[[2,0.5],[1,1.5]];const sq=[[0,0],[1,0],[1,1],[0,1],[0,0]];const t=sq.map(([a,b])=>new THREE.Vector3(a*M[0][0]+b*M[0][1],a*M[1][0]+b*M[1][1],0.01));scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(t),new THREE.LineBasicMaterial({color:0x3d5a40})));') },
    { label: 'y = sin(x)', code: C2D.replace('// Add your 2D objects below:', 'const pts=[];for(let i=0;i<=300;i++){const x=-4+i*8/300;pts.push(new THREE.Vector3(x,Math.sin(x)*1.5,0.02));}scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:0x3d5a80})));') },
  ],
  '3d': [
    { label: 'Surface', code: C3D.replace('// Add your 3D objects below:', 'const nx=60,ny=60,v=new Float32Array(nx*ny*3),c=new Float32Array(nx*ny*3);let vi=0;for(let j=0;j<ny;j++){const y=-3+j*6/(ny-1);for(let i=0;i<nx;i++){const x=-3+i*6/(nx-1);const z=Math.sin(x)*Math.cos(y);v[vi]=x;v[vi+1]=z;v[vi+2]=y;const s=0.5+0.5*((z+1)/2);c[vi]=0.36*s;c[vi+1]=0.24*s;c[vi+2]=0.18*s;vi++;}}const idx=[];for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){const a=j*nx+i,b=a+1,d=a+nx,e=d+1;idx.push(a,b,e,a,e,d);}const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.BufferAttribute(v,3));g.setAttribute("color",new THREE.BufferAttribute(c,3));g.setIndex(idx);g.computeVertexNormals();scene.add(new THREE.Mesh(g,new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.5,side:THREE.DoubleSide})));') },
    { label: 'Basis Vectors', code: C3D.replace('// Add your 3D objects below:', 'const O=new THREE.Vector3(-3,-2,-3);scene.add(new THREE.ArrowHelper(new THREE.Vector3(1,0,0),O,1,0xb5433a,0.15,0.1));scene.add(new THREE.ArrowHelper(new THREE.Vector3(0,1,0),O,1,0x3d5a40,0.15,0.1));scene.add(new THREE.ArrowHelper(new THREE.Vector3(0,0,1),O,1,0x3d5a80,0.15,0.1));') },
    { label: 'Torus Knot', code: C3D.replace('// Add your 3D objects below:', 'scene.add(new THREE.Mesh(new THREE.TorusKnotGeometry(1,0.3,128,32),new THREE.MeshStandardMaterial({color:0x5c3d2e,roughness:0.3})));') },
  ],
  'complex': [
    { label: 'z²', code: CCX },
    { label: 'exp(z)', code: CCX.replace("const fnExpr='z^2'", "const fnExpr='exp(z)'") },
    { label: 'sin(z)', code: CCX.replace("const fnExpr='z^2'", "const fnExpr='sin(z)'") },
    { label: 'z+1/z', code: CCX.replace("const fnExpr='z^2'", "const fnExpr='z+1/z'") },
    { label: 'z³', code: CCX.replace("const fnExpr='z^2'", "const fnExpr='z^3'") },
  ],
};

export default function Playground() {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const canvasRef = useRef(null);
  const cleanupRef = useRef(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('2d');

  const run = useCallback((code) => {
    setError(null);
    const el = canvasRef.current;
    if (!el) return;
    if (cleanupRef.current) { try { cleanupRef.current(); } catch (e) {} cleanupRef.current = null; }
    el.innerHTML = '';
    try {
      const fn = new Function('THREE', 'OrbitControls', 'container', 'math', '"use strict";\n' + code);
      const result = fn(THREE, OrbitControls, el, math);
      if (typeof result === 'function') cleanupRef.current = result;
    } catch (e) { setError(e.message || String(e)); }
  }, []);

  const switchMode = useCallback((m) => {
    setMode(m);
    const code = MODES.find(x => x.id === m).code;
    if (viewRef.current) viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: code } });
    run(code);
  }, [run]);

  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;
    const state = EditorState.create({
      doc: C2D,
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

  useEffect(() => { setTimeout(() => run(C2D), 200); }, [run]);

  const handleRender = () => { const code = viewRef.current?.state.doc.toString() || ''; run(code); };
  const loadCode = (code) => {
    if (viewRef.current) viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: code } });
    run(code);
  };

  return (
    <main className="playground">
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>
      <div className="playground__modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={'playground__mode-btn' + (mode === m.id ? ' playground__mode-btn--active' : '')}
            onClick={() => switchMode(m.id)}
          >{m.label}</button>
        ))}
      </div>
      <div className="playground__presets">
        {(PRESETS[mode] || []).map((p, i) => (
          <button key={i} className="playground__chip" onClick={() => loadCode(p.code)}>{p.label}</button>
        ))}
      </div>
      <div className="playground__split">
        <div className="playground__editor-pane">
          <div className="playground__toolbar">
            <span>JavaScript</span>
            <button className="playground__render-btn" onClick={handleRender}>Render</button>
          </div>
          <div ref={editorRef} className="playground__editor" />
          {error && <div className="playground__error">{error}</div>}
        </div>
        <div className="playground__preview-pane">
          <div ref={canvasRef} className="playground__canvas" />
        </div>
      </div>
    </main>
  );
}
