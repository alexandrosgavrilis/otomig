#!/usr/bin/env bash
# Phase R probe: a whole region import, measured on the wire.
#
# tools/probe-payload.sh showed Overpass gzips JSON about 7.3x, which means
# every payload figure in HANDOFF.md §4 was decoded size, not transfer. This
# measures what an actual import costs: the real chunk grid, the real query,
# wall-clock time and wire bytes, against the spec's "about two minutes".
#
# Usage: bash tools/probe-region.sh <size_km> [lon] [lat] [name]
#   bash tools/probe-region.sh 6                  # default 6 km Athens
#   bash tools/probe-region.sh 15                 # the slider maximum

set -u
SIZE=${1:-6}
LON=${2:-23.7275}
LAT=${3:-37.9838}
NAME=${4:-"central Athens"}

UA='OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)'
ENDPOINT='https://overpass-api.de/api/interpreter'
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT

ROADS='motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian'
AMEN='school|kindergarten|university|college|hospital|clinic|doctors|pharmacy|restaurant|cafe|fast_food|bar|pub|bank|post_office|library|theatre|cinema|museum|marketplace|townhall|police|fire_station|place_of_worship|sports_centre|swimming_pool|fuel|car_rental'

# The chunk grid the game actually uses: ceil(size / OVERPASS_CHUNK_TARGET_KM),
# matching overpassChunkCount() in config.js.
TARGET_KM=2.5
N=$(python3 -c "import math; print(max(1, math.ceil($SIZE/$TARGET_KM)))")
CHUNK_KM=$(python3 -c "print(f'{$SIZE/$N:.2f}')")

echo "=== $SIZE km region at $NAME ($LON, $LAT) ==="
echo "    ${N}x${N} = $((N*N)) chunks of ${CHUNK_KM} km"
echo

TOTAL_WIRE=0; TOTAL_JSON=0; TOTAL_ELS=0; FAILS=0
START_ALL=$(date +%s)

for ((i=0; i<N; i++)); do
  for ((j=0; j<N; j++)); do
    BB=$(python3 -c "
import math
size=$SIZE; lon=$LON; lat=$LAT; n=$N; i=$i; j=$j
dlat=size/111.32; dlon=size/(111.32*math.cos(math.radians(lat)))
s=lat-dlat/2+dlat*j/n;  nn=lat-dlat/2+dlat*(j+1)/n
w=lon-dlon/2+dlon*i/n;  e=lon-dlon/2+dlon*(i+1)/n
print(f'{s:.5f},{w:.5f},{nn:.5f},{e:.5f}')")

    Q="[out:json][timeout:180];
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

    CODE=000; ELAPSED=0
    for attempt in 1 2 3 4 5; do
      S=$(date +%s%N)
      CODE=$(curl -s --max-time 300 -H "User-Agent: $UA" \
        -H 'Content-Type: text/plain' -H 'Accept-Encoding: gzip' \
        --data-binary "$Q" -o "$OUT/c.bin" -w '%{http_code}' "$ENDPOINT")
      ELAPSED=$(( ($(date +%s%N) - S) / 1000000 ))
      [ "$CODE" = 200 ] && break
      printf "  chunk %2d,%-2d  HTTP %s, retrying\n" "$i" "$j" "$CODE"
      sleep $((attempt * 4))
    done

    if [ "$CODE" != 200 ]; then
      printf "  chunk %2d,%-2d  FAILED (%s)\n" "$i" "$j" "$CODE"
      FAILS=$((FAILS+1)); continue
    fi

    WIRE=$(stat -c%s "$OUT/c.bin")
    gzip -dc "$OUT/c.bin" > "$OUT/c.json" 2>/dev/null || cp "$OUT/c.bin" "$OUT/c.json"
    JSON=$(stat -c%s "$OUT/c.json")
    ELS=$(python3 -c "import json;print(len(json.load(open('$OUT/c.json'))['elements']))" 2>/dev/null || echo 0)

    TOTAL_WIRE=$((TOTAL_WIRE+WIRE)); TOTAL_JSON=$((TOTAL_JSON+JSON))
    TOTAL_ELS=$((TOTAL_ELS+ELS))
    printf "  chunk %2d,%-2d  %7.2f MB wire  %7.2f MB json  %8d els  %5.1fs\n" \
      "$i" "$j" \
      "$(python3 -c "print($WIRE/1048576)")" \
      "$(python3 -c "print($JSON/1048576)")" \
      "$ELS" "$(python3 -c "print($ELAPSED/1000)")"
  done
done

WALL=$(( $(date +%s) - START_ALL ))
echo
python3 -c "
w=$TOTAL_WIRE; j=$TOTAL_JSON; wall=$WALL; n=$((N*N)); els=$TOTAL_ELS; f=$FAILS
a=$SIZE*$SIZE
print(f'  {n} requests, {f} failed')
print(f'  wire total    {w/1048576:7.1f} MB   ({w/1048576/a:.3f} MB/km2)')
print(f'  decoded total {j/1048576:7.1f} MB   ({j/1048576/a:.3f} MB/km2)  ratio {j/w:.1f}x')
print(f'  elements      {els:,}')
print(f'  wall clock    {wall//60}m {wall%60}s  (Overpass only; elevation and')
print(f'                processing are extra, and the spec asks for ~2 min total)')
"
