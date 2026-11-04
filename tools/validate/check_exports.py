# Validate the files written by tools/e2e/drive.mjs.
# Usage: python check_exports.py <e2e out dir>     (needs: numpy trimesh networkx ezdxf scipy shapely)
#
# - STL zip: one file per layer; each is split into connected bodies and checked for closure.
#   (Overlapping OSM buildings/areas that share vertices can show up as non-watertight bodies here.)
# - 3D DXF: audited with ezdxf, polyface meshes counted per layer.
# - 2D DXF: audited, entity counts per layer, TREE block present.
# - OBJ zip: every per-layer file loads.
import sys, glob, zipfile, tempfile, os
from collections import Counter
import numpy as np, trimesh
from ezdxf import recover

out = sys.argv[1]
tmp = tempfile.mkdtemp()

for z in glob.glob(f'{out}/*_stl_*.zip'):
    zipfile.ZipFile(z).extractall(f'{tmp}/stl')
    print('STL layers (bodies are connected components; watertight = closed solid)')
    for f in sorted(glob.glob(f'{tmp}/stl/*.stl')):
        m = trimesh.load(f, process=True)
        bodies = m.split(only_watertight=False)
        wt = sum(b.is_watertight for b in bodies)
        print(f'  {os.path.basename(f):14} tris={len(m.faces):7} bodies={len(bodies):5} watertight={wt}/{len(bodies)}')

for f in glob.glob(f'{out}/*_3d.dxf'):
    doc, aud = recover.readfile(f)
    c = Counter((e.dxf.layer, e.dxftype(), e.is_poly_face_mesh if e.dxftype() == 'POLYLINE' else None) for e in doc.modelspace())
    print(f'3D DXF {os.path.basename(f)}: version {doc.dxfversion}, audit errors {len(aud.errors)}, fixes {len(aud.fixes)}')
    for k, v in sorted(c.items()):
        print('  ', k, v)

import ezdxf
for f in sorted(glob.glob(f'{out}/*_r2000.dxf') + glob.glob(f'{out}/*_r12.dxf') + glob.glob(f'{out}/*Section*.dxf')):
    if f.endswith('_3d.dxf'):
        continue
    doc = ezdxf.readfile(f)  # strict reader: fails on malformed structure
    aud = doc.audit()
    c = Counter((e.dxf.layer, e.dxftype()) for e in doc.modelspace())
    print(f'2D DXF {os.path.basename(f)}: version {doc.dxfversion}, audit errors {len(aud.errors)}, fixes {len(aud.fixes)}, blocks {[b.name for b in doc.blocks if not b.name.startswith("*")]}')
    for k, v in sorted(c.items()):
        print('  ', k, v)

for z in glob.glob(f'{out}/site_*_obj.zip'):
    zipfile.ZipFile(z).extractall(f'{tmp}/obj')
    print('OBJ layers')
    for f in sorted(glob.glob(f'{tmp}/obj/*.obj')):
        m = trimesh.load(f, process=False, force='mesh')
        print(f'  {os.path.basename(f):16} faces={len(m.faces)}')

for f in glob.glob(f'{out}/*.pdf'):
    try:
        from pypdf import PdfReader
        r = PdfReader(f)
        print(f'PDF {os.path.basename(f)}: {len(r.pages)} pages, sizes mm', [tuple(round(float(x) * 25.4 / 72) for x in (p.mediabox.width, p.mediabox.height)) for p in r.pages])
    except ImportError:
        print('PDF', os.path.basename(f), 'header', open(f, 'rb').read(8))
