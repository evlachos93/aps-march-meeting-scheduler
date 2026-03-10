import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONCURRENCY, mapConcurrent } from "./utils.js";

const DATA_ROOT = "https://makoshark-data.aps.org/441";
const EVENT_INDEX_URL = `${DATA_ROOT}/_ndx/meeting/sort-event-by-time.json`;
const DEFAULT_OUTPUT_RELATIVE = "data/talks.generated.json";
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_MEETING_PREFIX = "";
const DEFAULT_EVENT_TYPES = [
  "ACTIVITY",
  "BUSINESSMEETING",
  "ORAL",
  "FOCUS",
  "INTERACT",
  "INVITED",
  "MINISYMPOSIUM",
  "OPENROUNDTABLE",
  "PANEL",
  "POSTER",
  "RECEPTION",
  "TOWNHALL",
  "TUTORIAL",
  "WORKSHOP"
];
const EVENT_TYPE_ALIASES: Record<string, string> = {
  ACTIVITY: "ACTIVITY",
  ANCILLARYEVENT: "ACTIVITY",
  BUSINESSMEETING: "BUSINESSMEETING",
  CONTRIBUTEDSESSION: "ORAL",
  ORAL: "ORAL",
  FOCUSSESSION: "FOCUS",
  FOCUS: "FOCUS",
  INTERACTSESSION: "INTERACT",
  INTERACT: "INTERACT",
  INVITEDSESSION: "INVITED",
  INVITED: "INVITED",
  MINISYMPOSIUM: "MINISYMPOSIUM",
  OPENROUNDTABLE: "OPENROUNDTABLE",
  PANEL: "PANEL",
  POSTERSESSION: "POSTER",
  POSTER: "POSTER",
  RECEPTION: "RECEPTION",
  TOWNHALL: "TOWNHALL",
  TUTORIAL: "TUTORIAL",
  WORKSHOP: "WORKSHOP"
};
const MEETING_TIME_ZONE = process.env.SCHEDULE_TIME_ZONE ?? "America/Denver";

const KEYWORDS = [
  "quantum",
  "qubit",
  "superconduct",
  "transmon",
  "error correction",
  "qec",
  "fabrication",
  "simulation",
  "numerical",
  "readout",
  "coherence",
  "decoherence",
  "trapped ion",
  "neutral atom",
  "photonic",
  "quantum optics",
  "quantum information",
  "quantum computing",
  "noise",
  "control"
];

type Talk = {
  id: string;
  title: string;
  abstract: string;
  speakers: string[];
  track: string;
  topics: string[];
  room: string;
  startTime: string;
  endTime: string;
  sourceUrl: string;
};

type EventRecord = {
  id: number;
  type: string;
  code: string;
  title: string;
  description?: string;
  periods?: Array<{ start: string; end: string }>;
  topics?: string[];
  tags?: Record<string, string[]>;
  presentation_ids?: number[];
  location_ids?: number[];
};

type PresentationRecord = {
  id: number;
  title: string;
  abstract?: string;
  start?: string;
  end?: string;
  topics?: string[];
  type?: string;
};

type LocationRecord = {
  id: number;
  building?: string;
  room?: string;
};

type ScrapeResult = {
  source: string;
  fetchedAt: string;
  scannedEventCount: number;
  relevantEventCount: number;
  talkCount: number;
  talks: Talk[];
};

const locationCache = new Map<number, LocationRecord | null>();

function normalize(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function getOutputPath(): string {
  const configured = process.env.SCRAPER_OUTPUT_FILE?.trim();
  const target = configured && configured.length > 0 ? configured : DEFAULT_OUTPUT_RELATIVE;
  return resolve(WORKSPACE_ROOT, target);
}

function includesKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return KEYWORDS.some((keyword) => lower.includes(keyword));
}

function normalizeEventTypeToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function canonicalizeEventType(value: string | undefined): string {
  const normalized = normalizeEventTypeToken(value ?? "");
  return EVENT_TYPE_ALIASES[normalized] ?? normalized;
}

function parseEventTypeFilter(): Set<string> {
  const raw = process.env.SCRAPER_EVENT_TYPES?.trim();
  const source = raw ? raw.split(",") : DEFAULT_EVENT_TYPES;
  const normalized = source
    .map((value) => canonicalizeEventType(value.trim()))
    .filter((value) => value.length > 0);

  if (normalized.includes("ALL")) {
    return new Set(DEFAULT_EVENT_TYPES);
  }

  return new Set(normalized);
}

function eventTypeAllowed(eventType: string | undefined, allowedTypes: Set<string>): boolean {
  const normalized = canonicalizeEventType(eventType ?? "UNKNOWN");
  return allowedTypes.has(normalized);
}

function toMeetingTimeIso(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEETING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const second = parts.find((part) => part.type === "second")?.value ?? "00";
  const offsetRaw = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
  const offsetMatch = offsetRaw.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  const offset = offsetMatch
    ? `${offsetMatch[1]}${offsetMatch[2].padStart(2, "0")}:${(offsetMatch[3] ?? "00").padStart(2, "0")}`
    : "+00:00";

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

function parseDateOrUndefined(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function extractEventIds(indexPayload: Record<string, number>): number[] {
  const ids: number[] = [];
  for (const rawKey of Object.keys(indexPayload)) {
    const match = rawKey.match(/^\[(\d+),\"event\"\]$/);
    if (match) {
      ids.push(Number(match[1]));
    }
  }
  return ids;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return (await response.json()) as T;
}

function buildEventUrl(code: string, id: number): string {
  return `https://summit.aps.org/events/${code}/${id}`;
}

function eventLooksRelevant(event: EventRecord): boolean {
  if (event.type?.toUpperCase() === "ONDEMAND") {
    return false;
  }

  const meetingPrefix = (process.env.SCRAPER_MEETING_PREFIX ?? DEFAULT_MEETING_PREFIX).trim().toUpperCase();
  if (meetingPrefix && !event.code?.toUpperCase().startsWith(meetingPrefix)) {
    return false;
  }

  const haystack = normalize(
    [
      event.title,
      event.description ?? "",
      ...(event.topics ?? []),
      ...(event.tags?.["Event Type"] ?? []),
      ...(event.tags?.["Event Tag"] ?? [])
    ].join(" ")
  );

  return includesKeyword(haystack);
}

function talkLooksInteresting(talk: PresentationRecord, event: EventRecord): boolean {
  const haystack = normalize(
    [talk.title, talk.abstract ?? "", ...(talk.topics ?? []), ...(event.topics ?? []), event.title].join(" ")
  );
  return includesKeyword(haystack);
}

async function getLocationLabel(locationIds: number[] | undefined): Promise<string> {
  const id = locationIds?.[0];
  if (!id) {
    return "TBD";
  }

  if (!locationCache.has(id)) {
    try {
      const location = await fetchJson<LocationRecord>(`${DATA_ROOT}/location/${id}.json`);
      locationCache.set(id, location);
    } catch {
      locationCache.set(id, null);
    }
  }

  const location = locationCache.get(id);
  if (!location) {
    return "TBD";
  }

  const pieces = [location.building, location.room].filter(Boolean).map((part) => normalize(String(part)));
  return pieces.length > 0 ? pieces.join(", ") : "TBD";
}

function toTalk(record: PresentationRecord, event: EventRecord, room: string): Talk {
  const eventPeriod = event.periods?.[0];
  const startDate = parseDateOrUndefined(record.start) ?? parseDateOrUndefined(eventPeriod?.start) ?? new Date();
  const endDate =
    parseDateOrUndefined(record.end) ??
    parseDateOrUndefined(eventPeriod?.end) ??
    new Date(startDate.getTime() + 12 * 60 * 1000);

  return {
    id: `APS-${record.id}`,
    title: normalize(record.title),
    abstract: normalize(record.abstract ?? ""),
    speakers: [],
    track: canonicalizeEventType(event.type) || "UNKNOWN",
    topics: [...new Set([...(record.topics ?? []), ...(event.topics ?? [])].map((t) => normalize(t).toLowerCase()))],
    room,
    startTime: toMeetingTimeIso(startDate),
    endTime: toMeetingTimeIso(endDate),
    sourceUrl: buildEventUrl(event.code, event.id)
  };
}

async function processEvent(
  eventId: number,
  allowedTypes: Set<string>
): Promise<{ relevant: boolean; talks: Talk[] } | null> {
  let event: EventRecord;
  try {
    event = await fetchJson<EventRecord>(`${DATA_ROOT}/event/${eventId}.json`);
  } catch (error) {
    console.warn(`event failed: ${eventId}`, error);
    return null;
  }

  if (!event.presentation_ids?.length) {
    return { relevant: false, talks: [] };
  }

  // Filter by session type before any presentation-level scraping.
  if (!eventTypeAllowed(event.type, allowedTypes)) {
    return { relevant: false, talks: [] };
  }

  if (!eventLooksRelevant(event)) {
    return { relevant: false, talks: [] };
  }

  const room = await getLocationLabel(event.location_ids);

  const presentationResults = await Promise.allSettled(
    event.presentation_ids.map((presentationId) =>
      fetchJson<PresentationRecord>(`${DATA_ROOT}/presentation/${presentationId}.json`)
    )
  );

  const talks: Talk[] = [];
  for (let i = 0; i < presentationResults.length; i++) {
    const result = presentationResults[i]!;
    if (result.status === "rejected") {
      console.warn(`presentation failed: ${event.presentation_ids[i]}`, result.reason);
      continue;
    }
    if (talkLooksInteresting(result.value, event)) {
      talks.push(toTalk(result.value, event, room));
    }
  }

  return { relevant: true, talks };
}

async function runScrape(): Promise<ScrapeResult> {
  const indexPayload = await fetchJson<Record<string, number>>(EVENT_INDEX_URL);
  const eventIds = extractEventIds(indexPayload);
  const maxEvents = Number(process.env.SCRAPER_MAX_EVENTS ?? eventIds.length);
  const allowedTypes = parseEventTypeFilter();

  const results = await mapConcurrent(
    eventIds.slice(0, maxEvents),
    CONCURRENCY,
    (eventId) => processEvent(eventId, allowedTypes)
  );

  const talks: Talk[] = [];
  let relevantEventCount = 0;
  for (const result of results) {
    if (!result) continue;
    if (result.relevant) {
      relevantEventCount += 1;
      talks.push(...result.talks);
    }
  }

  const deduped = new Map<string, Talk>();
  for (const talk of talks) {
    deduped.set(talk.id, talk);
  }

  return {
    source: "APS Global Physics Summit 2026",
    fetchedAt: new Date().toISOString(),
    scannedEventCount: Math.min(maxEvents, eventIds.length),
    relevantEventCount,
    talkCount: deduped.size,
    talks: [...deduped.values()].sort((a, b) => a.startTime.localeCompare(b.startTime))
  };
}

async function persistResult(result: ScrapeResult, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf-8");
}

runScrape()
  .then(async (result) => {
    const outputPath = getOutputPath();
    await persistResult(result, outputPath);
    console.log("scrape finished", {
      scannedEventCount: result.scannedEventCount,
      relevantEventCount: result.relevantEventCount,
      talkCount: result.talkCount,
      outputPath
    });
  })
  .catch((error) => {
    console.error("scrape failed", error);
    process.exitCode = 1;
  });
