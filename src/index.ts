interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Amtrak MCP — live Amtrak train tracking via the community Amtraker API
 * (api-v3.amtraker.com, a mirror of Amtrak's own track-a-train feed).
 *
 * Tools:
 * - amtrak_train_status: where is train N right now (GPS, speed, delay, next stop)
 * - amtrak_station_board: upcoming arrivals at a station (departures board)
 * - amtrak_routes_active: all currently active trains grouped by route
 * - amtrak_station_info: station lookup (name, code, address, inbound trains)
 *
 * Keyless. Positions update roughly every few minutes. The feed also carries
 * Via Rail (train numbers prefixed "v") and Brightline (prefixed "b") trains.
 *
 * Quirks learned from probing:
 * - /trains/{num} and /stations/{code} return `[]` with HTTP 200 when unknown.
 * - /trains is keyed by train number; each value is an ARRAY of active
 *   instances (trainID = "num-departureDayOfMonth", e.g. "6-14").
 * - Timestamps are ISO 8601 with local UTC offsets (e.g. 2026-07-15T15:28:00-06:00).
 * - `trainTimely` is empty in practice — timeliness is computed here from
 *   scheduled vs estimated times at the next station.
 * - For future stations, `arr`/`dep` hold ESTIMATED times; for past ones, actuals.
 * - `velocity` is mph; `lastValTS` is the last GPS fix time.
 */


const BASE_URL = 'https://api-v3.amtraker.com/v3';

const tools: McpToolExport['tools'] = [
  {
    name: 'amtrak_train_status',
    description:
      'Live Amtrak train status and GPS tracking — "where is my Amtrak train", "is train 6 late", "track the California Zephyr". Accepts a train number ("6", "2150") or route name ("Coast Starlight", "Empire Builder"). Returns each active instance of that train: current GPS position, speed, heading, timeliness, next station with ETA and delay minutes, and origin/destination scheduled vs actual times. Data is a community mirror of Amtrak\'s own tracking feed (api-v3.amtraker.com); positions update about every few minutes. Example: amtrak_train_status({ train: "6" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        train: {
          type: 'string',
          description:
            'Amtrak train number (e.g. "6", "91", "2150") or route name (e.g. "California Zephyr", "Acela", "Coast Starlight"). Via Rail ("v1") and Brightline ("b5151") trains in the same feed also work.',
        },
      },
      required: ['train'],
    },
  },
  {
    name: 'amtrak_station_board',
    description:
      'Amtrak station departures/arrivals board — upcoming trains at a station. "What trains are arriving at Chicago Union?", "next train at CHI", "station board for Denver". Accepts a 3-letter Amtrak station code ("CHI", "NYP", "LAX") or a station name ("Chicago", "Portland"). Returns trains currently en route to that station with route, scheduled vs estimated arrival, delay minutes, and status. Live community mirror of Amtrak tracking (api-v3.amtraker.com). Example: amtrak_station_board({ station: "CHI" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        station: {
          type: 'string',
          description: 'Amtrak station code (e.g. "CHI", "NYP", "SEA") or station/city name (e.g. "Chicago", "Denver")',
        },
        limit: { type: 'number', description: 'Max trains to return, 1-15 (default 15)' },
      },
      required: ['station'],
    },
  },
  {
    name: 'amtrak_routes_active',
    description:
      'Summary of ALL currently active Amtrak trains grouped by route — "how many Amtrak trains are running right now", "which Amtrak routes have delays", national system overview. Returns per route: active train count, train numbers, and the worst delay in minutes. Compact; live from a community mirror of Amtrak\'s tracking feed. Example: amtrak_routes_active({})',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'amtrak_station_info',
    description:
      'Amtrak station lookup by code or name — station name, 3-letter code, city/state, street address, timezone, coordinates, and how many trains are currently inbound. "Where is the Amtrak station in Denver?", "what is station code NYP". Example: amtrak_station_info({ station: "Denver" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        station: {
          type: 'string',
          description: 'Amtrak station code (e.g. "DEN", "NYP") or station/city name (e.g. "Denver", "New York")',
        },
      },
      required: ['station'],
    },
  },
];

// ---------------------------------------------------------------------------
// API types (fields verified live 2026-07-15)

interface TrainStop {
  name: string;
  code: string;
  tz: string;
  bus: boolean;
  schArr: string;
  schDep: string;
  arr: string; // actual (past stops) or estimated (future stops)
  dep: string;
  status: 'Departed' | 'Enroute' | 'Station' | string;
  platform?: string;
}

interface Train {
  routeName: string;
  trainNum: string;
  trainID: string; // "num-departureDayOfMonth", e.g. "6-14"
  lat: number;
  lon: number;
  heading: string; // N/NE/E/SE/S/SW/W/NW
  velocity: number; // mph
  trainState: 'Active' | 'Predeparture' | 'Completed' | string;
  trainTimely: string; // empty in practice
  statusMsg: string; // e.g. "SERVICE DISRUPTION"
  lastValTS: string; // last GPS fix
  origCode: string;
  origName: string;
  destCode: string;
  destName: string;
  provider: string; // Amtrak | Via | Brightline
  stations: TrainStop[];
  alerts?: unknown[];
}

interface Station {
  name?: string; // missing on a handful of entries (mostly bus-stop-only codes)
  code: string;
  tz: string;
  lat: number;
  lon: number;
  hasAddress?: boolean;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  trains: string[]; // trainIDs currently associated with this station
}

type TrainsMap = Record<string, Train[]>;
type StationsMap = Record<string, Station>;

// ---------------------------------------------------------------------------

async function amtraker<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(
        `Amtraker API error: HTTP ${res.status} on ${path}. The community mirror (api-v3.amtraker.com) may be briefly down — retry in a minute.`,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Amtraker API timed out after 10s (api-v3.amtraker.com). Retry in a minute.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Minutes between scheduled and actual/estimated ISO timestamps (positive = late). */
function delayMinutes(scheduled?: string, actual?: string): number | null {
  if (!scheduled || !actual) return null;
  const s = Date.parse(scheduled);
  const a = Date.parse(actual);
  if (Number.isNaN(s) || Number.isNaN(a)) return null;
  return Math.round((a - s) / 60_000);
}

function timelinessLabel(delay: number | null): string {
  if (delay === null) return 'unknown';
  if (delay <= -6) return `${-delay} min early`;
  if (delay <= 5) return 'on time';
  return `${delay} min late`;
}

/** First stop the train hasn't departed yet — its next station. */
function nextStop(train: Train): TrainStop | undefined {
  return train.stations.find((s) => s.status !== 'Departed');
}

/** Delay of a train at its next station (the "current" delay). */
function currentDelay(train: Train): number | null {
  const next = nextStop(train);
  if (!next) return null;
  return delayMinutes(next.schArr || next.schDep, next.arr || next.dep);
}

function shapeInstance(t: Train) {
  const next = nextStop(t);
  const first = t.stations[0];
  const last = t.stations[t.stations.length - 1];
  const nextDelay = next ? delayMinutes(next.schArr || next.schDep, next.arr || next.dep) : null;
  const destDelay = last ? delayMinutes(last.schArr, last.arr) : null;
  return {
    train_id: t.trainID,
    train_num: t.trainNum,
    route_name: t.routeName,
    provider: t.provider,
    state: t.trainState,
    position: { lat: t.lat, lon: t.lon },
    speed_mph: Math.round(t.velocity * 10) / 10,
    heading: t.heading,
    timeliness: timelinessLabel(nextDelay),
    status_msg: t.statusMsg?.trim() || undefined,
    last_updated: t.lastValTS,
    origin: first
      ? {
          name: first.name,
          code: first.code,
          scheduled_departure: first.schDep,
          actual_departure: first.status === 'Departed' ? first.dep : null,
        }
      : { name: t.origName, code: t.origCode },
    destination: last
      ? {
          name: last.name,
          code: last.code,
          scheduled_arrival: last.schArr,
          estimated_arrival: last.arr,
          delay_minutes: destDelay,
        }
      : { name: t.destName, code: t.destCode },
    next_station: next
      ? {
          name: next.name,
          code: next.code,
          status: next.status,
          scheduled_arrival: next.schArr,
          estimated_arrival: next.arr,
          delay_minutes: nextDelay,
        }
      : null,
    stops_remaining: t.stations.filter((s) => s.status !== 'Departed').length,
  };
}

const MIRROR_NOTE =
  'Community mirror of Amtrak tracking (api-v3.amtraker.com); positions update ~every few minutes. Times are local to each station.';

// ---------------------------------------------------------------------------
// amtrak_train_status

async function trainStatus(args: Record<string, unknown>) {
  const query = String(args.train ?? args.train_number ?? args.route ?? '').trim();
  if (!query) {
    throw new Error('amtrak_train_status requires a train number or route name, e.g. { train: "6" } or { train: "Coast Starlight" }.');
  }

  let instances: Train[] = [];
  let matchedBy = '';

  // Train-number-shaped input ("6", "2150", also "v1"/"b5151" for Via/Brightline)
  if (/^[bv]?\d{1,5}$/i.test(query)) {
    const data = await amtraker<TrainsMap | Train[]>(`/trains/${encodeURIComponent(query.toLowerCase())}`);
    if (!Array.isArray(data)) {
      instances = Object.values(data).flat();
      matchedBy = 'train number';
    }
    // unknown numbers return [] with HTTP 200 — fall through to name matching
  }

  if (instances.length === 0) {
    const all = await amtraker<TrainsMap>('/trains');
    const q = query.toLowerCase();
    instances = Object.values(all)
      .flat()
      .filter((t) => t.routeName.toLowerCase().includes(q));
    matchedBy = 'route name';
    if (instances.length === 0) {
      const routes = [...new Set(Object.values(all).flat().map((t) => t.routeName))].sort();
      return {
        query,
        count: 0,
        instances: [],
        note: `No active train matches "${query}". It may not be running right now (Predeparture trains appear ~hours before departure). Active routes: ${routes.join(', ')}.`,
      };
    }
  }

  return {
    query,
    matched_by: matchedBy,
    count: instances.length,
    instances: instances.slice(0, 10).map(shapeInstance),
    note: MIRROR_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Station resolution (shared by station_board and station_info)

function stationLabel(s: Station): string {
  return s.name ?? s.city ?? s.code;
}

function resolveStation(stations: StationsMap, query: string): { station?: Station; alternates?: string[] } {
  const code = query.toUpperCase();
  if (stations[code]) return { station: stations[code] };
  const q = query.toLowerCase();
  const all = Object.values(stations);
  const scored = all
    .map((s) => {
      // A handful of entries (mostly bus stops) have no `name` field — fall back to city.
      const name = (s.name ?? s.city ?? '').toLowerCase();
      const city = (s.city ?? '').toLowerCase();
      let score = 0;
      if (name === q) score = 6;
      else if (name.startsWith(q)) score = 5;
      else if (name.includes(q)) score = 4;
      else if (city === q) score = 3;
      else if (city.startsWith(q)) score = 2;
      else if (city.includes(q)) score = 1;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.s.trains?.length ?? 0) - (a.s.trains?.length ?? 0) ||
        stationLabel(a.s).localeCompare(stationLabel(b.s)),
    );
  if (scored.length === 0) return {};
  return {
    station: scored[0].s,
    alternates: scored.slice(1, 6).map((x) => `${stationLabel(x.s)} (${x.s.code})`),
  };
}

// ---------------------------------------------------------------------------
// amtrak_station_board

async function stationBoard(args: Record<string, unknown>) {
  const query = String(args.station ?? args.code ?? '').trim();
  if (!query) {
    throw new Error('amtrak_station_board requires a station code or name, e.g. { station: "CHI" }.');
  }
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 15);

  const [stations, trains] = await Promise.all([
    amtraker<StationsMap>('/stations'),
    amtraker<TrainsMap>('/trains'),
  ]);

  const { station, alternates } = resolveStation(stations, query);
  if (!station) {
    throw new Error(
      `No Amtrak station matches "${query}". Use a 3-letter code (e.g. CHI, NYP, LAX) or a station/city name.`,
    );
  }

  const inbound: Array<Record<string, unknown> & { _eta: number }> = [];
  const staleCutoff = Date.now() - 60 * 60_000; // drop ghost instances whose ETA passed >1h ago
  for (const instances of Object.values(trains)) {
    for (const t of instances) {
      if (t.trainState === 'Completed') continue;
      const stop = t.stations.find((s) => s.code === station.code);
      if (!stop || stop.status === 'Departed') continue;
      const eta = Date.parse(stop.arr || stop.schArr || stop.schDep);
      if (!Number.isNaN(eta) && eta < staleCutoff) continue;
      const delay = delayMinutes(stop.schArr || stop.schDep, stop.arr || stop.dep);
      inbound.push({
        train_num: t.trainNum,
        train_id: t.trainID,
        route_name: t.routeName,
        provider: t.provider !== 'Amtrak' ? t.provider : undefined,
        origin: `${t.origName} (${t.origCode})`,
        destination: `${t.destName} (${t.destCode})`,
        scheduled_arrival: stop.schArr,
        estimated_arrival: stop.arr,
        delay_minutes: delay,
        timeliness: timelinessLabel(delay),
        train_status: t.trainState,
        _eta: Number.isNaN(eta) ? Number.MAX_SAFE_INTEGER : eta,
      });
    }
  }
  inbound.sort((a, b) => a._eta - b._eta);

  return {
    station: { name: stationLabel(station), code: station.code, city: station.city, state: station.state, tz: station.tz },
    similar_stations: alternates?.length ? alternates : undefined,
    inbound_count: inbound.length,
    trains: inbound.slice(0, limit).map(({ _eta, ...rest }) => rest),
    note: `Trains currently en route to ${stationLabel(station)}. ${MIRROR_NOTE}`,
  };
}

// ---------------------------------------------------------------------------
// amtrak_routes_active

async function routesActive() {
  const trains = await amtraker<TrainsMap>('/trains');
  const byRoute = new Map<string, { nums: string[]; worst: number | null; provider: string }>();
  let total = 0;
  for (const instances of Object.values(trains)) {
    for (const t of instances) {
      if (t.trainState === 'Completed') continue;
      total++;
      const entry = byRoute.get(t.routeName) ?? { nums: [], worst: null, provider: t.provider };
      entry.nums.push(t.trainNum);
      const delay = currentDelay(t);
      if (delay !== null && (entry.worst === null || delay > entry.worst)) entry.worst = delay;
      byRoute.set(t.routeName, entry);
    }
  }
  const routes = [...byRoute.entries()]
    .map(([route_name, e]) => ({
      route_name,
      provider: e.provider !== 'Amtrak' ? e.provider : undefined,
      active_trains: e.nums.length,
      train_numbers: [...new Set(e.nums)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      worst_delay_minutes: e.worst,
    }))
    .sort((a, b) => b.active_trains - a.active_trains || a.route_name.localeCompare(b.route_name));

  return {
    total_active_trains: total,
    route_count: routes.length,
    routes,
    note: `Includes Via Rail and Brightline trains carried in the same feed (marked by provider). ${MIRROR_NOTE}`,
  };
}

// ---------------------------------------------------------------------------
// amtrak_station_info

async function stationInfo(args: Record<string, unknown>) {
  const query = String(args.station ?? args.code ?? '').trim();
  if (!query) {
    throw new Error('amtrak_station_info requires a station code or name, e.g. { station: "Denver" }.');
  }

  const [stations, trains] = await Promise.all([
    amtraker<StationsMap>('/stations'),
    amtraker<TrainsMap>('/trains'),
  ]);

  const { station, alternates } = resolveStation(stations, query);
  if (!station) {
    throw new Error(
      `No Amtrak station matches "${query}". Use a 3-letter code (e.g. DEN, NYP) or a station/city name.`,
    );
  }

  let inboundCount = 0;
  for (const instances of Object.values(trains)) {
    for (const t of instances) {
      if (t.trainState === 'Completed') continue;
      const stop = t.stations.find((s) => s.code === station.code);
      if (stop && stop.status !== 'Departed') inboundCount++;
    }
  }

  const address = [station.address1?.trim(), station.address2?.trim(), station.city, station.state, station.zip]
    .filter(Boolean)
    .join(', ');

  return {
    name: stationLabel(station),
    code: station.code,
    city: station.city,
    state: station.state,
    address: address || undefined,
    timezone: station.tz,
    position: { lat: station.lat, lon: station.lon },
    trains_inbound: inboundCount,
    similar_stations: alternates?.length ? alternates : undefined,
    note: MIRROR_NOTE,
  };
}

// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'amtrak_train_status':
      return trainStatus(args);
    case 'amtrak_station_board':
      return stationBoard(args);
    case 'amtrak_routes_active':
      return routesActive();
    case 'amtrak_station_info':
      return stationInfo(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
