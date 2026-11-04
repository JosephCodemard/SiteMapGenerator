import { MODEL_LAYERS, layerDef, type SceneObject } from '../process/scene';

export interface ObjOptions {
  /** 'z' keeps Z up (Rhino, AutoCAD); 'y' swaps to Y-up (Blender, three.js, Revit via FBX tools). */
  up: 'z' | 'y';
  /** 'combined' = one OBJ with a group per layer; 'layers' = one OBJ file per layer. */
  structure: 'combined' | 'layers';
  /** Name of the terrain texture image, if one is exported alongside. */
  texture?: string;
}

const hex = (c: string) => [1, 3, 5].map((i) => (parseInt(c.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

/** Wavefront OBJ + MTL. One group (`g`) and material per layer, one object (`o`) per building/tree/bridge/… */
export function writeObj(objects: SceneObject[], opts: ObjOptions): { obj: BlobPart[]; mtl: string; layers: Record<string, BlobPart[]> } {
  const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
  const file = (list: SceneObject[]): BlobPart[] => {
    const out: string[] = ['# UK Site Model export. Units: metres. See origin.txt for the local origin.\n', 'mtllib model.mtl\n'];
    let vBase = 1, vtBase = 1;
    for (const { layer, mesh } of list) {
      const def = layerDef(layer);
      const p = mesh.positions;
      const lines: string[] = [];
      for (let k = 0; k < p.length; k += 3) {
        const [x, y, z] = [p[k], p[k + 1], p[k + 2]];
        lines.push(opts.up === 'z' ? `v ${fmt(x)} ${fmt(y)} ${fmt(z)}` : `v ${fmt(x)} ${fmt(z)} ${fmt(-y)}`);
      }
      const uv = mesh.uvs && opts.texture && layer === 'terrain' ? mesh.uvs : null;
      if (uv) for (let k = 0; k < uv.length; k += 2) lines.push(`vt ${uv[k].toFixed(5)} ${uv[k + 1].toFixed(5)}`);
      out.push(lines.join('\n') + '\n');
      out.push(`g ${def.cad}\n`);
      const parts = mesh.parts?.length ? mesh.parts : [[def.label.toLowerCase().replace(/\W+/g, '_'), 0, mesh.indices.length] as [string, number, number]];
      for (const [partName, start, count] of parts) {
        const f: string[] = [`o ${partName}`, `usemtl ${def.cad}`];
        for (let t = start; t < start + count; t += 3) {
          const [a, b, c] = [mesh.indices[t] + vBase, mesh.indices[t + 1] + vBase, mesh.indices[t + 2] + vBase];
          if (uv) {
            const d = vtBase - vBase;
            f.push(`f ${a}/${a + d} ${b}/${b + d} ${c}/${c + d}`);
          } else f.push(`f ${a} ${b} ${c}`);
        }
        out.push(f.join('\n') + '\n');
      }
      vBase += p.length / 3;
      if (uv) vtBase += uv.length / 2;
    }
    return out;
  };

  const used = new Set(objects.map((o) => o.layer));
  const mtl = MODEL_LAYERS.filter((l) => used.has(l.id)).map((l) =>
    [`newmtl ${l.cad}`, `Kd ${hex(l.color)}`, 'Ka 0 0 0', l.id === 'terrain' && opts.texture ? `map_Kd ${opts.texture}` : '', ''].filter((x) => x !== '').join('\n')).join('\n');

  const layers: Record<string, BlobPart[]> = {};
  if (opts.structure === 'layers') {
    for (const l of MODEL_LAYERS) {
      const list = objects.filter((o) => o.layer === l.id);
      if (list.length) layers[l.cad] = file(list);
    }
  }
  return { obj: opts.structure === 'combined' ? file(objects) : [], mtl, layers };
}
