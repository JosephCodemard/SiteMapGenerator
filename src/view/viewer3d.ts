import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { layerDef, type LayerId, type Scene } from '../process/scene';
import type { Mesh } from '../process/mesh';

/** WebGL preview of the scene: one mesh per layer so each can be shown or hidden (Z-up, local metres). */
export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private model = new THREE.Group();
  private layers = new Map<LayerId, THREE.Object3D[]>();
  private zMin = 0;
  private home = { cx: 0, cy: 0, r: 100, zMin: 0, zMax: 10 };
  private raycaster = new THREE.Raycaster();
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

  setScene(scene: Scene, texture: HTMLCanvasElement | null) {
    this.clear();
    const tex = texture ? new THREE.CanvasTexture(texture) : null;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    }
    let bounds: THREE.Box3 | null = null;
    for (const o of scene.objects) {
      const def = layerDef(o.layer);
      const geom = toGeometry(o.mesh, o.layer === 'terrain');
      const isTerrain = o.layer === 'terrain';
      const mat = new THREE.MeshLambertMaterial({
        color: isTerrain && tex ? '#ffffff' : def.color, map: isTerrain ? tex : null, flatShading: !isTerrain,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = { layer: o.layer, parts: o.mesh.parts };
      this.model.add(mesh);
      const list: THREE.Object3D[] = [mesh];
      if ((o.layer === 'buildings' || o.layer === 'bridges') && o.mesh.indices.length < 4_000_000) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), new THREE.LineBasicMaterial({ color: '#7d7a72' }));
        this.model.add(edges);
        list.push(edges);
      }
      this.layers.set(o.layer, list);
      if (isTerrain) {
        geom.computeBoundingBox();
        bounds = geom.boundingBox!.clone();
      }
    }
    if (!bounds) return;
    this.zMin = bounds.min.z;
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const centre = new THREE.Vector3();
    bounds.getCenter(centre);
    const r = Math.max(size.x, size.y);
    this.home = { cx: centre.x, cy: centre.y, r, zMin: bounds.min.z, zMax: bounds.max.z };
    this.setView('iso');
    this.camera.near = r / 1000;
    this.camera.far = r * 20;
    this.camera.updateProjectionMatrix();
    this.resize();
  }

  /** Camera presets: isometric, plan (top), south elevation, or re-fit. */
  setView(kind: 'iso' | 'top' | 'south' | 'east') {
    const { cx, cy, r, zMin, zMax } = this.home;
    this.controls.target.set(cx, cy, zMin);
    const p = {
      iso: [cx - r * 0.6, cy - r * 0.9, zMax + r * 0.7], top: [cx, cy - 0.001 * r, zMax + r * 1.6],
      south: [cx, cy - r * 1.6, zMin + (zMax - zMin) / 2 + r * 0.1], east: [cx + r * 1.6, cy, zMin + (zMax - zMin) / 2 + r * 0.1],
    }[kind];
    this.camera.position.set(p[0], p[1], p[2]);
    this.camera.near = r / 1000;
    this.camera.far = r * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** The object under a screen point: its layer and the name of the part (building, tree, ...). */
  pick(clientX: number, clientY: number): { layer: LayerId; part: string; point: THREE.Vector3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    const meshes = this.model.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && c.visible && c.userData.layer !== 'terrain');
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    const t = hit.faceIndex * 3;
    const parts = hit.object.userData.parts as [string, number, number][] | undefined;
    const part = parts?.find(([, s, c]) => t >= s && t < s + c)?.[0];
    return part ? { layer: hit.object.userData.layer as LayerId, part, point: hit.point } : null;
  }

  get canvas() { return this.renderer.domElement; }

  setExaggeration(z: number) {
    // Scale about the lowest point so the model stays on the ground plane.
    this.model.scale.set(1, 1, z);
    this.model.position.z = this.zMin * (1 - z);
  }

  setLayerVisible(id: LayerId, v: boolean) {
    this.layers.get(id)?.forEach((o) => (o.visible = v));
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
    this.layers.clear();
  }
}

function toGeometry(m: Mesh, smooth: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  if (smooth && m.uvs) g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  if (smooth) g.computeVertexNormals(); // other layers use flat shading from screen-space derivatives
  return g;
}
