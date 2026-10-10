#!/usr/bin/env bash
# Phase R probe: Overpass payload by query shape, measuring WIRE bytes.
#
# Node's fetch (undici) decompresses transparently even when asked not to, so
# it cannot report what actually crossed the wire. curl without --compressed
# writes the raw gzip stream to disk, which can then be measured both ways.
#
# Every figure in HANDOFF.md §4 is decoded-JSON size. A browser always sends
# Accept-Encoding: gzip, so the quoted 1.87 MB/km² may be several times the real
# transfer — and Overpass's 10 MB/day guidance is about transfer.
#
# Usage: bash tools/probe-payload.sh [box_km]

set -u
KM=${1:-2}
UA='OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)'
ENDPOINT='https://overpass-api.de/api/interpreter'
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

LON=23.7275
LAT=37.9838
BB=$(python3 -c "
import math
km=$KM; lat=$LAT; lon=$LON
dlat=km/111.32/2; dlon=km/(111.32*math.cos(math.radians(lat)))/2
print(f'{lat-dlat:.5f},{lon-dlon:.5f},{lat+dlat:.5f},{lon+dlon:.5f}')")
AREA=$(python3 -c "print($KM*$KM)")

ROADS='motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian'
AMEN='school|kindergarten|university|college|hospital|clinic|doctors|pharmacy|restaurant|cafe|fast_food|bar|pub|bank|post_office|library|theatre|cinema|museum|marketplace|townhall|police|fire_station|place_of_worship|sports_centre|swimming_pool|fuel|car_rental'

echo "=== Overpass payload by query shape — ${KM} km box of central Athens (${AREA} km²) ==="
echo "    bbox $BB"
echo
printf "%-32s %11s %11s %7s %12s %10s %7s\n" \
  query "wire(gzip)" decoded ratio "MB/km²wire" elements time
printf '%.0s-' {1..95}; echo

# Overpass 504s transiently; retry a few times before believing a failure.
ask () { # name, query
  local name="$1" query="$2" raw="$OUT/raw.bin" code elapsed wire plain els
  for attempt in 1 2 3 4 5 6; do
    local start=$(date +%s%N)
    code=$(curl -s --max-time 300 \
      -H "User-Agent: $UA" -H 'Content-Type: text/plain' \
      -H 'Accept-Encoding: gzip' \
      --data-binary "$query" -o "$raw" -w '%{http_code}' "$ENDPOINT")
    elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
    [ "$code" = 200 ] && break
    sleep $((attempt * 4))
  done
  if [ "$code" != 200 ]; then
    printf "%-32s %11s\n" "$name" "HTTP $code"
    return
  fi

  wire=$(stat -c%s "$raw")
  if gzip -t "$raw" 2>/dev/null || head -c2 "$raw" | od -An -tx1 | grep -q '1f 8b'; then
    gzip -dc "$raw" > "$OUT/plain.json" 2>/dev/null
  else
    cp "$raw" "$OUT/plain.json"
  fi
  plain=$(stat -c%s "$OUT/plain.json")
  els=$(python3 -c "
import json,sys
try: print(len(json.load(open('$OUT/plain.json')).get('elements',[])))
except Exception as e: print('?')")

  python3 -c "
w=$wire; p=$plain; a=$AREA; ms=$elapsed
print(f'{\"$name\":<32} {w/1048576:8.2f} MB {p/1048576:8.2f} MB {p/w:6.1f}x {w/1048576/a:12.3f} {\"$els\":>10} {ms/1000:6.1f}s')"
  # Keep the last successful body for follow-up inspection.
  cp "$OUT/plain.json" "$OUT/last-$name.json" 2>/dev/null
  echo "$wire $plain" > "$OUT/rate-$name"
}

ask "everything (today)" "[out:json][timeout:180];
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

ask "roads+rail+water" "[out:json][timeout:180];
(
  way[\"highway\"~\"^($ROADS)\$\"]($BB);
  way[\"natural\"=\"water\"]($BB);
  way[\"railway\"=\"rail\"]($BB);
  node[\"railway\"~\"^(station|halt)\$\"]($BB);
);
out body;
>;
out skel qt;"

ask "buildings, node recursion" "[out:json][timeout:180];
way[\"building\"]($BB);
out body;
>;
out skel qt;"

ask "buildings, out geom" "[out:json][timeout:180];
way[\"building\"]($BB);
out geom;"

ask "buildings, out geom skel" "[out:json][timeout:180];
way[\"building\"]($BB);
out skel geom;"

ask "POI nodes only" "[out:json][timeout:180];
(
  node[\"shop\"]($BB);
  node[\"amenity\"~\"^($AMEN)\$\"]($BB);
);
out body;"

echo
echo "=== does out geom carry what processBuildings needs? ==="
python3 -c "
import json
d=json.load(open('$OUT/last-buildings, out geom.json'))
ways=[e for e in d['elements'] if e['type']=='way']
ring=[w for w in ways if len(w.get('geometry',[]))>=3]
print(f'  {len(ways)} ways, {len(ring)} with a usable ring, {sum(1 for w in ways if w.get(\"tags\"))} with tags')
s=ring[0]
print(f'  sample: {len(s[\"geometry\"])} points, first {s[\"geometry\"][0]}, id {s[\"id\"]}')
print(f'  sample tags: {s.get(\"tags\")}')
" 2>/dev/null || echo "  (no out geom body kept)"

echo
echo "=== projected WIRE payload for a whole region at this density ==="
python3 -c "
import os
a=$AREA
def rate(n):
    p='$OUT/rate-'+n
    if not os.path.exists(p): return None
    w,_=open(p).read().split()
    return int(w)/1048576/a
today=rate('everything (today)')
split=[rate('roads+rail+water'), rate('buildings, out geom'), rate('POI nodes only')]
print(f'{\"region\":<10}{\"today, as shipped\":>20}{\"split + out geom\":>20}{\"saving\":>10}')
for km in (6,10,15):
    A=km*km
    t=today*A if today else float('nan')
    s=sum(x for x in split if x)*A
    print(f'{str(km)+\" km\":<10}{t:>17.1f} MB{s:>17.1f} MB{100*(1-s/t):>9.0f}%')
"
