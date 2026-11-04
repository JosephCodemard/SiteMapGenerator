import { zipSync, strToU8 } from 'fflate';
import { MODEL_LAYERS, type SceneObject } from '../process/scene';

/**
 * 3MF (3D Manufacturing Format): a zip with one colour-tagged object per layer, in millimetres. Slicers
 * (PrusaSlicer, Bambu Studio, Cura, 3D Builder) read it and keep the layer colours/names.
 */
export interface ThreeMfOptions {
  /** Output units per metre (1000 / scale denominator for mm at model scale). */
  scale: number;
  zExaggeration: number;
  /** Subtract this elevation (m) before scaling so the base sits at z = 0. */
  zOffset: number;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

export function writeThreeMf(objects: SceneObject[], opt: ThreeMfOptions): Uint8Array {
  const used = MODEL_LAYERS.filter((l) => objects.some((o) => o.layer === l.id));
  const r = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '<metadata name="Application">UK Site Model</metadata>',
    '<resources>',
    `<basematerials id="1">${used.map((l) => `<base name="${esc(l.cad)}" displaycolor="${l.color.toUpperCase()}FF"/>`).join('')}</basematerials>`,
  ];
  const build: string[] = [];
  used.forEach((layer, li) => {
    const id = li + 2;
    const verts: string[] = [], tris: string[] = [];
    let base = 0;
    for (const o of objects.filter((q) => q.layer === layer.id)) {
      const p = o.mesh.positions;
      for (let i = 0; i < p.length; i += 3) verts.push(`<vertex x="${r(p[i] * opt.scale)}" y="${r(p[i + 1] * opt.scale)}" z="${r((p[i + 2] - opt.zOffset) * opt.scale * opt.zExaggeration)}"/>`);
      const idx = o.mesh.indices;
      for (let i = 0; i < idx.length; i += 3) tris.push(`<triangle v1="${idx[i] + base}" v2="${idx[i + 1] + base}" v3="${idx[i + 2] + base}"/>`);
      base += p.length / 3;
    }
    lines.push(`<object id="${id}" type="model" name="${esc(layer.cad)}" pid="1" pindex="${li}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
    build.push(`<item objectid="${id}"/>`);
  });
  lines.push('</resources>', `<build>${build.join('')}</build>`, '</model>');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(lines.join('\n')),
  }, { level: 3 });
}
