import type { Mesh } from '../process/mesh';

export interface StlTransform {
  /** Multiply local metres by this (e.g. 1000 / 500 for 1:500 in mm). */
  scale: number;
  /** Vertical exaggeration. */
  zExaggeration: number;
  /** Subtract this elevation (m) before scaling so the base sits at z = 0. */
  zOffset: number;
}

/** Binary STL of several meshes (each must already be closed for printing). */
export function writeStl(meshes: Mesh[], t: StlTransform): ArrayBuffer {
  const triCount = meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  const header = 'UK DTM App STL - units: mm (see README.txt)';
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) : 32);
  dv.setUint32(80, triCount, true);
  let o = 84;
  const v = new Float32Array(9);
  for (const m of meshes) {
    const p = m.positions, idx = m.indices;
    for (let k = 0; k < idx.length; k += 3) {
      for (let c = 0; c < 3; c++) {
        const q = idx[k + c] * 3;
        v[c * 3] = p[q] * t.scale;
        v[c * 3 + 1] = p[q + 1] * t.scale;
        v[c * 3 + 2] = (p[q + 2] - t.zOffset) * t.scale * t.zExaggeration;
      }
      const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
      const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
      for (let c = 0; c < 9; c++) dv.setFloat32(o + 12 + c * 4, v[c], true);
      dv.setUint16(o + 48, 0, true);
      o += 50;
    }
  }
  return buf;
}
