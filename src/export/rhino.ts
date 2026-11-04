import { extract } from './gltf';
import { MODEL_LAYERS, type SceneObject } from '../process/scene';
import type { Building, XY } from '../types';

/**
 * Rhino 3DM via rhino3dm (WASM, loaded on demand): one Rhino layer per model layer (with its colour), one named
 * mesh object per building / tree / bridge / ..., building attributes as object user text (OSM id, heights, roof
 * types, listing). Units are metres; coordinates are local (origin stored in the file's document strings).
 */
type Rhino = Awaited<ReturnType<typeof load>>;
let cached: ReturnType<typeof load> | null = null;

async function load() {
  type Factory = (o?: unknown) => Promise<any>;
  if (typeof window !== 'undefined') {
    // Browser: the ES-module build plus its WASM (no Node requires).
    const [mod, wasm] = await Promise.all([import('rhino3dm/rhino3dm.module.js'), import('rhino3dm/rhino3dm.wasm?url')]);
    const url = (wasm as { default: string }).default;
    return ((mod as unknown as { default: Factory }).default)({ locateFile: () => url });
  }
  // Node (tests): the package's CommonJS entry, kept out of the browser bundle.
  const spec = 'rhino3dm';
  const mod = (await import(/* @vite-ignore */ spec)) as { default?: Factory } & Factory;
  return (mod.default ?? mod)();
}

const hex = (c: string): { r: number; g: number; b: number; a: number } => ({ r: parseInt(c.slice(1, 3), 16), g: parseInt(c.slice(3, 5), 16), b: parseInt(c.slice(5, 7), 16), a: 255 });

export async function writeRhino(objects: SceneObject[], buildings: Building[], origin: XY, notes: string[] = []): Promise<Uint8Array> {
  const rhino: Rhino = await (cached ??= load());
  const doc = new rhino.File3dm();
  const used = MODEL_LAYERS.filter((l) => objects.some((o) => o.layer === l.id));
  used.forEach((l) => { const ly = new rhino.Layer(); ly.name = l.cad; ly.color = hex(l.color); doc.layers().add(ly); });
  const byName = new Map(buildings.map((b) => [`building_${b.id.replace(/[^\w#-]/g, '_')}`, b]));
  doc.strings().set('origin_easting', String(origin[0]));
  doc.strings().set('origin_northing', String(origin[1]));
  doc.strings().set('crs', 'EPSG:27700 (British National Grid), heights m ODN; model coordinates are local metres');
  notes.forEach((n, i) => doc.strings().set(`note_${i + 1}`, n));
  for (const o of objects) {
    const layerIndex = used.findIndex((l) => l.id === o.layer);
    const parts = o.mesh.parts?.length ? o.mesh.parts : [[MODEL_LAYERS.find((l) => l.id === o.layer)!.cad.toLowerCase(), 0, o.mesh.indices.length] as [string, number, number]];
    for (const [name, start, count] of parts) {
      if (!count) continue;
      const { pos, idx } = extract(o.mesh, start, count);
      const mesh = new rhino.Mesh();
      for (let i = 0; i < pos.length; i += 3) mesh.vertices().add(pos[i], pos[i + 1], pos[i + 2]);
      for (let i = 0; i < idx.length; i += 3) mesh.faces().addTriFace(idx[i], idx[i + 1], idx[i + 2]);
      const attr = new rhino.ObjectAttributes();
      attr.name = name;
      attr.layerIndex = layerIndex;
      const b = byName.get(name.replace(/_\d+$/, '')) ?? byName.get(name);
      if (b) {
        attr.setUserString('osm_id', b.id);
        attr.setUserString('ground_m', b.ground.toFixed(2));
        attr.setUserString('top_m', b.top.toFixed(2));
        attr.setUserString('height_source', b.source);
        if (b.tags['building:levels']) attr.setUserString('levels', b.tags['building:levels']);
        if (b.roofParts) attr.setUserString('roof', b.roofParts.map((r) => r.type).join('+'));
        if (b.listed) attr.setUserString('listed', `${b.listed.grade} (${b.listed.entry}) ${b.listed.name}`);
      }
      doc.objects().addMesh(mesh, attr);
      mesh.delete(); attr.delete();
    }
  }
  const bytes = doc.toByteArray();
  doc.delete();
  return bytes;
}
