#!/usr/bin/env bash
# Phase R probe: is it only BUILDINGS that make Overpass slow?
#
# tools/probe-payload.sh showed buildings are 66% of the wire bytes, and
# HANDOFF.md §4 showed a 5 km box 504s every time — but tools/probe-overpass.js
# then served a 7.5 km roads-only box in 3.1 s. The difference is the `>;`
# recursion over ~9,000 building geometry nodes per km².
#
# If buildings are the only expensive part, then the right split is not the one
# HANDOFF.md §5 proposes. Buildings go to tiles; roads, rail, water AND POIs all
# stay on Overpass, where they are cheap, live and fully tagged — which keeps the
# POI fidelity the tiles lose (24% of kinds, measured by tools/probe-compare.js).
#
# This measures the proposed single Overpass query at whole-region sizes.
#
# Usage: bash tools/probe-split.sh

set -u
UA='OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)'
ENDPOINT='https://overpass-api.de/api/interpreter'
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT
export LC_NUMERIC=C

LON=23.7275
LAT=37.9838
ROADS='motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian'
AMEN='school|kindergarten|university|college|hospital|clinic|doctors|pharmacy|restaurant|cafe|fast_food|bar|pub|bank|post_office|library|theatre|cinema|museum|marketplace|townhall|police|fire_station|place_of_worship|sports_centre|swimming_pool|fuel|car_rental'

box () { python3 -c "
import math
km=$1; lat=$LAT; lon=$LON
dlat=km/111.32/2; dlon=km/(111.32*math.cos(math.radians(lat)))/2
print(f'{lat-dlat:.5f},{lon-dlon:.5f},{lat+dlat:.5f},{lon+dlon:.5f}')"; }

ask () { # label, km, query  → prints one row
  local label="$1" km="$2" query="$3" raw="$OUT/r.bin" code elapsed wire plain els attempts=0
  for attempt in 1 2 3 4 5 6; do
    attempts=$attempt
    local start=$(date +%s%N)
    code=$(curl -s --max-time 600 -H "User-Agent: $UA" -H 'Content-Type: text/plain' \
      -H 'Accept-Encoding: gzip' --data-binary "$query" -o "$raw" -w '%{http_code}' "$ENDPOINT")
    elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
    [ "$code" = 200 ] && break
    sleep $((attempt * 5))
  done
  if [ "$code" != 200 ]; then
    printf "  %-30s %5s km   HTTP %s after %d attempts\n" "$label" "$km" "$code" "$attempts"
    return
  fi
  wire=$(stat -c%s "$raw")
  gzip -dc "$raw" > "$OUT/r.json" 2>/dev/null || cp "$raw" "$OUT/r.json"
  plain=$(stat -c%s "$OUT/r.json")
  els=$(python3 -c "import json;print(len(json.load(open('$OUT/r.json'))['elements']))" 2>/dev/null || echo '?')
  python3 -c "
w=$wire; p=$plain; ms=$elapsed; a=$km*$km
print(f'  {\"$label\":<30} {$km:>5} km {w/1048576:7.2f} MB wire {p/1048576:7.2f} MB json {w/1048576/a:7.3f} MB/km2 {\"$els\":>8} els {ms/1000:6.1f}s  x$attempts')"
}

echo "=== the proposed Overpass query: everything EXCEPT buildings, one request ==="
echo "    roads + rail + water + station nodes + shop/amenity POI nodes"
echo
for KM in 2 6 10 15; do
  BB=$(box $KM)
  ask "no buildings" "$KM" "[out:json][timeout:600];
(
  way[\"highway\"~\"^($ROADS)\$\"]($BB);
  way[\"natural\"=\"water\"]($BB);
  way[\"railway\"=\"rail\"]($BB);
  node[\"railway\"~\"^(station|halt)\$\"]($BB);
  node[\"shop\"]($BB);
  node[\"amenity\"~\"^($AMEN)\$\"]($BB);
);
out body;
>;
out skel qt;"
done

echo
echo "=== for contrast: the SAME box WITH buildings, one request ==="
echo "    (HANDOFF.md §4 measured 504 every time at 5 km)"
echo
for KM in 2 6; do
  BB=$(box $KM)
  ask "with buildings" "$KM" "[out:json][timeout:600];
(
  way[\"highway\"~\"^($ROADS)\$\"]($BB);
  way[\"building\"]($BB);
  way[\"natural\"=\"water\"]($BB);
  way[\"railway\"=\"rail\"]($BB);
  node[\"railway\"~\"^(station|halt)\$\"]($BB);
  node[\"shop\"]($BB);
  node[\"amenity\"~\"^($AMEN)\$\"]($BB);
);
out body;
>;
out skel qt;"
done
