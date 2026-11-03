import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Mesh } from '../process/mesh';

/** WebGL preview of the terrain + LOD1 buildings (Z-up, local metres). */
export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private model = new THREE.Group();
  private terrain?: THREE.Mesh;
  private buildings?: THREE.Mesh;
  private zMin = 0;
  private resizeObserver: ResizeObserver;

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#eef1f4');
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 50000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#8d8a80', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(-1, 1.2, 2);
    this.scene.add(sun);
    this.scene.add(this.model);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(el);
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setModel(terrain: Mesh, buildings: Mesh | null, texture: HTMLCanvasElement | null) {
    this.clear();
    const tGeom = toGeometry(terrain, true);
    const tex = texture ? new THREE.CanvasTexture(texture) : null;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    }
    this.terrain = new THREE.Mesh(tGeom, new THREE.MeshLambertMaterial({ color: tex ? '#ffffff' : '#d8d3c4', map: tex }));
    this.model.add(this.terrain);
    if (buildings && buildings.indices.length) {
      const bGeom = toGeometry(buildings, false).toNonIndexed();
      bGeom.computeVertexNormals();
      this.buildings = new THREE.Mesh(bGeom, new THREE.MeshLambertMaterial({ color: '#f4f1ea' }));
      this.model.add(this.buildings);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(bGeom, 30), new THREE.LineBasicMaterial({ color: '#7d7a72' }));
      this.model.add(edges);
    }

    tGeom.computeBoundingBox();
    const bb = tGeom.boundingBox!;
    this.zMin = bb.min.z;
    const size = new THREE.Vector3();
    bb.getSize(size);
    const centre = new THREE.Vector3();
    bb.getCenter(centre);
    const r = Math.max(size.x, size.y);
    this.controls.target.set(centre.x, centre.y, bb.min.z);
    this.camera.position.set(centre.x - r * 0.6, centre.y - r * 0.9, bb.max.z + r * 0.7);
    this.camera.near = r / 1000;
    this.camera.far = r * 20;
    this.camera.updateProjectionMatrix();
    this.resize();
  }

  setExaggeration(z: number) {
    // Scale about the lowest point so the model stays on the ground plane.
    this.model.scale.set(1, 1, z);
    this.model.position.z = this.zMin * (1 - z);
  }

  setBuildingsVisible(v: boolean) {
    this.model.children.forEach((c) => { if (c !== this.terrain) c.visible = v; });
  }

  screenshot(): Promise<Blob> {
    return new Promise((res, rej) => this.renderer.domElement.toBlob((b) => (b ? res(b) : rej(new Error('Screenshot failed'))), 'image/png'));
  }

  clear() {
    for (const c of [...this.model.children]) {
      this.model.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.MeshLambertMaterial | undefined;
      mat?.map?.dispose();
      mat?.dispose();
    }
    this.terrain = this.buildings = undefined;
  }
}

function toGeometry(m: Mesh, withUv: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  if (withUv && m.uvs) g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeVertexNormals();
  return g;
}
