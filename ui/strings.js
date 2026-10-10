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
    contours: 'Contours',
    underlay: 'Real map',
  },

  region: {
    residents: 'Residents',
    area: 'Area',
    roads: 'Roads',
    hasRail: 'Existing railway',
    noRail: 'No existing railway',
  },

  errors: {
    tooFarFromRoad: 'Too far from a road.',
    noTrackPath: 'No connected track between those stations.',
    blockedByBuilding: 'Buildings in the way.',
    crossingTooShallow: 'Crossing the road too shallowly.',
    alongRoad: 'Track cannot run along a road.',
    negativeBalance: 'Not while the balance is negative.',
  },
};
