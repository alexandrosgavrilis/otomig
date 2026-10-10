/**
 * OTOMIG — every tunable number in the game.
 *
 * Rule from the spec: no magic numbers anywhere else. If a value might ever be
 * argued about, it belongs here.
 *
 * Values marked [spec] come straight from the design spec. Values marked
 * [research] were pinned down in Phase 0 — see RESEARCH.md for the source.
 * Four figures are disputed and waiting on Alex; they are marked [C1]..[C4]
 * and are set to the SPEC value, not the suggested one, until he decides.
 */

// ─── Region and import ────────────────────────────────────────────────────────

export const REGION = {
  /** Region square side length, km. The new-game slider range. [spec] */
  SIZE_KM_MIN: 5,
  SIZE_KM_MAX: 15,
  SIZE_KM_DEFAULT: 10,

  /** Overpass is queried as CHUNKS×CHUNKS tiles and merged. [spec] */
  OVERPASS_CHUNKS: 3,
  /** Retry backoff for HTTP 429/504, ms. Doubles each attempt. [spec] */
  OVERPASS_RETRY_MS: 2000,
  OVERPASS_RETRY_MAX: 4,
  OVERPASS_ENDPOINT: 'https://overpass-api.de/api/interpreter',
  /**
   * Abort a chunk that never answers. `fetch` has no timeout of its own, so a
   * silently-dropped connection would hang the import forever behind a frozen
   * progress bar. An aborted chunk is retried like any other failure.
   */
  OVERPASS_TIMEOUT_MS: 180000,
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

  /** Passengers per spawned dot. One dot = 10 passengers. [spec] */
  PASSENGERS_PER_DOT: 10,

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
};

// ─── Economy ──────────────────────────────────────────────────────────────────

/** All costs in euros. [spec] */
export const COSTS = {
  /** Track per km by mode and structure. */
  TRACK_PER_KM: {
    tram:  { onStreet: 15e6, atGrade: 25e6, tunnel: 100e6, bridge: 50e6 },
    metro: { atGrade: 30e6, tunnel: 120e6, bridge: 60e6 },
    train: { atGrade: 15e6, tunnel: 80e6, bridge: 40e6 },
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
 * [C4] Research flags these terms as longer than the game's own horizon: one
 * in-game year is ~1 real hour, so the Large loan is 20 real hours of play and
 * can never be repaid in a session. Suggested instead: 3/6/12 years at
 * 4/6/9%. Spec values kept until Alex decides. [spec]
 */
export const LOANS = [
  { slot: 'small',  fraction: 0.2, interest: 0.03, termYears: 5 },
  { slot: 'medium', fraction: 0.5, interest: 0.05, termYears: 10 },
  { slot: 'large',  fraction: 1.0, interest: 0.08, termYears: 20 },
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
  roadMajor: '#DCD6CC',
  roadMinor: '#E8E3DA',
  contour: '#D8D0C2',
  contourMajor: '#C9BFAE',

  stopFill: '#FFFFFF',
  stopStroke: '#2B2B2B',
  passenger: '#2B2B2B',
  bareTrack: '#B5AFA4',

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
