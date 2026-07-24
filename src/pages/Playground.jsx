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

// ── Complex Plane: domain coloring of f(z) ────────────────────────────────
const CCX = setup3D() +
"cam.position.set(0,0,4);cam.lookAt(0,0,0);ctrl.enableRotate=false;"+
"// Domain coloring: f(z) where z=x+iy. Hue=arg(f(z)), Brightness=|f(z)|\n"+
"const fn='(z^2-1)/(z^2+1)';const R=2.5;const texSize=512;"+
"const cv=document.createElement('canvas');cv.width=cv.height=texSize;const ctx=cv.getContext('2d');const img=ctx.createImageData(texSize,texSize);"+
"for(let py=0;py<texSize;py++){for(let px=0;px<texSize;px++){const x=(px/texSize-0.5)*2*R;const y=(py/texSize-0.5)*2*R;"+
"try{const z=math.complex(x,y);const fz=math.evaluate(fn,{z});const arg=math.arg(fz);const mag=math.abs(fz);"+
"const hue=((arg+Math.PI)/(2*Math.PI))*360;const light=1-1/(1+mag);const sat=0.7+0.3*light;"+
"const cc=(1-Math.abs(2*light-1))*sat;const x2=cc*(1-Math.abs((hue/60)%2-1));const m=light-cc/2;let rr,gg,bb;"+
"if(hue<60){rr=cc;gg=x2;bb=0}else if(hue<120){rr=x2;gg=cc;bb=0}else if(hue<180){rr=0;gg=cc;bb=x2}"+
"else if(hue<240){rr=0;gg=x2;bb=cc}else if(hue<300){rr=x2;gg=0;bb=cc}else{rr=cc;gg=0;bb=x2};"+
"const i=(py*texSize+px)*4;img.data[i]=Math.round((rr+m)*255);img.data[i+1]=Math.round((gg+m)*255);img.data[i+2]=Math.round((bb+m)*255);img.data[i+3]=255;}catch{}}}"+
"ctx.putImageData(img,0,0);"+
"const tex=new THREE.CanvasTexture(cv);tex.minFilter=THREE.LinearFilter;"+
"scene.add(new THREE.Mesh(new THREE.PlaneGeometry(R*2,R*2),new THREE.MeshBasicMaterial({map:tex})));"+
"// Axes\n"+
"const ax2=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-R,0,0),new THREE.Vector3(R,0,0),new THREE.Vector3(0,-R,0),new THREE.Vector3(0,R,0)]);"+
"scene.add(new THREE.LineSegments(ax2,new THREE.LineBasicMaterial({color:0x2c2416})));"+
"// Change fn above to explore different complex functions\n"+
anim3D();

const MODES = [
  { id: '2d', label: '2D', code: C2D },
  { id: '3d', label: '3D', code: C3D },
  { id: 'complex', label: 'Complex', code: CCX },
];

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
