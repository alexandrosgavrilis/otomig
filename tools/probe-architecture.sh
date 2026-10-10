#!/usr/bin/env bash
# Phase R: the candidate architecture, measured end to end at the spec's
# acceptance size (a dense 15x15 km city, "about two minutes or less").
#
# What the probes established:
#   - Overpass gzips ~7.5x, so HANDOFF.md §4's payload figures were decoded
#     JSON, not transfer. A 6 km dense import is 6.8 MB on the wire, not 66.
#   - The `>;` recursion over building geometry nodes is what makes chunks 504,
#     and buildings are 66% of the bytes. Everything else is cheap.
#   - So the split is not roads-vs-the-rest. It is buildings-vs-everything-else.
#
# Phase A: one request for roads + rail + water + stations + POI nodes.
#          Measured 4.71 MB / 13.5 s for a whole 15 km box.
# Phase B: buildings as `out geom` (no node recursion, no shared ids needed),
#          chunked only as much as it takes to avoid 504s.
#
# Usage: bash tools/probe-architecture.sh [size_km] [building_chunks_per_side]

set -u
export LC_NUMERIC=C
SIZE=${1:-15}
BCHUNKS=${2:-3}

UA='OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)'
ENDPOINT='https://overpass-api.de/api/interpreter'
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT

LON=23.7275
LAT=37.9838
ROADS='motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian'
AMEN='school|kindergarten|university|college|hospital|clinic|doctors|pharmacy|restaurant|cafe|fast_food|bar|pub|bank|post_office|library|theatre|cinema|museum|marketplace|townhall|police|fire_station|place_of_worship|sports_centre|swimming_pool|fuel|car_rental'

TOTAL_WIRE=0; TOTAL_JSON=0; REQUESTS=0; RETRIES=0
START=$(date +%s)

# bbox for cell (i,j) of an n x n grid over a `size` km square; n=1 → whole box
cell () { python3 -c "
import math
size=$1; n=$2; i=$3; j=$4; lat=$LAT; lon=$LON
dlat=size/111.32; dlon=size/(111.32*math.cos(math.radians(lat)))
s=lat-dlat/2+dlat*j/n;  nn=lat-dlat/2+dlat*(j+1)/n
w=lon-dlon/2+dlon*i/n;  e=lon-dlon/2+dlon*(i+1)/n
print(f'{s:.5f},{w:.5f},{nn:.5f},{e:.5f}')"; }

ask () { # label, query
  local label="$1" query="$2" code elapsed wire plain els attempts=0
  for attempt in 1 2 3 4 5 6; do
    attempts=$attempt
    local s=$(date +%s%N)
    code=$(curl -s --max-time 900 -H "User-Agent: $UA" -H 'Content-Type: text/plain' \
      -H 'Accept-Encoding: gzip' --data-binary "$query" -o "$OUT/r" -w '%{http_code}' "$ENDPOINT")
    elapsed=$(( ($(date +%s%N) - s) / 1000000 ))
    REQUESTS=$((REQUESTS+1))
    [ "$code" = 200 ] && break
    RETRIES=$((RETRIES+1))
    echo "      ($label: HTTP $code after $((elapsed/1000))s, retrying)"
    sleep $((attempt * 5))
  done
  if [ "$code" != 200 ]; then echo "    $label: FAILED ($code)"; return 1; fi

  wire=$(stat -c%s "$OUT/r")
  gzip -dc "$OUT/r" > "$OUT/j" 2>/dev/null || cp "$OUT/r" "$OUT/j"
  plain=$(stat -c%s "$OUT/j")
  els=$(python3 -c "import json;print(len(json.load(open('$OUT/j'))['elements']))" 2>/dev/null || echo '?')
  TOTAL_WIRE=$((TOTAL_WIRE+wire)); TOTAL_JSON=$((TOTAL_JSON+plain))
  python3 -c "
print(f'    {\"$label\":<26} {$wire/1048576:7.2f} MB wire {$plain/1048576:8.2f} MB json {$elapsed/1000:6.1f}s {\"$els\":>8} els')"
}

echo "=== candidate architecture, ${SIZE} km dense region (central Athens) ==="
echo
echo "  Phase A — everything except buildings, one request:"
BB=$(cell "$SIZE" 1 0 0)
ask "roads+rail+water+POIs" "[out:json][timeout:900];
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

echo
echo "  Phase B — buildings as out geom, ${BCHUNKS}x${BCHUNKS} chunks of $(python3 -c "print(f'{$SIZE/$BCHUNKS:.1f}')") km:"
for ((i=0; i<BCHUNKS; i++)); do
  for ((j=0; j<BCHUNKS; j++)); do
    BB=$(cell "$SIZE" "$BCHUNKS" "$i" "$j")
    ask "buildings $i,$j" "[out:json][timeout:900];
way[\"building\"]($BB);
out geom;"
  done
done

WALL=$(( $(date +%s) - START ))
echo
python3 -c "
w=$TOTAL_WIRE; j=$TOTAL_JSON; wall=$WALL; r=$REQUESTS; rt=$RETRIES
n=1+$BCHUNKS*$BCHUNKS
print(f'  === totals for a {$SIZE} km dense import, Overpass only ===')
print(f'    requests      {n} intended, {r} sent ({rt} retries)')
print(f'    wire          {w/1048576:7.1f} MB')
print(f'    decoded json  {j/1048576:7.1f} MB   (ratio {j/w:.1f}x)')
print(f'    wall clock    {wall//60}m {wall%60}s')
print()
print(f'    spec acceptance: a dense 15x15 km city imports in about two minutes.')
print(f'    elevation (9-25 terrain tiles) and processing are on top of this.')
"
