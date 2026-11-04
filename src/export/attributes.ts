import type { SiteData } from '../types';

const esc = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per building: the data that travels with the geometry (ids match the OBJ/STL/DXF object names). */
export function buildingAttributesCsv(site: SiteData): string {
  const head = ['id', 'object_name', 'name', 'address', 'levels', 'material', 'colour', 'ground_m', 'top_m', 'height_m', 'height_source',
    'roof_parts', 'roof_types', 'eaves_m', 'ridge_m', 'listed_grade', 'listed_entry', 'listed_name', 'dormers_procedural', 'roof_colour_imagery'];
  const rows = site.buildings.map((b) => {
    const roofs = b.roofParts ?? (b.roof ? [b.roof] : []);
    const addr = [b.tags['addr:housenumber'], b.tags['addr:street']].filter(Boolean).join(' ');
    return [
      b.id, `building_${b.id.replace(/[^\w#-]/g, '_')}`, b.tags.name, addr, b.tags['building:levels'], b.tags['building:material'], b.tags['building:colour'],
      b.ground.toFixed(2), b.top.toFixed(2), (b.top - b.ground).toFixed(2), b.source,
      roofs.length || '', roofs.map((r) => r.type).join('+'),
      roofs.length ? Math.min(...roofs.map((r) => r.eaves)).toFixed(2) : '', roofs.length ? Math.max(...roofs.map((r) => r.ridge)).toFixed(2) : '',
      b.listed?.grade, b.listed?.entry, b.listed?.name, b.dormers?.length ?? '', b.roofColour,
    ].map(esc).join(',');
  });
  return [head.join(','), ...rows].join('\n') + '\n';
}
