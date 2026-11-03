"""Build src/geo/ostn15-correction.json.

proj4js only supports the 7-parameter Helmert transform for EPSG:27700, which
is 2-5 m out from the official OSTN15 transformation. This script samples the
difference (OSTN15 - Helmert) in BNG metres on a regular grid, so the app can
correct Helmert results with a cheap bilinear lookup (cm-level accuracy).

Usage:
  pip install pyproj numpy
  curl -O https://cdn.proj.org/uk_os_OSTN15_NTv2_OSGBtoETRS.tif
  python tools/build_ostn15_correction.py path/to/uk_os_OSTN15_NTv2_OSGBtoETRS.tif
"""
import json
import os
import sys

import numpy as np
from pyproj import Transformer

TMERC = ("+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 "
         "+y_0=-100000 +ellps=airy")
# Identical to the proj4js / EPSG:27700 Helmert definition used in the app.
HELMERT = TMERC + " +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"

E0, N0, STEP, NX, NY = 0, 0, 5000, 141, 141  # England & Wales: 0..700 km E/N


def main(grid_path: str) -> None:
    grid = os.path.abspath(grid_path)
    # True BNG -> ETRS89 via the OSTN15 horizontal grid shift.
    ostn = Transformer.from_pipeline(
        f"+proj=pipeline +step +inv {TMERC} +step +proj=hgridshift +grids={grid} "
        "+step +proj=unitconvert +xy_in=rad +xy_out=deg")
    helmert = Transformer.from_crs("EPSG:4258", HELMERT, always_xy=True)

    def deltas(e, n):
        lon, lat = ostn.transform(e, n)
        he, hn = helmert.transform(lon, lat)
        return e - he, n - hn

    es, ns = np.meshgrid(E0 + STEP * np.arange(NX), N0 + STEP * np.arange(NY))
    dx, dy = deltas(es.ravel().astype(float), ns.ravel().astype(float))
    dx, dy = dx.reshape(NY, NX), dy.reshape(NY, NX)

    # Nodes outside the OSTN15 grid (open sea) -> nearest valid value.
    valid = np.isfinite(dx) & np.isfinite(dy) & (np.abs(dx) < 50)
    vi = np.argwhere(valid)
    for j, i in np.argwhere(~valid):
        k = np.argmin((vi[:, 0] - j) ** 2 + (vi[:, 1] - i) ** 2)
        dx[j, i], dy[j, i] = dx[tuple(vi[k])], dy[tuple(vi[k])]

    # Check interpolation error at cell centres around Bath and across England.
    def bilinear(arr, e, n):
        fx, fy = (e - E0) / STEP, (n - N0) / STEP
        i, j = int(fx), int(fy)
        tx, ty = fx - i, fy - j
        return ((1 - tx) * (1 - ty) * arr[j, i] + tx * (1 - ty) * arr[j, i + 1]
                + (1 - tx) * ty * arr[j + 1, i] + tx * ty * arr[j + 1, i + 1])

    rng = np.random.default_rng(1)
    pts = np.column_stack([rng.uniform(150000, 650000, 3000), rng.uniform(20000, 650000, 3000)])
    pts = np.vstack([pts, [[375000, 164700], [372500, 162500], [377700, 166300]]])
    tx, ty = deltas(pts[:, 0], pts[:, 1])
    ok = np.isfinite(tx)
    err = [np.hypot(bilinear(dx, e, n) - a, bilinear(dy, e, n) - b)
           for (e, n), a, b, k in zip(pts, tx, ty, ok) if k]
    print(f"interp error: max {max(err)*100:.1f} cm, mean {np.mean(err)*100:.2f} cm "
          f"(Bath delta: {bilinear(dx, 375000, 164700):.2f}, {bilinear(dy, 375000, 164700):.2f} m)")

    out = {
        "source": "OSTN15 (Ordnance Survey) minus proj4js Helmert, metres x1000",
        "e0": E0, "n0": N0, "step": STEP, "nx": NX, "ny": NY,
        "dx": np.round(dx * 1000).astype(int).ravel().tolist(),
        "dy": np.round(dy * 1000).astype(int).ravel().tolist(),
    }
    dst = os.path.join(os.path.dirname(__file__), "..", "src", "geo", "ostn15-correction.json")
    with open(dst, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", os.path.normpath(dst), os.path.getsize(dst) // 1024, "KB")


if __name__ == "__main__":
    main(sys.argv[1])
