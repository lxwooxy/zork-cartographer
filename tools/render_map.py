"""Render the canonical map + layout to an SVG, one panel per level, for checking by eye.

    python tools/render_map.py game/zork1-map.json game/zork1-layout.json > map.svg
"""
from __future__ import annotations

import html
import json
import sys

S = 70          # pixels per map unit
W, H = 92, 30   # room box


def main():
    rooms = json.load(open(sys.argv[1]))["rooms"]
    lay = json.load(open(sys.argv[2]))
    levels = sorted({p[2] for p in lay.values()}, reverse=True)
    panels = []
    x_off = 0
    for z in levels:
        ids = [r for r, p in lay.items() if p[2] == z]
        xs = [lay[r][0] for r in ids]
        ys = [lay[r][1] for r in ids]
        minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
        pw = (maxx - minx) * S + W + 60
        ph = (maxy - miny) * S + H + 80
        tx = lambda x: x_off + (x - minx) * S + W / 2 + 30
        ty = lambda y: (maxy - y) * S + H / 2 + 50
        out = [f'<text x="{x_off + 10}" y="24" class="lv">Level {z} ({len(ids)} rooms)</text>']
        for rid in ids:
            for d, ex in rooms[rid]["exits"].items():
                to = ex.get("to")
                if not to or to not in lay:
                    continue
                cls = "e" if lay[to][2] == z else "ez"
                if lay[to][2] != z:
                    continue
                cls += " cond" if "if" in ex else ""
                cls += " one" if ex.get("oneway") else ""
                out.append(f'<line x1="{tx(lay[rid][0]):.0f}" y1="{ty(lay[rid][1]):.0f}" '
                           f'x2="{tx(lay[to][0]):.0f}" y2="{ty(lay[to][1]):.0f}" class="{cls}"/>')
        for rid in ids:
            x, y = tx(lay[rid][0]), ty(lay[rid][1])
            r = rooms[rid]
            ud = ("▲" if "up" in r["exits"] and r["exits"]["up"].get("to") else "") + \
                 ("▼" if "down" in r["exits"] and r["exits"]["down"].get("to") else "")
            out.append(f'<rect x="{x - W / 2:.0f}" y="{y - H / 2:.0f}" width="{W}" height="{H}" rx="5"/>')
            out.append(f'<text x="{x:.0f}" y="{y - 2:.0f}">{html.escape(r["name"][:16])}</text>')
            out.append(f'<text x="{x:.0f}" y="{y + 10:.0f}" class="id">{html.escape(rid[:16])} {ud}</text>')
        panels.append("\n".join(out))
        x_off += pw + 20
    total_h = max(800, 1400)
    print(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{x_off:.0f}" height="{total_h}" style="background:#0e1110">
<style>
rect {{ fill:#22302a; stroke:#4f8a6b; }} text {{ fill:#d6e2da; font: 10px monospace; text-anchor: middle; }}
text.id {{ fill:#6f8278; font-size: 8px; }} text.lv {{ fill:#7ee0a1; font-size: 16px; text-anchor: start; }}
line.e {{ stroke:#5c7a6b; stroke-width:2; }} line.cond {{ stroke:#c9a75c; stroke-dasharray:5 3; }} line.one {{ stroke:#c96b6b; }}
</style>
{"".join(panels)}
</svg>''')


if __name__ == "__main__":
    main()
