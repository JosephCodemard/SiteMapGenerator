import type { Mesh } from './mesh';

/**
 * Robust boolean operations with manifold-3d (WASM, loaded on demand): union overlapping parts (OSM buildings
 * often overlap) into clean solids, and fuse buildings to the terrain into ONE printable solid. Anything that is
 * not a closed manifold is skipped and reported, never allowed to break the export.
 */
type ManifoldModule = Awaited<ReturnType<typeof load>>;
let modulePromise: ReturnType<typeof load> | null = null;

async function load() {
  const { default: Module } = await import('manifold-3d');
  const opts = typeof window !== 'undefined'
    ? { locateFile: () => (window as unknown as { __manifoldWasm?: string }).__manifoldWasm ?? '' }
    : undefined;
  if (opts && !opts.locateFile()) {
    const url = (await import('manifold-3d/manifold.wasm?url')).default as string;
    (window as unknown as { __manifoldWasm?: string }).__manifoldWasm = url;
  }
  const wasm = await Module(opts as never);
  wasm.setup();
  return wasm;
}

const manifold = (): ManifoldModule | Promise<ManifoldModule> => (modulePromise ??= load());

export interface UnionResult {
  mesh: Mesh;
  /** Parts that went into the union. */
  merged: number;
  /** Parts skipped because they are not closed manifolds. */
  skipped: string[];
}

function toManifold(wasm: ManifoldModule, positions: Float32Array, tris: ArrayLike<number>) {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: positions, triVerts: Uint32Array.from(tris) });
  mesh.merge(); // weld duplicate vertices by position
  const m = new wasm.Manifold(mesh);
  if (m.status() !== 'NoError' || m.isEmpty()) { m.delete(); throw new Error('not a closed manifold'); }
  return m;
}

function fromManifold(m: { getMesh(): { vertProperties: Float32Array; triVerts: Uint32Array; numProp: number } }): Mesh {
  const g = m.getMesh();
  // numProp may exceed 3 (extra properties): keep xyz only.
  const n = g.vertProperties.length / g.numProp;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions.set(g.vertProperties.subarray(i * g.numProp, i * g.numProp + 3), i * 3);
  return { positions, indices: Uint32Array.from(g.triVerts) };
}

/** Union every part of `layer` (its `parts` ranges) into one mesh. */
export async function unionParts(layer: Mesh, name = 'union'): Promise<UnionResult> {
  const wasm = await manifold();
  const parts = layer.parts?.length ? layer.parts : [[name, 0, layer.indices.length] as [string, number, number]];
  const ms: { delete(): void }[] = [];
  const skipped: string[] = [];
  for (const [pn, start, count] of parts) {
    try { ms.push(toManifold(wasm, layer.positions, layer.indices.subarray(start, start + count))); } catch { skipped.push(pn); }
  }
  if (!ms.length) return { mesh: { positions: new Float32Array(0), indices: new Uint32Array(0) }, merged: 0, skipped };
  const u = wasm.Manifold.union(ms as never);
  const mesh = fromManifold(u);
  mesh.parts = [[name, 0, mesh.indices.length]];
  ms.forEach((m) => m.delete()); u.delete();
  return { mesh, merged: parts.length - skipped.length, skipped };
}

/** Fuse closed solids (e.g. terrain solid + building unions) into one solid. */
export async function fuse(solids: Mesh[], name = 'MODEL'): Promise<{ mesh: Mesh; used: number }> {
  const wasm = await manifold();
  const ms: { delete(): void }[] = [];
  for (const s of solids) { try { ms.push(toManifold(wasm, s.positions, s.indices)); } catch { /* skip */ } }
  if (!ms.length) return { mesh: { positions: new Float32Array(0), indices: new Uint32Array(0) }, used: 0 };
  const u = wasm.Manifold.union(ms as never);
  const mesh = fromManifold(u);
  mesh.parts = [[name, 0, mesh.indices.length]];
  const used = ms.length;
  ms.forEach((m) => m.delete()); u.delete();
  return { mesh, used };
}
