import type { Mesh } from '../process/mesh';

export interface ObjOptions {
  /** 'z' keeps Z up (Rhino, AutoCAD); 'y' swaps to Y-up (Blender, three.js, Revit via FBX tools). */
  up: 'z' | 'y';
  /** Name of the terrain texture image, if one is exported alongside. */
  texture?: string;
}

/** Wavefront OBJ + MTL. Terrain is one object; each building is its own object. */
export function writeObj(
  objects: { name: string; mesh: Mesh; material: string }[],
  opts: ObjOptions,
): { obj: BlobPart[]; mtl: string } {
  const out: string[] = ['# UK DTM App export. Units: metres. See origin.txt for the local origin.\n', 'mtllib model.mtl\n'];
  let vBase = 1, vtBase = 1;
  const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
  for (const { name, mesh, material } of objects) {
    const p = mesh.positions;
    const lines: string[] = [];
    for (let k = 0; k < p.length; k += 3) {
      const [x, y, z] = [p[k], p[k + 1], p[k + 2]];
      lines.push(opts.up === 'z' ? `v ${fmt(x)} ${fmt(y)} ${fmt(z)}` : `v ${fmt(x)} ${fmt(z)} ${fmt(-y)}`);
    }
    const uv = mesh.uvs && opts.texture ? mesh.uvs : null;
    if (uv) for (let k = 0; k < uv.length; k += 2) lines.push(`vt ${uv[k].toFixed(5)} ${uv[k + 1].toFixed(5)}`);
    out.push(lines.join('\n') + '\n');

    const parts = mesh.parts ?? [[name, 0, mesh.indices.length] as [string, number, number]];
    for (const [partName, start, count] of parts) {
      const f: string[] = [`o ${partName}`, `usemtl ${material}`];
      for (let t = start; t < start + count; t += 3) {
        const [a, b, c] = [mesh.indices[t] + vBase, mesh.indices[t + 1] + vBase, mesh.indices[t + 2] + vBase];
        if (uv) {
          const [ta, tb, tc] = [a - vBase + vtBase, b - vBase + vtBase, c - vBase + vtBase];
          f.push(`f ${a}/${ta} ${b}/${tb} ${c}/${tc}`);
        } else f.push(`f ${a} ${b} ${c}`);
      }
      out.push(f.join('\n') + '\n');
    }
    vBase += p.length / 3;
    if (uv) vtBase += uv.length / 2;
  }
  const mtl = [
    'newmtl terrain', 'Kd 0.85 0.85 0.82', 'Ka 0 0 0', opts.texture ? `map_Kd ${opts.texture}` : '', '',
    'newmtl buildings', 'Kd 0.95 0.94 0.92', 'Ka 0 0 0', '',
  ].join('\n');
  return { obj: out, mtl };
}
