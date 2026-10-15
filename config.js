/**
 * OTOMIG — every tunable number in the game.
 *
 * Rule from the spec: no magic numbers anywhere else. If a value might ever be
 * argued about, it belongs here.
 *
 * Values marked [spec] come straight from the design spec. Values marked
 * [research] were pinned down in Phase 0 — see RESEARCH.md for the source.
 *
 * Four figures were disputed and are now resolved by Alex (Oct 10, 2026);
 * they are marked [C1]..[C4] at the value they were settled on. One further
 * value departs from the spec deliberately — `passengersPerDot` — and says so
 * where it is defined. Everything else matches the spec as written.
 */

// ─── Region and import ────────────────────────────────────────────────────────

export const REGION = {
  /** Region square side length, km. The new-game slider range. [spec] */
  SIZE_KM_MIN: 5,
  SIZE_KM_MAX: 15,
  /**
   * Default box side, km. Lowered from 10 after measuring the real cost of an
   * import: central Athens runs about 1.87 MB/km², so a 15 km box is 200–400 MB
   * and 10–20 minutes while a 6 km box is a few tens of MB and a few minutes.
   * The slider still reaches 15 km for anyone who wants it.
   */
  SIZE_KM_DEFAULT: 6,

  /**
   * Overpass is queried as a grid of tiles and merged. The grid is derived
   * from a target TILE SIZE rather than a fixed tile count, so chunk size
   * stays roughly constant whatever the region size.
   *
   * This matters because Overpass fails on area, not on region size. Measured
   * over central Athens: a 2 km box succeeds (7.5 MB, 18 s) while a 5 km box
   * returns 504 every time. With a fixed 3×3 grid a 15 km region would start
   * with 5 km chunks — all nine guaranteed to fail, each burning a full
   * 2+4+8+16 s retry cycle before subdividing, about four wasted minutes
   * before any real work. Deriving the count from a size that is known to
   * work avoids the whole pantomime.
   *
   * 2.5 km keeps a 6 km region at exactly 3×3 (unchanged), and takes a 15 km
   * region to 6×6 = 36 requests, which is inside Overpass's ~100/day
   * guidance for a regular user.
   */
  OVERPASS_CHUNK_TARGET_KM: 6,
  /** Cap on grid side, so one import can never fire hundreds of requests. */
  OVERPASS_CHUNKS_MAX: 8,
  /** Retry backoff for HTTP 429/504, ms. Doubles each attempt. [spec] */
  OVERPASS_RETRY_MS: 2000,
  OVERPASS_RETRY_MAX: 4,

  /**
   * How many times to re-send a query Overpass called *too heavy* (504, or a
   * 200 carrying a `remark`) before giving up so `fetchChunkAdaptive` can
   * subdivide the box instead.
   *
   * Deliberately much smaller than OVERPASS_RETRY_MAX. Re-sending an identical
   * too-big query mostly fails identically — asking for less is the only real
   * fix — but a 504 often is transient, so one retry is worth it. Measured: a
   * 10 km dense import cost 22 Overpass requests on the full ladder against an
   * ideal of 5.
   */
  OVERPASS_HEAVY_RETRY_MAX: 1,
  OVERPASS_ENDPOINT: 'https://overpass-api.de/api/interpreter',
  /**
   * Abort a chunk that never answers. `fetch` has no timeout of its own, so a
   * silently-dropped connection would hang the import forever behind a frozen
   * progress bar. An aborted chunk is retried like any other failure.
   */
  OVERPASS_TIMEOUT_MS: 180000,
  /**
   * How many times a chunk may be split when Overpass refuses it.
   *
   * Measured against the live API: a 5 km chunk of central Athens returns
   * HTTP 504 every time — the public instance simply will not build it — while
   * a 2 km box of the same place succeeds in 18 s and 7.5 MB. A fixed chunk
   * count therefore cannot serve both a dense city and a quiet island, so a
   * chunk that fails is split into four and retried. Three levels takes a
   * 5 km chunk down to 625 m, which is far below anything observed to fail.
   */
  OVERPASS_MAX_SUBDIVIDE: 3,
  /** Same, for an elevation tile. Tiles are small, so this is generous. */
  TERRAIN_TIMEOUT_MS: 30000,

  /**
   * Terrarium elevation tile zoom. [research]
   * z12 gives ~30 m cells at 38°N, ~24 m at 52°N, and needs only 3–5 tiles per
   * side for a 15 km box. z13 is false precision: the source data is ~30 m SRTM.
   */
  TERRAIN_ZOOM: 12,
  TERRAIN_TILE_URL: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  /** Terrarium decode: metres = R*256 + G + B/256 − TERRAIN_OFFSET. [spec] */
  TERRAIN_OFFSET: 32768,

  /** Height grid cell size, m. Resampled from the terrain tiles. [spec] */
  HEIGHT_CELL_M: 30,
  /** Building occupancy grid cell size, m — one bit per cell. [spec] */
  OCCUPANCY_CELL_M: 10,
  /** Demand grid cell size, m. A 15 km box is 75×75 = 5,625 cells. [spec] */
  DEMAND_CELL_M: 200,

  /** Contour line interval, m, and the stronger emphasised interval. [spec] */
  CONTOUR_INTERVAL_M: 20,
  CONTOUR_MAJOR_M: 100,

  /** Sea is anything below this height. Terrarium includes bathymetry. [spec] */
  SEA_LEVEL_M: 0,
  /**
   * Depth given to open sea that the elevation tiles report as exactly 0 m.
   *
   * Terrarium does NOT always include bathymetry. Measured at Kiato, on the
   * Gulf of Corinth: 10,327 of 27,889 cells — the whole gulf — are exactly
   * 0.000 m, so the sea read as land and the grade rule would have run train
   * track across it at grade. Ground at or below sea level that connects to
   * the edge of the region is open sea; it is lowered to this so that the
   * map, the grade rule and every other "is this sea?" test agree. Any depth
   * below zero would do; it is never drawn or priced.
   */
  FLAT_SEA_DEPTH_M: -1,
};

/** Nominatim place search, region-selection screen only. [research] */
export const NOMINATIM = {
  ENDPOINT: 'https://nominatim.openstreetmap.org/search',
  /** Policy maximum is 1 request/second. Never lower this. */
  MIN_INTERVAL_MS: 1000,
  /** Policy requires caching results our side to avoid repeat queries. */
  CACHE: true,
  /**
   * Policy forbids client-side autocomplete outright. Search fires on Enter.
   * This flag exists only to make the prohibition visible in code.
   */
  AUTOCOMPLETE: false,
};

/** Optional faded real-map underlay. [research] */
export const OSM_UNDERLAY = {
  TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  SATURATION: -1,
  OPACITY: 0.35,
  /** Prefetching is forbidden by the OSM tile usage policy. Keep false. */
  PREFETCH: false,
};

// ─── Population and demand ────────────────────────────────────────────────────

export const POPULATION = {
  /** Floor area per resident, m². [spec] */
  M2_PER_RESIDENT: 40,
  /** Assumed levels when `building:levels` is missing. [spec] */
  DEFAULT_LEVELS: 2,

  /** Attraction weight by building category. [spec] */
  ATTRACTION_WEIGHTS: {
    shop: 1.0,
    office: 1.0,
    school: 1.5,
    university: 1.5,
    hospital: 1.5,
    hotel: 1.0,
    residential: 0.2, // visiting
  },
  /** A standalone shop/amenity node with no building adds this much. [spec] */
  POINT_ATTRACTION: 50,

  /**
   * Which `amenity=*` nodes count as places people travel to.
   *
   * This is a CORRECTNESS filter, not a bandwidth one. Measured over a 1 km
   * box of central Athens: of 1,558 shop/amenity nodes, only 224 are dropped
   * — benches (34), waste baskets (43), recycling points (22), telephones,
   * ATMs, postboxes, parking entrances. That is just 2.9% of the import
   * payload, because the great majority of POI nodes in a city centre are
   * cafés, restaurants, shops and banks, which are all kept.
   *
   * The reason to do it is the demand model. Every POI node contributes
   * POINT_ATTRACTION, so before this filter a park bench generated as much
   * trip attraction as a bakery, and roughly 14% of all point attraction in
   * that sample was street furniture. In a suburb, where benches and parking
   * outnumber shops, the distortion is worse.
   *
   * Every shop is kept (a shop really is somewhere people go). Buildings are
   * unaffected — they come from `way[building]` with all their tags, so a
   * school building is still classified as a school whether or not `school`
   * appears here.
   */
  POI_AMENITIES: [
    // Education
    'school', 'university', 'college', 'kindergarten', 'library',
    // Health
    'hospital', 'clinic', 'doctors', 'dentist', 'pharmacy',
    // Food and drink — genuine all-day trip generators in a city
    'restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'food_court',
    // Civic and cultural
    'townhall', 'courthouse', 'post_office', 'police', 'community_centre',
    'place_of_worship', 'theatre', 'cinema', 'arts_centre', 'museum',
    'conference_centre', 'social_facility',
    // Money and markets
    'bank', 'marketplace',
  ],
};

export const DEMAND = {
  /** Transit trips produced per resident per day. [spec] */
  TRIPS_PER_RESIDENT: 0.4,

  /** Walking catchment radius by mode, m. [spec] */
  CATCHMENT_M: { bus: 400, tram: 400, metro: 600, train: 600 },

  /** Distance decay f(d) = e^(−d / DECAY_KM), zeroed below WALK_FLOOR_M. [spec] */
  DECAY_KM: 3,
  WALK_FLOOR_M: 800,

  /** Fare elasticity: demand scales by (price multiplier) ^ FARE_EXPONENT. [spec] */
  FARE_EXPONENT: -0.3,

  /**
   * How many real passengers one visible dot stands for.
   *
   * The spec fixes this at 10, which is right for a big city and wrong
   * everywhere else. The number of dots visible at any moment is
   *
   *   dots ≈ (trips per day × average journey length ÷ service hours) ÷ dot size
   *
   * so it falls with the square of a region's smallness: fewer residents make
   * fewer trips AND a smaller network captures a smaller share of them. At 10
   * passengers per dot a town of 40,000 shows about one or two dots at a time
   * and a village shows none at all — not because the model is wrong, but
   * because a village really does have about four people on its buses at any
   * moment, and four people is less than half a dot.
   *
   * So the dot size scales with the region: one dot = one passenger in towns,
   * rising to 50 in a metropolis where thousands would be unreadable. It is
   * fixed once at import and never changes during a game — a dot that
   * silently changed meaning while you played would make every count lie.
   *
   * [spec, amended — see HANDOFF.md]
   */
  RESIDENTS_PER_DOT_STEP: 100000,
  PASSENGERS_PER_DOT_MIN: 1,
  PASSENGERS_PER_DOT_MAX: 50,

  /** Walking speed between stops in an interchange, m/s. [spec] */
  WALK_SPEED_MS: 1.2,
  /** Stops within this distance form one interchange, m. [spec] */
  INTERCHANGE_M: 150,
};

/** Twelve monthly multipliers on all trip generation. [spec] */
export const SEASON_PROFILES = {
  urban:       [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.9, 0.75, 1.0, 1.0, 1.0, 0.95],
  tourist:     [0.5, 0.5, 0.6, 0.8, 1.1, 1.6, 2.3, 2.5, 1.6, 0.9, 0.5, 0.5],
  university:  [1.0, 0.9, 1.0, 0.95, 1.0, 0.8, 0.5, 0.45, 0.9, 1.05, 1.05, 0.8],
  countryside: [0.9, 0.9, 0.95, 1.0, 1.0, 1.05, 1.15, 1.25, 1.0, 0.95, 0.9, 1.0],
};

// ─── The two clocks ───────────────────────────────────────────────────────────

export const CLOCK = {
  /** Sim time per real second at 1×. [spec] */
  SIM_SECONDS_PER_REAL_SECOND: 20,
  /** Real seconds per in-game calendar day at 1×. [spec] */
  REAL_SECONDS_PER_DAY: 10,
  /** Available speed multipliers. 0 is pause. [spec] */
  SPEEDS: [0, 1, 2, 4],

  /** Hours of service represented by one calendar day. [spec] */
  SERVICE_HOURS_PER_DAY: 18,

  /**
   * The bridge between the clocks. One calendar day shows
   * SIM_SECONDS_PER_REAL_SECOND × REAL_SECONDS_PER_DAY = 200 sim seconds of
   * operation, treated as a true-rate sample of a typical moment. Daily totals
   * (tickets, advertising, passengers transported) multiply by:
   *   S = 18 h × 3600 ÷ 200 = 324
   * Live counts — waiting now, on board now — are never scaled. [spec]
   */
  get DAILY_SCALE() {
    const simSecondsPerDay = this.SIM_SECONDS_PER_REAL_SECOND * this.REAL_SECONDS_PER_DAY;
    return (this.SERVICE_HOURS_PER_DAY * 3600) / simSecondsPerDay;
  },

  /** Fixed simulation timestep, ms of real time. */
  TICK_MS: 50,
};

// ─── Vehicles ─────────────────────────────────────────────────────────────────

/**
 * Capacities are ~55–65% of real crush capacity across all four modes — a
 * comfortable load, applied consistently. Speeds are CRUISE speeds between
 * stops; dwell is modelled separately, so effective door-to-door speed works
 * out at 18.5 / 22.5 / 40 / 57.6 km/h, which matches real commercial speeds.
 * Verified in Phase 0 — see RESEARCH.md §3. [spec]
 */
export const MODES = {
  bus:   { capacity: 50,  cruiseKmh: 25, dwellS: 20 },
  tram:  { capacity: 200, cruiseKmh: 30, dwellS: 20 },
  metro: { capacity: 900, cruiseKmh: 60, dwellS: 30 },
  train: { capacity: 500, cruiseKmh: 90, dwellS: 45 },
};

export const VEHICLES = {
  /** Vehicles are capped so headway never drops below this, sim seconds. [spec] */
  MIN_HEADWAY_S: 60,
};

// ─── Building rules ───────────────────────────────────────────────────────────

export const BUILD = {
  /** Click-to-road snap distance for bus and tram stops, m. [spec] */
  STOP_SNAP_M: 50,
  /** Click-to-track snap distance for rail stations, m. [spec] */
  STATION_SNAP_M: 40,

  /** Road classes a bus may drive on. Never service/track/footway/path/cycleway. [spec] */
  BUS_ROADS: [
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
    'unclassified', 'residential', 'living_street',
  ],
  /** Road classes a tram may run on. No residential, service, footway or path. [spec] */
  TRAM_ROADS: [
    'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'pedestrian',
  ],

  /** Track is sampled every this many m for the grade rule. [spec] */
  SAMPLE_M: 20,
  /** Catmull-Rom alpha. 0.5 = centripetal, which never self-intersects. [spec] */
  SPLINE_ALPHA: 0.5,

  /**
   * Which track each rail mode's vehicles may run on. Metro vehicles run on
   * both kinds; train vehicles only on train track (and, from Phase 6,
   * existing OSM rail). [spec]
   */
  TRACK_COMPATIBILITY: { metro: ['metro', 'train'], train: ['train'] },

  /** Maximum grade by mode, as a fraction. [spec] */
  MAX_GRADE: { tram: 0.07, metro: 0.045, train: 0.025 },

  /** Metro's default depth below terrain, m — underground by default. [spec] */
  METRO_DEPTH_M: 15,
  /** Tram and train track stays at least this far above any water, m. [spec] */
  WATER_CLEARANCE_M: 8,

  /** Structure classification thresholds, m. [spec] */
  TUNNEL_BELOW_M: 8,  // track this far below terrain is a tunnel
  BRIDGE_ABOVE_M: 6,  // track this far above terrain (or over water) is a bridge
  /** Structure runs shorter than this are merged into neighbours, m. [spec] */
  MIN_STRUCTURE_RUN_M: 60,

  /**
   * How much of each end of an off-road segment is still treated as street
   * running, and so exempt from the "buildings block surface track" rule, m.
   *
   * Not in the spec. An off-road segment starts and ends at stops, which sit
   * on road centrelines, and Phase R measured that **23.7% of buildings in
   * central Athens come within 3 m of a road centreline in OSM itself** —
   * against a 26.9% same-source control, so it is OSM's own geometry rather
   * than any import artefact (RESEARCH_TILES.md §5.1). Without this, the first
   * and last samples of nearly every off-road segment in a real city would sit
   * inside a building and block track that visibly runs down the middle of a
   * street. The spec exempts on-street tram track from the rule; this makes
   * the exemption real at the point where the track leaves and rejoins the
   * street, rather than leaving it to luck.
   */
  OFF_ROAD_STREET_LEAD_M: 25,

  /** An at-grade rail/road crossing must meet the road at this angle or more, degrees. [spec] */
  MIN_CROSSING_ANGLE_DEG: 45,
  /** More than this much continuous at-grade track inside a road corridor is blocked, m. [spec] */
  MAX_ALONG_ROAD_M: 40,
  /** Road corridor half-widths by class, m. [spec] */
  ROAD_CORRIDOR_M: {
    motorway: 12, motorway_link: 12, trunk: 12, trunk_link: 12,
    primary: 8, primary_link: 8, secondary: 8, secondary_link: 8,
    default: 4,
  },
  /** Motorways and trunk roads are never crossed at grade: clearances, m. [spec] */
  MOTORWAY_CLEARANCE_ABOVE_M: 7,
  MOTORWAY_CLEARANCE_BELOW_M: 8,
  /** Road classes that are never crossed at grade. Links count as the road they serve. */
  GRADE_SEPARATED_ROADS: ['motorway', 'motorway_link', 'trunk', 'trunk_link'],

  /**
   * How close a Build track click must land to existing track to join it, m.
   *
   * Not in the spec, which says only that clicking existing track makes a
   * junction. Generous on purpose: a junction is the one click where missing
   * by a few metres silently produces a dead end that looks connected.
   */
  JUNCTION_SNAP_M: 30,
  /**
   * A waypoint closer than this to the previous one is ignored, m. A
   * double-click to finish fires two clicks on the same spot first, and two
   * coincident control points would put a kink in the spline.
   */
  WAYPOINT_MIN_M: 5,
};

// ─── Economy ──────────────────────────────────────────────────────────────────

/** All costs in euros. [spec] */
export const COSTS = {
  /**
   * Track per km by mode and structure.
   *
   * Tram on-street €15M/km is supported by German practice (recent light rail
   * track at £13–20M/km; an Essen at-grade line at about €17.8M/km) rather than
   * by the Eno figure the spec originally cited — Eno publishes no per-mode
   * costs at all. Citation corrected, number unchanged. [C1, resolved]
   *
   * Metro and train tunnel costs are SWAPPED relative to the spec: metro
   * €80M/km, train €120M/km. This fixes both problems at once. Heavy-rail
   * bores are larger and really do cost more per km than metro tunnels, so the
   * original ordering was backwards; and €80M/km keeps metro reachable instead
   * of a loan-only endgame. It sits below the efficient-European band
   * ($80–120M/km in Spain and France) — deliberately optimistic, for
   * playability. [C2, C3, resolved]
   */
  TRACK_PER_KM: {
    tram:  { onStreet: 15e6, atGrade: 25e6, tunnel: 100e6, bridge: 50e6 },
    metro: { atGrade: 30e6, tunnel: 80e6, bridge: 60e6 },
    train: { atGrade: 15e6, tunnel: 120e6, bridge: 40e6 },
  },

  /** Stop or station, by mode and structure. */
  STOP: {
    bus: 20e3,
    tram: 0.5e6,
    metro: { underground: 50e6, atGrade: 5e6, elevated: 15e6 },
    train: { atGrade: 5e6, tunnel: 15e6, elevated: 15e6 },
  },

  VEHICLE: { bus: 400e3, tram: 4.5e6, metro: 10e6, train: 10e6 },

  /** Running cost per vehicle per year. */
  RUNNING_PER_VEHICLE_YEAR: { bus: 250e3, tram: 600e3, metro: 2e6, train: 2.5e6 },

  /** Maintenance: this fraction of construction cost per year. [spec] */
  MAINTENANCE_RATE: 0.015,
  /** Rail maintenance discount when the region has OSM railways. [spec] */
  OSM_RAIL_DISCOUNT: 0.25,

  /** Bulldozing or selling returns this fraction. [spec] */
  REFUND_RATE: 0.5,

  /** A valid at-grade rail/road crossing becomes a level crossing. [spec] */
  LEVEL_CROSSING: 0.3e6,
};

export const INCOME = {
  /** Flat fare per trip. Transfers are free. [spec] */
  FARE: 1.5,
  /** Global ticket-price slider range. Demand scales by multiplier^-0.3. [spec] */
  FARE_MULTIPLIER_MIN: 0.5,
  FARE_MULTIPLIER_MAX: 2.0,
  /** Advertising per trip, always paid — including by fare evaders. [spec] */
  ADVERTISING_PER_TRIP: 0.02,
};

/**
 * Three loan slots, sized as a fraction of starting capital.
 *
 * Terms shortened from the spec's 5/10/20 years at 3/5/8%. One in-game year is
 * about one real hour, so a 20-year loan was 20 real hours of play — it could
 * never be repaid in any realistic session, and its interest compounded across
 * a span the player would never see the end of. At 3/6/12 years the Small loan
 * clears in roughly three hours and the Large one is a decision with a visible
 * end. Rates rise to keep the three slots meaningfully different risks.
 * [C4, resolved]
 */
export const LOANS = [
  { slot: 'small',  fraction: 0.2, interest: 0.04, termYears: 3 },
  { slot: 'medium', fraction: 0.5, interest: 0.06, termYears: 6 },
  { slot: 'large',  fraction: 1.0, interest: 0.09, termYears: 12 },
];

// ─── Difficulty ───────────────────────────────────────────────────────────────

/** [spec] */
export const DIFFICULTY = {
  creative: {
    label: 'Creative',
    unlimitedMoney: true,
    capitalPerResident: 0, capitalMin: 0,
    subsidyShare: 0,
    fareEvasion: 0,
    patienceSimMinutes: 20,
    blockBuildWhenNegative: false,
    gameOverMonths: null,
    loans: false,
  },
  easy: {
    label: 'Easy',
    unlimitedMoney: false,
    capitalPerResident: 2000, capitalMin: 20e6,
    subsidyShare: 0.9,
    fareEvasion: 0,
    patienceSimMinutes: 20,
    blockBuildWhenNegative: true,
    gameOverMonths: null,
    loans: true,
  },
  normal: {
    label: 'Normal',
    unlimitedMoney: false,
    capitalPerResident: 500, capitalMin: 5e6,
    subsidyShare: 0.7,
    fareEvasion: 0,
    patienceSimMinutes: 15,
    blockBuildWhenNegative: true,
    gameOverMonths: null,
    loans: true,
  },
  hard: {
    label: 'Hard',
    unlimitedMoney: false,
    capitalPerResident: 100, capitalMin: 1e6,
    subsidyShare: 0.5,
    fareEvasion: 0.016,
    patienceSimMinutes: 12,
    blockBuildWhenNegative: true,
    /** Game over after this many consecutive months with a negative balance. [spec] */
    gameOverMonths: 12,
    loans: true,
  },
};

// ─── Waiting and satisfaction ─────────────────────────────────────────────────

export const PATIENCE = {
  /**
   * Mini Metro gives a station a 2-second grace against its 45-second overcrowd
   * timer so a train that is almost there still counts. Borrowed and widened to
   * ~3% of a 15-minute patience, which is roughly the last 200 m of a bus's
   * approach: a dot will not give up if a boardable vehicle is this close.
   * My number, not a sourced one — tune in Phase 2. [research]
   */
  GRACE_SIM_S: 30,

  /** Satisfaction penalty when a dot gives up, and its floor. [spec] */
  GIVE_UP_PENALTY: 0.15,
  SATISFACTION_FLOOR: 0.2,
  /** Satisfaction recovery per calendar day, toward 1.0. [spec] */
  RECOVERY_PER_DAY: 0.02,
};

/** Passenger routing graph penalties. [spec] */
export const ROUTING = {
  /** Flat penalty added to every transfer, sim seconds. [spec] */
  TRANSFER_PENALTY_S: 300,
  /** Expected wait when boarding = this fraction of the headway. [spec] */
  BOARDING_WAIT_FRACTION: 0.5,
};

// ─── Existing OSM rail (Phase 6) ──────────────────────────────────────────────

export const INTERCITY = {
  /** Sim seconds between intercity calls at a station with the service on. */
  INTERVAL_SIM_S: 1800,
  /** Passengers aboard an arriving intercity train. */
  PASSENGERS_PER_CALL: 300,
  /** Fraction of those dropped into the network as new trips. */
  DROP_FRACTION: 0.3,
};

// ─── Visual design ────────────────────────────────────────────────────────────

export const COLORS = {
  land: '#F4F1EA',
  water: '#BFD9E8',
  /**
   * Roads are darker than the spec's #DCD6CC. At that value against #F4F1EA
   * land the contrast is a few percent of luminance — technically drawn,
   * effectively invisible, which rather defeats a game about buses following
   * real streets. Still flat and calm, just actually legible.
   */
  roadMajor: '#CAC2B2',
  roadMinor: '#DED7C9',

  /**
   * Buildings. The spec says not to draw them, but seeing the city you are
   * serving is the point of putting the game on a real map — and from Phase 4
   * the player needs to see what their track cannot cross.
   */
  building: '#E6E0D4',
  buildingStroke: '#D8D1C2',
  contour: '#D8D0C2',
  contourMajor: '#C9BFAE',

  stopFill: '#FFFFFF',
  stopStroke: '#2B2B2B',
  passenger: '#2B2B2B',
  bareTrack: '#B5AFA4',
  /** Train track's sleeper ticks, a shade darker than the rail itself. */
  sleeper: '#9C958A',
  /** Anything that cannot be built: a blocked preview, a refused crossing. */
  blocked: '#D14A3F',

  /**
   * Track being drawn is coloured by structure, before it belongs to any line
   * and so before it has a line colour of its own. [spec: "coloured by
   * structure"; the colours are mine]
   */
  structure: { atGrade: '#5B5F66', tunnel: '#8C8F95', bridge: '#2C7BD6' },
  /** The height-profile strip. */
  profileTerrain: '#E2DACB',
  profileTerrainEdge: '#B9AE9A',

  /** Heat map ramp for unserved demand, low to high. */
  heat: ['rgba(255,170,60,0)', 'rgba(255,140,40,0.35)', 'rgba(230,70,30,0.55)'],
};

/** Mini Metro-like line palette the player picks from. [spec] */
export const LINE_PALETTE = [
  '#E4463C', '#2C7BD6', '#3FA64B', '#F0A52E', '#8E54A8',
  '#19A6A6', '#D9478C', '#6B4F3A', '#5A6B8C', '#9BBF30',
  '#E0742E', '#3C3C3C',
];

export const RENDER = {
  /** Line width at default zoom, px. [spec] */
  LINE_WIDTH_PX: 6,
  /** Side-by-side offset for lines sharing a road or track, px. [spec] */
  LINE_OFFSET_PX: 7,
  /** Bare track width, px. [spec] */
  BARE_TRACK_PX: 2,

  /** Tunnels mix the line colour this far toward black. [spec] */
  TUNNEL_DARKEN: 0.4,
  /** Overground metro brightens this far toward white — the inverse. [spec] */
  METRO_SURFACE_LIGHTEN: 0.4,

  /** Stop radius by mode, px. Metro and train stations are larger. [spec] */
  STOP_RADIUS_PX: { bus: 4, tram: 5, metro: 7, train: 7 },
  /** Minimum on-screen vehicle length, px. [spec] */
  VEHICLE_MIN_PX: 8,

  /** Past this many passenger dots at a stop, show "+N" instead. [spec] */
  MAX_PASSENGER_DOTS: 12,
  /** The waiting ring appears once the oldest passenger has used this much patience. [spec] */
  WAIT_RING_AT: 0.5,

  /** Minor roads appear at this zoom and above. [spec] */
  MINOR_ROAD_MIN_ZOOM: 14,

  /** Spacing of the sleeper ticks on bare train track, px. */
  SLEEPER_SPACING_PX: 7,
  /** Height-profile strip size, CSS px. */
  PROFILE_WIDTH_PX: 520,
  PROFILE_HEIGHT_PX: 110,
};

// ─── Saving ───────────────────────────────────────────────────────────────────

export const SAVE = {
  DB_NAME: 'otomig',
  DB_VERSION: 1,
  /** Autosave every in-game month. [spec] */
  AUTOSAVE_MONTHLY: true,
  SAVE_SLOTS: 3,
};

// ─── Attribution ──────────────────────────────────────────────────────────────

/** Required, verbatim. Shown in the footer. [research] */
export const ATTRIBUTION = {
  osm: '© OpenStreetMap contributors (ODbL)',
  terrain:
    'Terrain Tiles by Mapzen/Tilezen — SRTM (NASA), 3DEP (USGS), ' +
    'GMTED2010 (USGS), ETOPO1 (NOAA), and other sources',
};

/** Pinned MapLibre version. v6 is ESM-only and breaks the no-build-step rule. [research] */
export const MAPLIBRE_VERSION = '5.24.0';

/**
 * How many tiles per side to split the **building** query into.
 *
 * Only buildings are chunked. Roads, rail, water and POI nodes come back in a
 * single request for the whole region, because the thing that made Overpass
 * refuse large boxes was the `>;` recursion over building geometry nodes, not
 * the box area (RESEARCH_TILES.md §3).
 *
 * The 6 km target is measured, not guessed: a 6 km box of central Athens
 * serves `way["building"]; out geom;` in 12.2 s on the first attempt, while a
 * 15 km box needs several retries. So the default 6 km region is one request
 * and the 15 km maximum is nine of 5 km. Overshooting is expensive — a chunk
 * Overpass refuses burns the full retry ladder before `fetchChunkAdaptive`
 * subdivides it.
 *
 * @param {number} sizeKm region side length
 * @returns {number} tiles per side; the import fires this squared requests
 */
export function buildingChunkCount(sizeKm) {
  const wanted = Math.ceil(sizeKm / REGION.OVERPASS_CHUNK_TARGET_KM);
  return Math.min(REGION.OVERPASS_CHUNKS_MAX, Math.max(1, wanted));
}

/**
 * Passengers represented by one dot, for a region of this many residents.
 *
 * Rounded to a whole number because a dot has to mean an integer of people for
 * the ticket maths to stay honest, and clamped so a village still shows its
 * handful of passengers and a metropolis does not drown in them.
 *
 * @param {number} residents
 * @returns {number}
 */
export function passengersPerDot(residents) {
  const raw = Math.round((residents || 0) / DEMAND.RESIDENTS_PER_DOT_STEP);
  return Math.min(DEMAND.PASSENGERS_PER_DOT_MAX,
    Math.max(DEMAND.PASSENGERS_PER_DOT_MIN, raw));
}
