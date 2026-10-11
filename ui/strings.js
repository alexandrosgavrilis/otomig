/**
 * Every piece of UI text, in one object, so translation is a matter of copying
 * this file. Nothing else in the codebase should contain a user-facing string.
 */

export const STRINGS = {
  title: 'OTOMIG',

  seasons: {
    urban: 'Urban',
    tourist: 'Tourist',
    university: 'University Town',
    countryside: 'Countryside',
  },

  difficultyHints: {
    creative: 'Unlimited money. A sketchpad with no pressure.',
    easy: 'Generous capital and a 90% subsidy. Hard to go wrong.',
    normal: 'Real constraints, room to recover.',
    hard: 'Tight. A small island may support one bus line, and that is the point.',
  },

  newGame: {
    subtitle: 'Pick a piece of the world, up to 15 km across.',
    search: 'Find a place',
    searchPlaceholder: 'Town or city name',
    searchButton: 'Search',
    searchHint: 'Press Enter to search. Then pan and zoom to place the square.',
    searching: 'Searching…',
    noResults: 'Nothing found.',
    searchFailed: 'Search unavailable. Pan the map instead.',

    size: 'Region size',
    season: 'Seasonal profile',
    difficulty: 'Difficulty',

    importButton: 'Import region',
    starting: 'Starting import…',
    saving: 'Saving to cache…',
    loadedFromCache: 'Loaded from cache.',
    importFailed: 'Import failed:',
    unnamed: 'Unnamed region',

    fixtureButton: 'Use the test region',
    fixtureHint: 'A synthetic region that needs no network. Good for a quick look.',
    loadingFixture: 'Loading test region…',
    loadedFixture: 'Test region loaded.',
    fixtureFailed: 'Could not load the test region:',

    cached: 'Already imported',
  },

  hud: {
    balance: 'Balance',
    transported: 'Transported',
    onNetwork: 'On the network',
    lastMonth: 'Last month',
    paused: 'Paused',
    thousands: 'k',
    monthsLeft: 'months left',
  },

  panel: {
    line: 'line',
    stop: 'Stop',
    finances: 'Finances',
    vehicles: 'Vehicles',
    vehicleCost: 'Each',
    headway: 'Headway',
    headwayCapped: 'Any more and vehicles would run less than a minute apart.',
    length: 'Length',
    stops: 'Stops',
    loop: 'loop',
    ridersNow: 'Riders now',
    ridersPerDay: 'Riders per day',
    deleteLine: 'Delete line',
    deleteStop: 'Delete stop',
    waiting: 'Waiting',
    longestWait: 'Longest wait',
    residents: 'Residents in catchment',
    interchange: 'Interchange',
    noLines: 'No lines call here yet.',
    yes: 'Yes',
    no: 'No',
  },

  finance: {
    tickets: 'Tickets',
    advertising: 'Advertising',
    subsidy: 'Coverage subsidy',
    running: 'Running costs',
    maintenance: 'Maintenance',
    construction: 'Construction',
    net: 'Net this month',
    lastMonth: 'Last month',
    coverage: 'Residents covered',
    difficulty: 'Difficulty',
  },

  saves: {
    title: 'Save and load',
    save: 'Save',
    load: 'Load',
    export: 'Export file',
    import: 'Import file',
    autosave: 'Autosave',
    saved: 'Saved.',
    loaded: 'Loaded.',
    noSave: 'Nothing saved in that slot.',
    regionMissing: 'That save needs a region this browser has not imported.',
    badFile: 'That file is not an OTOMIG save.',
    badVersion: 'That save was made by a different version.',
  },

  toolbar: {
    bus: 'Bus',
    tram: 'Tram',
    metro: 'Metro',
    train: 'Train',
    newLine: 'New line',
    extendLine: 'Extend line',
    editStops: 'Edit stops',
    buildTrack: 'Build track',
    bulldoze: 'Bulldoze',
    heatMap: 'Demand',
    buildings: 'Buildings',
    contours: 'Contours',
    underlay: 'Real map',
    finances: 'Finances',
  },

  region: {
    residents: 'Residents',
    area: 'Area',
    roads: 'Roads',
    hasRail: 'Existing railway',
    noRail: 'No existing railway',
  },

  gameOver: {
    title: 'The network could not pay its way.',
    body: 'Twelve months in the red. Hard is meant to be tight — on a small '
      + 'region a bus line or two may be all it can ever support.',
    again: 'Start again',
  },

  errors: {
    tooFarFromRoad: 'Too far from a road.',
    cannotAfford: 'Not enough money.',
    noRoadPath: 'No road route between those stops.',
    alreadyOnLine: 'That stop is already on this line.',
    lineIsLoop: 'This line is a closed loop.',
    noDraft: 'Start a line first.',
    pickALine: 'Click a stop on the line you want to extend.',
    nothingThere: 'Nothing to remove there.',
    noTrackPath: 'No connected track between those stations.',
    blockedByBuilding: 'Buildings in the way.',
    crossingTooShallow: 'Crossing the road too shallowly.',
    alongRoad: 'Track cannot run along a road.',
    negativeBalance: 'Not while the balance is negative.',
    tooSteep: 'Too steep between those stops, even with a tunnel.',
  },

  build: {
    trackBuilt: 'Track built —',
    onStreet: 'on street',
    atGrade: 'at grade',
    tunnel: 'tunnel',
    bridge: 'bridge',
  },
};
