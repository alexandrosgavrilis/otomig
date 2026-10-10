# Transit Sandbox ("OTOMIG") — Build Prompt & Design Spec

Oct 9, 2026 · @Alex

## How to use this prompt

You are building a browser game from this spec, one phase per session. Alex pastes this document into each new session.

- **Where you work.** Work in VsCode. At the end of every session, and you can push stuff to Alex's github (https://github.com/alexandrosgavrilis). You need to make sure that's where git authenticates first. Https works.
- **One phase per session.** Phase 0 (research) may share a session with Phase 1 if context allows. Stop when the phase's acceptance criteria are met.
- **HANDOFF.md.** Keep this file in the project root: current phase, what works, known bugs, decisions you made where the spec was silent, and next steps. Read it first in every session and update it last. It replaces re-explaining.
- **Network limits.** Your sandbox can reach npm and GitHub, but not Overpass, the elevation tiles or OSM tiles. You cannot load a real region. Ship a small synthetic fixture (`fixtures/test-region.json`) shaped exactly like real imported data, and test your logic against it. Alex tests with live data.
- **Simplicity beats completeness.** If a rule here is hard to implement, build a simpler version, note it in HANDOFF.md and move on. Ask Alex only when a choice changes gameplay.
- **One config file.** Every tunable number lives in `config.js`. No magic numbers anywhere else.

## Concept

A transit sandbox with Mini Metro's look and drawing feel and Cities: Skylines' public-transport management, set on a real 15×15 km piece of the world from OpenStreetMap. The player draws bus, tram, metro and train lines. Passengers (dots) appear where people live and want to go. Money comes from tickets, coverage subsidies and advertising.

There is no win condition. A good network settles into balance. Some places can only ever support a bus line or two, and that is fine: the game will never suit every region, just like real transport.

Design principles:

- **Simple code first.** Readable, maintainable plain JavaScript; few files, each with one clear job; comments where the logic is not obvious.
- **Plausible, not accurate.** Real data and rough real-world costs, fed into deliberately simple models.
- **The player draws, the game engineers.** Road routing, track smoothing, tunnels and bridges are automatic.
- **Calm pace.** No sudden game over. Failure is slow and visible: passengers giving up, ridership falling, debt growing.
- **Headline numbers.** Passengers transported (in thousands) and passengers currently on the network or on a line.

## Tech stack and structure

Decision: a pure browser app with no backend and no build step, served locally with `python3 -m http.server`. One language, nothing to install, and it can later live on any static host (GitHub Pages included).

- **Language.** Plain JavaScript ES modules with JSDoc type comments. No TypeScript, bundler or framework.
- **Base map.** MapLibre GL JS, vendored into `vendor/` with `npm pack` at a pinned version. It renders only our own imported GeoJSON, so no external tiles are needed in-game and the map works offline after import.
- **Game layer.** One Canvas 2D overlay synced to MapLibre's move/render events (positions via `map.project`) draws lines, stops, vehicles and passengers. Custom line patterns are far easier here than in MapLibre styles.
- **Import.** Overpass parsing, building processing and elevation decoding run in a Web Worker so the UI never freezes.
- **Simulation.** Main thread, fixed timestep. Move it to a worker only if profiling demands it.
- **Storage.** IndexedDB caches imported regions and autosaves. Save/load also works as a JSON file download and upload.
- **Region selection screen only.** Standard OSM raster tiles plus Nominatim place search, following both usage policies: visible attribution, search on Enter (no autocomplete), at most one request per second.

Suggested layout (simplify if you can):

```
transit-game/
  index.html  style.css  config.js  main.js
  data/      overpass.js  terrain.js  import.worker.js  cache.js
  model/     region.js (grid, buildings, road graph)  network.js (stops, lines, tracks)  save.js
  build/     road-routing.js  track-geometry.js (spline, grade profile, structures)
  sim/       clock.js  demand.js  routing.js  vehicles.js  passengers.js  economy.js
  render/    basemap.js  overlay.js  shapes.js
  ui/        hud.js  toolbar.js  panels.js  new-game.js
  vendor/    maplibre-gl.js  maplibre-gl.css
  fixtures/  test-region.json
  HANDOFF.md  README.md
```

## Region and data

The playable area is a square of up to 15×15 km. Everything is fetched once, processed in the import worker, stored in IndexedDB and never fetched again.

New-game flow: search a place or pan the map → place the square (size slider 5–15 km) → pick a seasonal profile → pick a difficulty → Import (progress bar per step) → play.

| Data | Source | Kept as |
| --- | --- | --- |
| Roads | Overpass: `highway=*` from motorway down to residential, plus `pedestrian`; keep `tunnel` and `bridge` tags | Road graph: nodes, edges with class, length, tunnel/bridge flag |
| Buildings | Overpass: `building=*` with `building:levels`, plus shop/office/amenity/tourism tags on or inside them | Per building: centroid, footprint area, levels, category. Footprints are also rasterised into a 10 m occupancy grid (one bit per cell) for track collision checks; the polygons themselves are discarded after import |
| Lakes and rivers | Overpass: `natural=water` polygons | Polygons, for rendering and over-water checks |
| Sea | Elevation below 0 m (Terrarium includes bathymetry) | Sea mask from the height grid. This avoids building coastline polygons, which is notoriously fiddly |
| Existing rail | Overpass: `railway=rail` (skip abandoned, disused, razed), `railway=station` and `halt` | Pre-built track graph and station points (Phase 6) |
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), Terrarium PNG, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, zoom 12–13 | Height grid of about 30 m cells. Decode: metres = R×256 + G + B/256 − 32768. Attribution is required |
| Population total | OSM `population` tag on the place, or typed by the player; optional | One scaling factor |

Dense cities make big Overpass responses. Query the box as 3×3 chunks of about 5 km each, merge them, and retry a chunk with backoff on HTTP 429 or 504. No fallback for areas with poor building coverage: OSM is good enough, and imperfect regions are accepted.

### Population from buildings

- **Residents.** Residential buildings (house, apartments, residential, terrace, detached, and `building=yes` with no commercial tags) get footprint area × levels (default 2 when missing) ÷ 40 m² per resident. If a population total exists, scale all residents to match it.
- **Attraction** (where people want to go). Floor area of non-residential buildings × a category weight: shops and offices 1.0, schools and universities 1.5, hospitals 1.5, hotels 1.0, residential 0.2 (visiting). Standalone shop and amenity points add a small fixed amount each.
- **Demand grid.** 200 m cells, each holding a residents sum and an attraction sum. A 15 km box is 75×75 = 5,625 cells.

### Seasonal profiles

Exactly four profiles: Urban, Tourist, University Town, Countryside. Each is twelve monthly multipliers applied to all trip generation. Starting values below; tune freely.

```js
SEASON_PROFILES: {
  urban:       [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.9, 0.75, 1.0, 1.0, 1.0, 0.95],
  tourist:     [0.5, 0.5, 0.6, 0.8, 1.1, 1.6, 2.3, 2.5, 1.6, 0.9, 0.5, 0.5],
  university:  [1.0, 0.9, 1.0, 0.95, 1.0, 0.8, 0.5, 0.45, 0.9, 1.05, 1.05, 0.8],
  countryside: [0.9, 0.9, 0.95, 1.0, 1.0, 1.05, 1.15, 1.25, 1.0, 0.95, 0.9, 1.0],
}
```

## Visual design

Mini Metro drawn over a real map: flat colours, thick lines, simple shapes, no textures, almost no text.

### Base map

- **Palette.** Land off-white (`#F4F1EA`), water pale blue (`#BFD9E8`), major roads light warm grey (`#DCD6CC`, 2–4 px), minor roads fainter and shown only when zoomed in. Buildings are not drawn.
- **Terrain is visible.** The player avoids tunnels by reading the land, so draw faint contour lines every 20 m (slightly stronger every 100 m). Generate them at import with marching squares and store them as GeoJSON. Toggleable.
- **Demand heat map.** A toggle shows unserved demand per 200 m cell as a semi-transparent warm overlay (see Simulation).

**Optional real-map underlay.** Drawing the base map ourselves stays the default: the road, water and terrain data must be fetched anyway for routing and population, MapLibre draws it from a few style rules, it works offline, and it keeps the calm look. On top of that, add a toggle that shows the standard OSM raster tiles underneath the 15×15 km section, desaturated and faded (MapLibre `raster-saturation: -1`, opacity about 0.35), for anyone who wants to see real street detail. It needs internet, follows the OSM tile usage policy (attribution, no prefetching or bulk download), and is dropped without fuss if the tile server refuses requests from localhost.

### Lines

All lines are about 6 px wide at default zoom, in a colour the player can change (a palette of about 12 Mini Metro-like colours plus a custom picker). Lines sharing a road or track sit side by side, offset like in Mini Metro.

| Mode | Line pattern | Vehicle shape (both ends, since vehicles run both ways) |
| --- | --- | --- |
| Bus | Solid colour, nothing inside | Plain rectangle |
| Tram | Faint row of small dotted circles inside | Rectangle with both ends rounded |
| Metro | Faint row of small triangles inside | Rectangle with both ends pointed, like a pencil |
| Train | Faint row of small squares inside | Rectangle with a smaller square attached at both ends |

- **Tunnels.** Bus, tram and train sections in a tunnel are clearly darkened (colour mixed about 40% toward black). Buses only ever use existing road tunnels from OSM.
- **Metro is the inverse.** Underground is its normal colour; overground sections (at grade or on a bridge) are brightened about 40% toward white.
- **Bridges and viaducts.** Any mode: a thin dark outline along both edges of the line.
- **Bare track** (built but carrying no line): thin grey. Train track has small sleeper ticks; metro track is plain. Existing OSM rail is drawn like train track, slightly darker.

### Vehicles, stops and passengers

- **Vehicles** are drawn in their line's colour with a darker outline, rotated along the direction of travel, with a minimum on-screen size. Because both ends look alike, each vehicle carries a small light chevron arrow showing which way it is going. Load is shown as an inner fill that grows as the vehicle gets fuller.
- **Stops** are white circles with a dark outline. Metro and train stations are larger. An interchange is drawn as one outlined ring around the stops it joins.
- **Passengers** are small dark dots (one dot = 10 passengers) clustered beside their stop. Past 12 dots, show a "+N" count instead of more dots.
- **Waiting timer.** Like Mini Metro, a stop grows a thin circular timer ring once its oldest passenger has used half their patience.

## Building rules

The player picks a mode (Bus, Tram, Metro, Train) and a tool: New line, Extend line, Edit stops, Build track (metro and train only), Bulldoze. Clicking any game object (stop, line, vehicle) selects it and opens its panel instead of building.

### Bus lines

- **Click = stop.** A click places a stop snapped to the nearest drivable road within 50 m; farther away, the click is refused with a small shake. Clicking an existing stop of the same mode reuses it. Clicking the line's first stop closes a loop, as in Mini Metro.
- **Path.** Between consecutive stops, the shortest route along drivable roads (motorway down to residential; never service roads, tracks, footways, paths or cycleways). Ignore one-way rules in v1.
- **Shaping.** Dragging the line between two stops adds a via-point (not a stop) that forces a different road route.
- **Infrastructure.** Stops only. Road tunnels and bridges come from OSM tags and are drawn accordingly.

### Tram lines

- **Same clicks as buses**, but stops and paths stick to tram roads only: trunk, primary, secondary, tertiary (and their link roads) and pedestrian streets. Never residential roads, service roads, footways or paths.
- **On-street track** is built automatically with the line and is cheap per km. It follows the road, so no grade rule applies.
- **Off-road segments.** Dragging the line between two stops pulls that segment off the road into a smooth curve through the dragged point. It becomes dedicated track: more expensive, and subject to the grade rule (so it can get tunnels and bridges).

### Rail track (metro and train)

- **Two steps: build track, then draw lines on it.** Track types are metro track and train track. Metro vehicles run on both; train vehicles run only on train track (and existing OSM rail).
- **Waypoints, not stops.** In the Build track tool, clicks are waypoints that shape the track. The track is a smooth curve through them (centripetal Catmull-Rom, sampled every 20 m), never sharp corners. Enter or double-click finishes; Esc cancels. Clicking existing track of the same type makes a junction.
- **Live preview.** While drawing, the track is coloured by structure (at grade, tunnel, bridge), and a small strip shows the height profile and the running cost. Nothing is built until confirmed.
- **Drawing lines on track.** Clicks place stations, snapped to track within 40 m. Between stations the line takes the shortest path on compatible track. With no compatible path, the segment is refused with a short message.

### Grade rule: automatic tunnels and bridges

The player never chooses where tunnels or bridges go. The terrain decides; the player can only avoid them by drawing a better (usually longer) path. Maximum grades: tram 7%, metro 4.5%, train 2.5%.

1. Sample the terrain every 20 m along the path.
2. Set the desired track height. Tram and train: the terrain, but never lower than 8 m above any water surface (motorway and trunk crossings add their own target; see Rail and roads below). Metro: 15 m below the terrain, because a metro is underground by default.
3. Smooth the desired profile so no step exceeds the grade limit, staying as close as possible to the desired height. A forward and a backward slope-clamping pass, averaged and repeated until stable, is enough. Any simple method is fine; document it.
4. Classify each sample. Track 8 m or more below the terrain is a tunnel. Track 6 m or more above the terrain, or over water, is a bridge. Anything else is at grade (small cuttings and embankments are free).
5. Merge structure runs shorter than 60 m into their neighbours so the line does not flicker.

For a metro this means it stays underground until the land drops away beneath it, then surfaces (brightened) or crosses on a bridge. Stations simply take the structure at their position: underground, at grade or elevated, priced to match.

**Buildings block surface track.** Tram, metro and train track cannot pass through buildings in any overground section, whether at grade or on a bridge. Tunnels pass beneath them freely. Check each 20 m sample against the building occupancy grid. A blocked stretch shows red in the live preview with a short message, and the track or segment cannot be confirmed until the player reroutes it. Nothing is ever demolished. On-street tram track follows roads, so it never hits this rule.

**Rail and roads.** Train track and overground metro track may cross roads but never run along them. Roads that are themselves on a bridge or in a tunnel in OSM don't count, since the rail passes under or over them. Footways, paths and cycleways are ignored.

- **Crossing angle.** An at-grade crossing must meet the road at 45° or more. A shallower crossing shows red in the preview and can't be confirmed.
- **No running along roads.** If more than 40 m of continuous at-grade track lies inside a road's corridor, that stretch is blocked the same way. Corridor half-widths: motorway and trunk 12 m, primary and secondary 8 m, everything else 4 m.
- **Level crossings.** A valid at-grade crossing becomes a level crossing: €0.3M each, drawn as a small striped marker across the road. Buses and trams are not slowed, since traffic isn't modelled.
- **Motorways and trunk roads are never crossed at grade.** At those crossings the grade rule adds one more target: the track must be at least 7 m above or 8 m below the road, whichever is nearer to the smoothed profile. Smoothing then builds the ramps automatically, so the crossing becomes a short bridge or tunnel without the player choosing it.
- **Trams are exempt.** On-street tram track belongs on roads, and off-road tram segments may cross roads at grade at any angle, as real trams do.

### Stop editing and interchanges

- **Edit stops tool.** Drag a stop to move it (it re-snaps and routes recompute), delete a stop (its neighbours reconnect), or click a line segment to insert a stop. Stops are auto-named after the nearest OSM street name and can be renamed.
- **Interchanges.** Stops of any mode within 150 m of each other form one interchange. Passengers walk between them at 1.2 m/s.
- **Removal refund.** Bulldozing returns 50% of construction cost, for any mode.

### Vehicles

The player adds or removes vehicles per line with +/−. No extra carriages. Vehicles move at constant cruise speed with a fixed dwell at each stop; no acceleration modelling. Adding a vehicle spaces the vehicles running in the same direction evenly along the line. Cap vehicles so the headway never drops below 1 minute.

**Direction, the Mini Metro way.** There is no signalling and no collision: vehicles pass through each other freely, in either direction, on any shared road or track. On a line with two ends, vehicles shuttle back and forth and reverse at the terminals. On a loop (a line that closes on itself), each vehicle keeps its direction forever; when adding a vehicle to a loop the player picks clockwise or anticlockwise, so they can run vehicles both ways round.

| Mode | Capacity (passengers) | Cruise speed | Dwell per stop |
| --- | --- | --- | --- |
| Bus | 50 | 25 km/h | 20 s |
| Tram | 200 | 30 km/h | 20 s |
| Metro | 900 | 60 km/h | 30 s |
| Train | 500 | 90 km/h | 45 s |

Bus capacity is Alex's figure. The rest are starting values for the research phase to check.

### Existing OSM rail (Phase 6)

- **Discount.** If the region contains OSM railway lines, the player's own track maintenance is 25% cheaper, in every difficulty.
- **Ready-made track.** Existing rail is imported as train track with no construction cost. Its tunnels and bridges come from OSM tags, not the grade rule. The player can connect their own track to it and run train or metro lines on it, and never pay maintenance on it (only on their own track, at the 25% discount).
- **Intercity service.** A station on existing rail can toggle "Intercity service". Uncontrollable NPC intercity trains then call there periodically. Each call pays the player one ticket per passenger aboard, and drops some of those passengers into the network as new trips.
- **Fallback.** If this proves too complex, ship the discount and the ready-made track first, intercity calls last.

## Simulation

The simulation uses two clocks, Cities: Skylines style: vehicles and passengers move at true speeds on a sim clock, while the calendar runs fast and separately. Everything about movement and waiting uses sim time; money, seasons, loans and satisfaction recovery use calendar time.

### Two clocks

- **Sim clock.** At 1× speed, 1 real second = 20 sim seconds. Speeds: pause, 1×, 2×, 4×.
- **Calendar.** At 1×, one in-game day passes every 10 real seconds: a month is about 5 minutes, a year about an hour (15 minutes at 4×).
- **The bridge between them.** One calendar day therefore shows about 200 sim seconds of operation. Treat that as a true-rate sample of a typical moment in the day. Passengers spawn at their real average rate per sim second, and every count that feeds a daily total (tickets, advertising, passengers transported) is multiplied by S = 64,800 s of daily service (18 h) ÷ 200 sim seconds per day = 324. Live counts (passengers waiting or on board right now) are not scaled. All three numbers live in `config.js`; the research phase checks them against Cities: Skylines.

### Demand model

1. **Catchments.** Each grid cell within walking radius of a stop (400 m for bus and tram, 600 m for metro and train) belongs to its nearest stop.
2. **Trips produced** by stop s per day = residents in its catchment × 0.4 transit trips per resident × the month's seasonal multiplier.
3. **Where they go.** Stop s sends trips to stop t in proportion to attraction(t) × f(distance), divided by the same sum over every cell in the whole region, served or not. Trips toward unserved places are simply lost, so wider coverage directly raises ridership. Use f(d) = e^(−d / 3 km), and zero below 800 m (people walk).
4. **Filters.** Only stop pairs connected by the network spawn passengers. Each pair is further multiplied by its satisfaction (below) and by a fare factor (ticket-price multiplier ^ −0.3).
5. **Spawning.** Each pair accumulates expected passengers per sim second and spawns one dot each time it reaches 10. Recompute the pair table only when the network changes or the month changes, never per frame. Store it sparsely.

**Heat map.** Each cell's unserved demand = its residents plus attraction that fall outside every catchment, normalised for display. This is what shows the player where a stop would be useful.

### Passenger routing

- **Graph.** Nodes are (stop, line) platforms. Edges: riding (travel time including dwells), boarding (expected wait = half the headway), and transferring (walk time within an interchange plus a 5-minute penalty).
- **Routes.** Dijkstra from each origin stop, cached and recomputed only when the network changes. A route is a list of legs: line, direction, boarding stop, alighting stop. On a loop served both ways, the direction is whichever reaches the alighting stop sooner.
- **Movement.** A dot waits at its boarding stop and boards the first vehicle of its line heading toward its alighting stop that has room (first come, first served). At a transfer it walks to the next stop and waits again. At its final stop it disappears and counts as transported.
- **Tickets.** One ticket per trip, charged at first boarding; transfers are free. Advertising pays a tiny amount per trip.

### Waiting and satisfaction

- **Patience.** A passenger waits at most 15 sim minutes per stop (Easy 20, Hard 12). A full vehicle does not reset the timer.
- **Giving up.** Past that, the dot disappears. If it was still on its first leg, its ticket is never paid. The satisfaction of that stop pair drops by 0.15 (floor 0.2).
- **Recovery.** Satisfaction climbs back by 0.02 per calendar day toward 1.0. Fewer passengers spawn for that pair meanwhile, so ridership on that route visibly dips for a while, even where demand is high.

## Economy and difficulty

Money flows in from tickets, advertising and coverage subsidies, and out through construction, vehicle purchases, running costs, maintenance and loan repayments. Running costs and maintenance accrue per calendar day; the finance panel reports per month.

### Costs (approximate starting values)

Track figures exclude stations. They are rounded from public European reporting: German tram projects averaged about $36M per mile ([Eno](https://enotrans.org/?p=9383)); tunnelled metro runs roughly $180–270M per km ([Transit Costs Project](https://transitcosts.com/?p=7602)). The research phase may adjust them.

| Item | Bus | Tram | Metro | Train |
| --- | --- | --- | --- | --- |
| Track per km, at grade | — | €15M on-street, €25M off-road | €30M | €15M |
| Track per km, tunnel | — (road tunnels only) | €100M | €120M | €80M |
| Track per km, bridge | — | €50M | €60M | €40M |
| Stop or station | €20k | €0.5M | €50M underground, €5M at grade, €15M elevated | €5M (×3 if tunnel or elevated) |
| Vehicle purchase | €400k | €4.5M | €10M | €10M |
| Running cost per vehicle per year | €250k | €600k | €2M | €2.5M |

- **Vehicle prices.** A 12 m electric bus is about €500–550k and a diesel about €300k, so €400k is a blend ([marqstats](https://marqstats.com/reports/europe-electric-bus-market/)). Recent tram orders work out near €5M each ([railwaynews](https://railwaynews.net/gvb-launches-e391-million-new-tram-procurement-amsterdam.html)). Bucharest paid about €100M for 13 six-car metro trains carrying 1,200 people each ([Alstom](https://www.alstom.com/press-releases-news/2020/11/alstom-provide-new-metropolis-trains-bucharest-metro-line-5)). The train price is an unsourced estimate.
- **Maintenance.** Track and stations cost 1.5% of their construction cost per year. If the region has OSM railway lines, the player's rail maintenance is 25% cheaper in every difficulty.
- **Refunds.** Bulldozing or selling returns 50%.

### Income

- **Tickets.** Flat fare of €1.50 per trip (transfers free). A global ticket-price slider runs from 0.5× to 2× and scales demand by multiplier ^ −0.3.
- **Advertising.** €0.02 per trip, always paid, including by fare evaders.
- **Subsidies, modelled on Greek lifeline ferry support.** The state covers a share of running costs, scaled by coverage: monthly subsidy = running costs × difficulty share × (residents within any stop's walking radius ÷ all residents). It counts buildings, not demand or ridership, so serving a quiet village pays the same as serving a busy street. It never covers construction or loans, and can never exceed running costs.

### Difficulty

|  | Creative | Easy | Normal (Medium) | Hard (Realistic) |
| --- | --- | --- | --- | --- |
| Starting capital | Unlimited | €2,000 per resident, min €20M | €500 per resident, min €5M | €100 per resident, min €1M |
| Subsidy share of running costs | — | 90% | 70% | 50% |
| Fare evasion | 0% | 0% | 0% | 1.6% pay no ticket |
| Passenger patience | 20 min | 20 min | 15 min | 12 min |
| Negative balance | — | Can't build or buy until positive | Can't build or buy until positive | Same, and game over after 12 consecutive months below zero |

Hard is meant to be tight: on a small island it may support one or two bus lines in winter, and that is intended.

### Loans

Three loan slots, available in every difficulty except Creative, and most needed in Hard. Each repays automatically in fixed monthly instalments and can be repaid early at any time.

| Slot | Size | Interest per year | Term |
| --- | --- | --- | --- |
| Small | 20% of starting capital | 3% | 5 years |
| Medium | 50% of starting capital | 5% | 10 years |
| Large | 100% of starting capital | 8% | 20 years |

## UI and HUD

The map fills the screen; everything else is a thin bar or a small panel, in the same flat Mini Metro style.

- **Top bar.** Balance (red when negative, with the Hard game-over countdown), date and month, speed controls (pause, 1×, 2×, 4×), passengers transported (cumulative, in thousands), passengers on the network right now, and last month's net result.
- **Left toolbar.** Mode buttons whose icons are the vehicle shapes, then the tools (New line, Extend line, Edit stops, Build track, Bulldoze), then toggles for the heat map, contour lines and the OSM underlay.
- **Right panel** (contextual). Line: colour, vehicles +/−, length, stops, riders now, riders per day, delete. Stop: name, passengers waiting, lines served, residents in catchment. Finances: monthly income and expenses by category. Loans: the three slots.
- **Drawing feedback.** A cost preview follows the cursor while building. Rail drawing adds the height-profile strip described under Building rules.
- **Keyboard.** 1–4 select modes, Space pauses, Esc cancels, Delete removes the selection.
- **Saving.** Save slots in IndexedDB, autosave every in-game month, and export or import a save as a JSON file.
- **Attribution.** A small footer: © OpenStreetMap contributors (ODbL), plus the terrain tiles credit.
- **Strings.** All UI text in one object, so translation is easy later.

## Build plan

Seven phases, each ending in something Alex can open and play. Do not start a phase until the previous one meets its acceptance criteria.

0. **Research.** Study how Mini Metro and Cities: Skylines (1 and 2) handle public transport, using legal public sources only: official and community wikis, developer blogs and dev diaries, conference talks, patch notes, reviews. No decompiled code, no extracted assets. Also verify the data endpoints and their usage policies, and the cost figures in this spec.
   - Output `RESEARCH.md`, about two pages: mechanics worth borrowing (line drawing and editing feel, loops, vehicle spacing, boarding rules, crowding feedback, Skylines' time model, budgets and loans), suggested `config.js` values with reasons, and anything that conflicts with this spec.
   - Flag conflicts for Alex; never apply them silently. Every claim links its source.
1. **Region and map.** New-game screen, region import (roads, buildings, lakes, sea mask, elevation, contours), IndexedDB cache, fixture region, base map rendering, pan and zoom.
   - Accept when: a dense 15×15 km city imports in Alex's browser in about two minutes or less, reloads instantly from cache, and looks like a calm Mini Metro map.
2. **Buses and passengers (the core loop).** Bus lines and stops, vehicles, the demand grid and heat map, passenger spawning, routing with transfers, patience and satisfaction, tickets and running costs, HUD, speed controls, save and load.
   - Accept when: two bus lines sharing an interchange carry passengers who transfer and arrive; neglected stops lose passengers and ridership dips; money moves; a reload restores the game exactly.
3. **Trams.** Tram-road snapping, on-street track, off-road dragging, the grade rule for off-road segments, tram visuals.
   - Accept when: a tram line follows only allowed roads, a dragged segment leaves the road at a higher price, and a steep off-road segment gets a tunnel by itself.
4. **Rail.** Track building with smooth splines, the full grade rule with tunnels and bridges, metro and train lines, stations, track compatibility, the profile strip.
   - Accept when: metro track stays underground on flat land and surfaces brightened across a valley; train track on hilly ground produces tunnels and bridges; a metro line runs on train track but a train line is refused on metro track.
5. **Full economy.** Seasonal profiles, coverage subsidies, loans, all four difficulty levels, Hard game over, fare slider, finance panel.
   - Accept when: a Tourist region visibly swells in August; Hard on a small island supports a bus line or two and little more; Creative never limits money.
6. **Existing OSM rail.** Maintenance discount, ready-made track, connecting to it, intercity service at stations.
   - Accept when: a region with real railways shows them as usable track, lines run on them, and intercity calls pay out.

After Phase 6, polish only: side-by-side offsets for shared segments if not done yet, performance, small UX fixes.

## Open points and out of scope

Six rules above are interpretations of Alex's wishes. Alex: confirm or correct these before Phase 1.

- [x] **Metro depth.** A metro is underground by default and surfaces only where the terrain forces it.
- [x] **Intercity payment.** Each intercity call pays the player one ticket per passenger aboard.
- [x] **Hard game over.** Triggered by 12 consecutive months with a negative balance, not by 12 months of operating losses.
- [x] **Existing rail maintenance.** No construction cost and no maintenance cost for the player, ever.
- [x] **Subsidy formula.** A share of running costs, scaled by the fraction of residents covered.
- [x] **Time scale.** 20 sim seconds per real second; one calendar day per 10 real seconds.

Out of scope for now: rush hours and day/night, extra carriages, one-way roads, road traffic and congestion, city growth, depots, vehicle ageing and breakdowns, minimum curve radius, sound, mobile layouts, multiplayer. Ferries would suit the island and lifeline-subsidy idea well and are the most natural fifth mode later.
