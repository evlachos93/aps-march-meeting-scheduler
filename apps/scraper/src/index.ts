import { mkdir, writeFile } from "node:fs/promises";

const DATA_ROOT = "https://makoshark-data.aps.org/441";
const EVENT_INDEX_URL = `${DATA_ROOT}/_ndx/meeting/sort-event-by-time.json`;
const OUTPUT_PATH = new URL("../../../data/talks.generated.json", import.meta.url);
const DEFAULT_MEETING_PREFIX = "MAR-";

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

function includesKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return KEYWORDS.some((keyword) => lower.includes(keyword));
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

  const meetingPrefix = (process.env.SCRAPER_MEETING_PREFIX ?? DEFAULT_MEETING_PREFIX).toUpperCase();
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
  const startTime = record.start ?? eventPeriod?.start ?? new Date().toISOString();
  const endTime =
    record.end ?? eventPeriod?.end ?? new Date(new Date(startTime).getTime() + 12 * 60 * 1000).toISOString();

  return {
    id: `APS-${record.id}`,
    title: normalize(record.title),
    abstract: normalize(record.abstract ?? ""),
    speakers: [],
    track: event.type || "Unknown",
    topics: [...new Set([...(record.topics ?? []), ...(event.topics ?? [])].map((t) => normalize(t).toLowerCase()))],
    room,
    startTime,
    endTime,
    sourceUrl: buildEventUrl(event.code, event.id)
  };
}

async function runScrape(): Promise<ScrapeResult> {
  const indexPayload = await fetchJson<Record<string, number>>(EVENT_INDEX_URL);
  const eventIds = extractEventIds(indexPayload);
  const maxEvents = Number(process.env.SCRAPER_MAX_EVENTS ?? eventIds.length);

  const talks: Talk[] = [];
  let relevantEventCount = 0;

  for (const eventId of eventIds.slice(0, maxEvents)) {
    let event: EventRecord;
    try {
      event = await fetchJson<EventRecord>(`${DATA_ROOT}/event/${eventId}.json`);
    } catch (error) {
      console.warn(`event failed: ${eventId}`, error);
      continue;
    }

    if (!event.presentation_ids?.length) {
      continue;
    }

    if (!eventLooksRelevant(event)) {
      continue;
    }

    relevantEventCount += 1;
    const room = await getLocationLabel(event.location_ids);

    for (const presentationId of event.presentation_ids) {
      try {
        const presentation = await fetchJson<PresentationRecord>(`${DATA_ROOT}/presentation/${presentationId}.json`);
        if (!talkLooksInteresting(presentation, event)) {
          continue;
        }
        talks.push(toTalk(presentation, event, room));
      } catch (error) {
        console.warn(`presentation failed: ${presentationId}`, error);
      }
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

async function persistResult(result: ScrapeResult): Promise<void> {
  await mkdir(new URL("../../../data/", import.meta.url), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2), "utf-8");
}

runScrape()
  .then(async (result) => {
    await persistResult(result);
    console.log("scrape finished", {
      scannedEventCount: result.scannedEventCount,
      relevantEventCount: result.relevantEventCount,
      talkCount: result.talkCount,
      outputPath: OUTPUT_PATH.pathname
    });
  })
  .catch((error) => {
    console.error("scrape failed", error);
    process.exitCode = 1;
  });
