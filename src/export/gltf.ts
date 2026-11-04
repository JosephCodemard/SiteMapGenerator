import { MODEL_LAYERS, layerDef, type SceneObject } from '../process/scene';
import type { Mesh } from '../process/mesh';

/**
 * Binary glTF 2.0 (.glb) for web viewers, Blender, presentations. One node per layer with a child node per
 * building / tree / bridge / ..., one material per layer. glTF is Y-up, so local (x, y, z-up) becomes (x, z, -y).
 */
export interface GlbOptions {
  /** Multiply coordinates (1 = metres). */
  scale?: number;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const colour = (hex: string): [number, number, number, number] => [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)).concat(1) as [number, number, number, number];

/** A part's triangles with their own compact vertex list. */
export function extract(mesh: Mesh, start: number, count: number) {
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(count);
  for (let k = 0; k < count; k++) {
    const v = mesh.indices[start + k];
    let r = remap.get(v);
    if (r === undefined) { r = remap.size; remap.set(v, r); pos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]); }
    idx[k] = r;
  }
  return { pos: new Float32Array(pos), idx };
}

export function writeGlb(objects: SceneObject[], opts: GlbOptions = {}): ArrayBuffer {
  const k = opts.scale ?? 1;
  const used = MODEL_LAYERS.filter((l) => objects.some((o) => o.layer === l.id));
  const materials = used.map((l) => ({ name: l.cad, pbrMetallicRoughness: { baseColorFactor: colour(l.color), metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }));
  const nodes: unknown[] = [], meshes: unknown[] = [], accessors: unknown[] = [], views: unknown[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (data: ArrayBufferView, target: number): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    const padded = new Uint8Array(bytes.length + pad);
    padded.set(bytes);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(padded);
    offset += padded.length;
    return views.length - 1;
  };
  const roots: number[] = [];
  for (const layer of used) {
    const children: number[] = [];
    for (const o of objects.filter((q) => q.layer === layer.id)) {
      const parts = o.mesh.parts?.length ? o.mesh.parts : [[layer.cad.toLowerCase(), 0, o.mesh.indices.length] as [string, number, number]];
      for (const [name, start, count] of parts) {
        if (!count) continue;
        const { pos, idx } = extract(o.mesh, start, count);
        const out = new Float32Array(pos.length);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.length; i += 3) {
          const p = [pos[i] * k, pos[i + 2] * k, -pos[i + 1] * k];
          out.set(p, i);
          for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]); }
        }
        const pa = accessors.push({ bufferView: push(out, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: lo, max: hi }) - 1;
        const ia = accessors.push({ bufferView: push(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' }) - 1;
        const mi = meshes.push({ name, primitives: [{ attributes: { POSITION: pa }, indices: ia, material: used.indexOf(layer), mode: 4 }] }) - 1;
        children.push(nodes.push({ name, mesh: mi }) - 1);
      }
    }
    roots.push(nodes.push({ name: layer.cad, children }) - 1);
  }
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.length; }
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'UK Site Model' }, scene: 0, scenes: [{ nodes: roots }], nodes, meshes, materials, accessors, bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  });
  const jb = new TextEncoder().encode(json + ' '.repeat((4 - (json.length % 4)) % 4));
  const jpad = (4 - (jb.length % 4)) % 4;
  const jsonLen = jb.length + jpad;
  const total = 12 + 8 + jsonLen + 8 + bin.length;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out), u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
  u8.set(jb, 20);
  for (let i = jb.length; i < jsonLen; i++) u8[20 + i] = 0x20;
  dv.setUint32(20 + jsonLen, bin.length, true); dv.setUint32(24 + jsonLen, 0x004e4942, true);
  u8.set(bin, 28 + jsonLen);
  return out;
}

export { layerDef };
