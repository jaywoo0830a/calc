import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { OrbitControls } from '../lib/OrbitControls.js';

export default function Playground() {
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0xf8f4eb);
    el.appendChild(renderer.domElement);

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(4, 3, 4);
    camera.lookAt(0, 0, 0);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Scene
    const scene = new THREE.Scene();

    // Grid
    scene.add(new THREE.GridHelper(6, 20, 0xd4c9b5, 0xe5ddcc));

    // Axis lines
    const ax = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-4, 0, 0), new THREE.Vector3(4, 0, 0),
      new THREE.Vector3(0, -4, 0), new THREE.Vector3(0, 4, 0),
      new THREE.Vector3(0, 0, -4), new THREE.Vector3(0, 0, 4),
    ]);
    scene.add(new THREE.LineSegments(ax, new THREE.LineBasicMaterial({ color: 0x2c2416 })));

    // Torus knot — a classic Three.js demo
    const geo = new THREE.TorusKnotGeometry(1, 0.3, 128, 32);
    const mat = new THREE.MeshStandardMaterial({ color: 0x5c3d2e, roughness: 0.3, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const light = new THREE.DirectionalLight(0xffffff, 0.8);
    light.position.set(5, 10, 5);
    scene.add(light);

    // Animate
    let id;
    function animate() {
      id = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // Resize
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
    <main className="playground" tabIndex={-1}>
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>
      <div className="playground__stage" ref={containerRef} />
    </main>
  );
}
