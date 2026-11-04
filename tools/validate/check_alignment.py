# Usage: python check_alignment.py <unzipped dataset export dir>  (needs numpy scipy shapely)
# How well do OSM footprints (WGS84 -> BNG via our OSTN15 table) line up with LIDAR roofs?
# Shift footprints by (dx, dy) and find the offset that maximises mean nDSM inside them.
import sys, json, numpy as np
from shapely.geometry import shape
from shapely import contains_xy
d = sys.argv[1]
def asc(p):
    with open(p) as f: h = [f.readline().split() for _ in range(6)]
    hd = {k: float(v) for k, v in h}
    return hd, np.loadtxt(p, skiprows=6)
hd, dtm = asc(f'{d}/dtm_1m.asc'); _, dsm = asc(f'{d}/dsm_1m.asc')
ndsm = dsm - dtm
x0, y1, H = hd['xllcorner'], hd['yllcorner'] + hd['nrows'], int(hd['nrows'])
E, N = np.meshgrid(x0 + 0.5 + np.arange(ndsm.shape[1]), y1 - 0.5 - np.arange(H))
polys = [shape(f['geometry']) for f in json.load(open(f'{d}/features_bng.geojson'))['features'] if f['properties']['layer'] == 'building']
mask = np.zeros(ndsm.shape, bool)
for p in polys:
    mask |= contains_xy(p, E, N)
from scipy.ndimage import map_coordinates
rows, cols = np.nonzero(mask)
res = {}
for dx in np.arange(-3, 3.01, 0.25):
    for dy in np.arange(-3, 3.01, 0.25):
        v = map_coordinates(ndsm, [rows - dy, cols + dx], order=1, mode='nearest')
        res[(dx, dy)] = v.mean()
(bx, by), bv = max(res.items(), key=lambda kv: kv[1])
print(f'buildings {len(polys)}, cells {mask.sum()}, mean nDSM at zero offset {res[(0.0,0.0)]:.2f} m, best {bv:.2f} m at dx={bx:+.2f} dy={by:+.2f} m')
# Robust metric: fraction of footprint cells that are "roof" (nDSM > 2.5 m) and
# fraction of a 2 m ring outside footprints that is NOT roof -> edge agreement.
roof = (ndsm > 2.5).astype(float)
from scipy.ndimage import binary_dilation
ring = binary_dilation(mask, iterations=2) & ~mask
rr, rc = np.nonzero(ring)
res2 = {}
for dx in np.arange(-3, 3.01, 0.5):
    for dy in np.arange(-3, 3.01, 0.5):
        inside = map_coordinates(roof, [rows - dy, cols + dx], order=1, mode='nearest').mean()
        outside = 1 - map_coordinates(roof, [rr - dy, rc + dx], order=1, mode='nearest').mean()
        res2[(dx, dy)] = inside + outside
(bx, by), bv = max(res2.items(), key=lambda kv: kv[1])
print(f'edge agreement at 0,0 = {res2[(0.0,0.0)]:.3f}; best {bv:.3f} at dx={bx:+.1f} dy={by:+.1f}')
for dx in (-2, -1, 0, 1, 2, 3): print(f'  dx={dx:+d} dy=0: {res2[(float(dx),0.0)]:.3f}')
