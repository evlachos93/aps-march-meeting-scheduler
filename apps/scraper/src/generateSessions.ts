import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getDayKey, parsePreferences, scoreTalk } from "./planner.js";
import type { ParsedPreferences, Talk, TalksPayload } from "./planner.js";

type SessionItem = {
  sessionCode: string;
  title: string;
  url: string;
  sessionType: string;
  eventId?: number;
  presentationIds?: number[];
  talkTitles?: string[];
  matchedQueries: string[];
  score: number;
  reasons: string[];
};

type OutputSession = {
  sessionCode: string;
  title: string;
  url: string;
  sessionType: string;
  talkTitles: string[];
  date?: string;
  weekday?: string;
  startTime?: string;
  endTime?: string;
  timeRange: string;
  room?: string;
  timingSource: "talks" | "none";
};

type GeneratedSessions = {
  generatedAt: string;
  source: string;
  sourceUrl: string;
  fallbackSourceTalkFile?: string;
  preferencesFile: string;
  parsedPreferences: ParsedPreferences;
  summary: {
    totalInterestingSessions: number;
    totalQueriesUsed: number;
    usedFallback: boolean;
  };
  sessions: OutputSession[];
};

const SCHEDULE_BASE_URL = "https://summit.aps.org/schedule/";
const APS_DATA_ROOT = "https://makoshark-data.aps.org/441";
const EVENT_INDEX_URL = `${APS_DATA_ROOT}/_ndx/meeting/sort-event-by-time.json`;
const TALKS_PATH = new URL("../../../data/talks.generated.json", import.meta.url);
const PREFERENCES_PATH = new URL("../../../data/session-preferences.txt", import.meta.url);
const OUTPUT_PATH = new URL("../../../data/sessions.generated.json", import.meta.url);

type EventRecord = {
  id: number;
  code: string;
  title: string;
  description?: string;
  type?: string;
  presentation_ids?: number[];
  topics?: string[];
  tags?: Record<string, string[]>;
};

type PresentationRecord = {
  id: number;
  title: string;
};

const QC_TALK_KEYWORDS = [
  "qubit",
  "quantum computing",
  "error correction",
  "fault tolerance",
  "readout",
  "calibration",
  "coherence",
  "decoherence",
  "superconduct",
  "trapped ion",
  "neutral atom",
  "spin qubit",
  "quantum control",
  "quantum processor",
  "quantum hardware",
  "logical qubit",
  "qec",
  "gate",
  "compiler",
  "benchmark",
  "quantum algorithm",
  "quantum simulation"
];

const DEFAULT_SESSION_TYPES = ["INVITED", "FOCUS", "ORAL"];
const MEETING_TIME_ZONE = process.env.SCHEDULE_TIME_ZONE ?? "America/Denver";
const SCHEDULE_EVENT_TYPE_LABELS: Record<string, string> = {
  INVITED: "Invited Session",
  FOCUS: "Focus Session",
  ORAL: "Contributed Session",
  POSTER: "Poster Session",
  WORKSHOP: "Workshop",
  TUTORIAL: "Tutorial",
  PANEL: "Panel",
  ANCILLARYEVENT: "Activity",
  ACTIVITY: "Activity"
};

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSessionTypeFilter(): Set<string> {
  const raw = process.env.SESSIONS_EVENT_TYPES?.trim();
  const source = raw ? raw.split(",") : DEFAULT_SESSION_TYPES;
  return new Set(
    source
      .map((value) => value.trim().toUpperCase())
      .filter((value) => value.length > 0)
  );
}

function sessionTypeAllowed(sessionType: string | undefined, allowedTypes: Set<string>): boolean {
  const normalized = (sessionType ?? "UNKNOWN").toUpperCase();
  return allowedTypes.has(normalized);
}

function getScheduleEventTypeParams(allowedTypes: Set<string>): string[] {
  const labels: string[] = [];
  for (const type of allowedTypes) {
    const label = SCHEDULE_EVENT_TYPE_LABELS[type];
    if (label) {
      labels.push(label);
    }
  }
  return [...new Set(labels)];
}

function normalizeSessionCode(url: string): string | undefined {
  const smtMatch = url.match(/\/smt\/2026\/events\/([^/?#]+)/i);
  if (smtMatch?.[1]) {
    return smtMatch[1].toUpperCase();
  }

  const eventMatch = url.match(/\/events\/([^/?#]+)\/?/i);
  if (eventMatch?.[1]) {
    return eventMatch[1].toUpperCase();
  }

  return undefined;
}

function extractEventId(url: string): number | undefined {
  const match = url.match(/\/events\/[^/]+\/(\d+)(?:$|[/?#])/i);
  const id = Number(match?.[1]);
  if (!Number.isFinite(id) || id <= 0) {
    return undefined;
  }
  return id;
}

async function fetchEventMetadata(eventId: number): Promise<{ title?: string; type?: string }> {
  const url = `${APS_DATA_ROOT}/event/${eventId}.json`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    return {};
  }

  const payload = (await response.json()) as { title?: string; type?: string };

  return {
    title: payload.title && typeof payload.title === "string" ? decodeHtml(payload.title) : undefined,
    type: payload.type && typeof payload.type === "string" ? payload.type.toUpperCase() : undefined
  };
}

function scoreSession(title: string, queryMatches: string[], preferences: ParsedPreferences): { score: number; reasons: string[] } {
  const lowerTitle = title.toLowerCase();
  const reasons: string[] = [];
  let score = queryMatches.length * 3;

  for (const phrase of preferences.preferredPhrases) {
    if (lowerTitle.includes(phrase.toLowerCase())) {
      score += 2;
      reasons.push(`title contains: ${phrase}`);
    }
  }

  for (const phrase of preferences.avoidPhrases) {
    if (lowerTitle.includes(phrase.toLowerCase())) {
      score -= 5;
      reasons.push(`avoid phrase in title: ${phrase}`);
    }
  }

  for (const query of queryMatches) {
    reasons.push(`matched query: ${query}`);
  }

  return { score, reasons: [...new Set(reasons)] };
}

function normalizePhraseForTalkFilter(phrase: string): string | undefined {
  const normalized = phrase.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("all relevant sessions for now")) {
    return undefined;
  }
  return normalized;
}

function talkLooksRelevantToQc(title: string, preferences: ParsedPreferences): boolean {
  const lower = title.toLowerCase();

  if (QC_TALK_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return true;
  }

  for (const phrase of preferences.preferredPhrases) {
    const normalized = normalizePhraseForTalkFilter(phrase);
    if (normalized && lower.includes(normalized)) {
      return true;
    }
  }

  return false;
}

async function fetchPresentationTitles(presentationIds: number[]): Promise<string[]> {
  const titles: string[] = [];

  for (const presentationId of presentationIds) {
    try {
      const presentation = await fetchJson<PresentationRecord>(`${APS_DATA_ROOT}/presentation/${presentationId}.json`);
      if (presentation.title) {
        titles.push(decodeHtml(presentation.title));
      }
    } catch {
      continue;
    }
  }

  return [...new Set(titles)];
}

type SessionTiming = {
  date?: string;
  weekday?: string;
  startTime?: string;
  endTime?: string;
  timeRange: string;
  room?: string;
  timingSource: "talks" | "none";
};

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MEETING_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

function formatTimeRange(startTime?: string, endTime?: string): string {
  if (startTime && endTime) {
    return `${formatTime(startTime)}-${formatTime(endTime)}`;
  }
  if (startTime) {
    return formatTime(startTime);
  }
  return "TBD";
}

function getWeekday(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MEETING_TIME_ZONE,
    weekday: "long"
  }).format(new Date(iso));
}

function buildSessionTimingIndex(talks: Talk[]): Map<string, SessionTiming> {
  const talksBySession = new Map<string, Talk[]>();

  for (const talk of talks) {
    if (!talk.sourceUrl) {
      continue;
    }

    const sessionCode = normalizeSessionCode(talk.sourceUrl);
    if (!sessionCode) {
      continue;
    }

    const bucket = talksBySession.get(sessionCode) ?? [];
    bucket.push(talk);
    talksBySession.set(sessionCode, bucket);
  }

  const timingBySession = new Map<string, SessionTiming>();
  for (const [sessionCode, bucket] of talksBySession.entries()) {
    const sorted = [...bucket].sort((a, b) => a.startTime.localeCompare(b.startTime));
    const startTime = sorted[0]?.startTime;
    const endTime = [...sorted].sort((a, b) => b.endTime.localeCompare(a.endTime))[0]?.endTime;

    const roomCounter = new Map<string, number>();
    for (const talk of sorted) {
      const room = decodeHtml(talk.room ?? "").trim();
      if (!room) {
        continue;
      }
      roomCounter.set(room, (roomCounter.get(room) ?? 0) + 1);
    }

    const room = [...roomCounter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value]) => value)[0];

    const date = startTime ? getDayKey(startTime) : undefined;
    const weekday = startTime ? getWeekday(startTime) : undefined;

    timingBySession.set(sessionCode, {
      date,
      weekday,
      startTime,
      endTime,
      timeRange: formatTimeRange(startTime, endTime),
      room,
      timingSource: "talks"
    });
  }

  return timingBySession;
}

async function enrichSessionsWithTalkTitles(sessions: SessionItem[], preferences: ParsedPreferences): Promise<SessionItem[]> {
  const enriched: SessionItem[] = [];

  for (const session of sessions) {
    let talkTitles = session.talkTitles ?? [];
    let presentationIds = session.presentationIds;

    if ((!talkTitles || talkTitles.length === 0) && session.eventId) {
      try {
        const event = await fetchJson<EventRecord>(`${APS_DATA_ROOT}/event/${session.eventId}.json`);
        presentationIds = event.presentation_ids ?? presentationIds;
      } catch {
        // Keep best-effort behavior if event lookup fails.
      }
    }

    if ((!talkTitles || talkTitles.length === 0) && presentationIds?.length) {
      talkTitles = await fetchPresentationTitles(presentationIds);
    }

    talkTitles = [...new Set((talkTitles ?? []).map((title) => decodeHtml(title)).filter(Boolean))];
    if (talkTitles.length === 0) {
      continue;
    }

    const hasQcTalk = talkTitles.some((title) => talkLooksRelevantToQc(title, preferences));
    if (!hasQcTalk) {
      continue;
    }

    enriched.push({
      ...session,
      presentationIds,
      talkTitles
    });
  }

  return enriched;
}

function extractSessionsFromHtml(html: string, query: string, sessions: Map<string, SessionItem>): void {
  const linkRegex = /<a[^>]*href="([^"]*\/smt\/2026\/events\/[^"#?]+(?:\/[0-9]+)?)"[^>]*>([^<]+)<\/a>/gi;

  for (const match of html.matchAll(linkRegex)) {
    const href = match[1];
    const rawTitle = match[2];
    const sessionCode = normalizeSessionCode(href);
    if (!sessionCode) {
      continue;
    }

    const url = `https://summit.aps.org/smt/2026/events/${sessionCode}`;
    const title = decodeHtml(rawTitle);
    const existing = sessions.get(sessionCode);
    if (existing) {
      existing.matchedQueries = [...new Set([...existing.matchedQueries, query])];
      continue;
    }

    sessions.set(sessionCode, {
      sessionCode,
      title,
      url,
      sessionType: "UNKNOWN",
      matchedQueries: [query],
      score: 0,
      reasons: []
    });
  }
}

async function fetchScheduleSearchHtml(query: string, scheduleEventTypeParams: string[]): Promise<string> {
  const params = new URLSearchParams({
    _sortby: "relevance",
    q: query
  });
  for (const eventType of scheduleEventTypeParams) {
    params.append("event-type", eventType);
  }

  const url = `${SCHEDULE_BASE_URL}?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return await response.text();
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

function extractEventIds(indexPayload: Record<string, number>): number[] {
  const ids: number[] = [];
  for (const rawKey of Object.keys(indexPayload)) {
    const match = rawKey.match(/^\[(\d+),"event"\]$/);
    if (match) {
      ids.push(Number(match[1]));
    }
  }
  return ids;
}

function scoreEvent(event: EventRecord, preferences: ParsedPreferences): { score: number; matchedQueries: string[] } {
  const searchable = [
    event.title,
    event.description ?? "",
    ...(event.topics ?? []),
    ...(event.tags?.["Event Type"] ?? []),
    ...(event.tags?.["Event Tag"] ?? [])
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  const matchedQueries: string[] = [];

  for (const phrase of preferences.preferredPhrases) {
    const normalized = phrase.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (searchable.includes(normalized)) {
      score += 2;
      matchedQueries.push(phrase);
    }
  }

  for (const phrase of preferences.avoidPhrases) {
    const normalized = phrase.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (searchable.includes(normalized)) {
      score -= 4;
    }
  }

  return { score, matchedQueries: [...new Set(matchedQueries)] };
}

async function buildFallbackSessionsFromEventIndex(preferences: ParsedPreferences, allowedTypes: Set<string>): Promise<SessionItem[]> {
  const indexPayload = await fetchJson<Record<string, number>>(EVENT_INDEX_URL);
  const eventIds = extractEventIds(indexPayload);
  const meetingPrefix = (process.env.SCRAPER_MEETING_PREFIX ?? "MAR-").toUpperCase();
  const maxEvents = Number(process.env.SESSIONS_MAX_EVENTS ?? eventIds.length);

  const sessionsByCode = new Map<string, SessionItem>();

  for (const eventId of eventIds.slice(0, maxEvents)) {
    let event: EventRecord;
    try {
      event = await fetchJson<EventRecord>(`${APS_DATA_ROOT}/event/${eventId}.json`);
    } catch {
      continue;
    }

    if (!event.code || (meetingPrefix && !event.code.toUpperCase().startsWith(meetingPrefix))) {
      continue;
    }
    if (event.type?.toUpperCase() === "ONDEMAND") {
      continue;
    }
    if (!sessionTypeAllowed(event.type, allowedTypes)) {
      continue;
    }

    const { score, matchedQueries } = scoreEvent(event, preferences);
    if (score <= 0) {
      continue;
    }

    const existing = sessionsByCode.get(event.code.toUpperCase());
    if (existing) {
      existing.matchedQueries = [...new Set([...existing.matchedQueries, ...matchedQueries])];
      existing.score = Math.max(existing.score, score);
      continue;
    }

    sessionsByCode.set(event.code.toUpperCase(), {
      sessionCode: event.code.toUpperCase(),
      title: decodeHtml(event.title),
      url: `https://summit.aps.org/smt/2026/events/${event.code.toUpperCase()}`,
      sessionType: (event.type ?? "UNKNOWN").toUpperCase(),
      eventId: event.id,
      presentationIds: event.presentation_ids ?? [],
      matchedQueries,
      score,
      reasons: []
    });
  }

  return [...sessionsByCode.values()];
}

async function buildFallbackSessionsFromTalks(
  talks: TalksPayload["talks"],
  preferences: ParsedPreferences,
  allowedTypes: Set<string>
): Promise<SessionItem[]> {
  const skipRemoteEventMetadata = process.env.SESSIONS_SKIP_EVENT_INDEX === "1";
  const bySessionCode = new Map<string, SessionItem>();
  const eventIdBySessionCode = new Map<string, number>();

  for (const talk of talks) {
    if (!talk.sourceUrl) {
      continue;
    }

    const sessionCode = normalizeSessionCode(talk.sourceUrl);
    if (!sessionCode) {
      continue;
    }

    const { score, reasons } = scoreTalk(talk, preferences);
    if (score <= 0) {
      continue;
    }
    if (!sessionTypeAllowed(talk.track, allowedTypes)) {
      continue;
    }

    const matchedQueries = reasons
      .filter((reason) => reason.startsWith("topic match:") || reason.startsWith("keyword match:"))
      .map((reason) => reason.split(":")[1]?.trim())
      .filter((value): value is string => Boolean(value));

    const existing = bySessionCode.get(sessionCode);
    if (existing) {
      existing.matchedQueries = [...new Set([...existing.matchedQueries, ...matchedQueries])];
      existing.score = Math.max(existing.score, score);
      const eventId = extractEventId(talk.sourceUrl);
      if (eventId && !eventIdBySessionCode.has(sessionCode)) {
        eventIdBySessionCode.set(sessionCode, eventId);
      }
      continue;
    }

    const eventId = extractEventId(talk.sourceUrl);
    if (eventId) {
      eventIdBySessionCode.set(sessionCode, eventId);
    }

    bySessionCode.set(sessionCode, {
      sessionCode,
      title: `Session ${sessionCode}`,
      url: `https://summit.aps.org/smt/2026/events/${sessionCode}`,
      sessionType: "UNKNOWN",
      eventId,
      talkTitles: [decodeHtml(talk.title)],
      matchedQueries,
      score,
      reasons
    });
  }

  if (!skipRemoteEventMetadata) {
    const eventMetadataCache = new Map<number, { title?: string; type?: string }>();
    for (const [sessionCode, session] of bySessionCode.entries()) {
      const eventId = eventIdBySessionCode.get(sessionCode);
      if (!eventId) {
        continue;
      }

      if (!eventMetadataCache.has(eventId)) {
        try {
          eventMetadataCache.set(eventId, await fetchEventMetadata(eventId));
        } catch {
          eventMetadataCache.set(eventId, {});
        }
      }

      const metadata = eventMetadataCache.get(eventId);
      if (metadata?.title) {
        session.title = metadata.title;
      }
      if (metadata?.type) {
        session.sessionType = metadata.type;
      }
    }
  } else {
    console.warn("remote event metadata skipped via SESSIONS_SKIP_EVENT_INDEX=1");
  }

  return [...bySessionCode.values()];
}

async function run(): Promise<void> {
  const talksPayloadRaw = await readFile(TALKS_PATH, "utf-8");
  const preferencesRaw = await readFile(PREFERENCES_PATH, "utf-8");
  const talksPayload = JSON.parse(talksPayloadRaw) as TalksPayload;
  if (!Array.isArray(talksPayload.talks) || talksPayload.talks.length === 0) {
    throw new Error("No talks found in talks.generated.json. Run scraper first.");
  }

  const sessionTimingIndex = buildSessionTimingIndex(talksPayload.talks);

  const preferences = parsePreferences(preferencesRaw);
  const queries = [...new Set(preferences.preferredPhrases.map((phrase) => phrase.trim()).filter((phrase) => phrase.length >= 3))];
  const allowedTypes = parseSessionTypeFilter();
  const scheduleEventTypeParams = getScheduleEventTypeParams(allowedTypes);

  const sessionsByCode = new Map<string, SessionItem>();
  let usedFallback = false;
  let fallbackSource = "";
  const skipEventIndexFallback = process.env.SESSIONS_SKIP_EVENT_INDEX === "1";

  try {
    for (const query of queries) {
      const html = await fetchScheduleSearchHtml(query, scheduleEventTypeParams);
      extractSessionsFromHtml(html, query, sessionsByCode);
    }
  } catch (error) {
    console.warn("schedule fetch failed, using talks fallback", error);
    usedFallback = true;
  }

  if (sessionsByCode.size === 0) {
    if (!skipEventIndexFallback) {
      try {
        for (const session of await buildFallbackSessionsFromEventIndex(preferences, allowedTypes)) {
          sessionsByCode.set(session.sessionCode, session);
        }
        fallbackSource = "aps-event-index";
      } catch (error) {
        console.warn("event-index fallback failed, using talks fallback", error);
      }
    } else {
      console.warn("event-index fallback skipped via SESSIONS_SKIP_EVENT_INDEX=1");
    }

    if (sessionsByCode.size === 0) {
      for (const session of await buildFallbackSessionsFromTalks(talksPayload.talks, preferences, allowedTypes)) {
        sessionsByCode.set(session.sessionCode, session);
      }
      fallbackSource = "talks-generated";
    }
    usedFallback = true;
  }

  const sessions = [...sessionsByCode.values()]
    .map((session) => {
      const { score, reasons } = scoreSession(session.title, session.matchedQueries, preferences);
      return {
        ...session,
        score: Math.max(session.score, score),
        reasons: [...new Set([...session.reasons, ...reasons])]
      };
    })
    .filter((session) => session.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.sessionCode.localeCompare(b.sessionCode);
    });

  const qcRelevantSessions = await enrichSessionsWithTalkTitles(sessions, preferences);

  const output: GeneratedSessions = {
    generatedAt: new Date().toISOString(),
    source: "APS Summit schedule search",
    sourceUrl: SCHEDULE_BASE_URL,
    fallbackSourceTalkFile: usedFallback && fallbackSource === "talks-generated" ? "data/talks.generated.json" : undefined,
    preferencesFile: "data/session-preferences.txt",
    parsedPreferences: preferences,
    summary: {
      totalInterestingSessions: qcRelevantSessions.length,
      totalQueriesUsed: queries.length,
      usedFallback
    },
    sessions: qcRelevantSessions.map((session) => {
      const timing = sessionTimingIndex.get(session.sessionCode) ?? {
        timeRange: "TBD",
        timingSource: "none"
      };

      return {
        sessionCode: session.sessionCode,
        title: session.title,
        url: session.url,
        sessionType: session.sessionType,
        talkTitles: session.talkTitles ?? [],
        date: timing.date,
        weekday: timing.weekday,
        startTime: timing.startTime,
        endTime: timing.endTime,
        timeRange: timing.timeRange,
        room: timing.room,
        timingSource: timing.timingSource
      };
    })
  };

  await mkdir(new URL("../../../data/", import.meta.url), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

  console.log("sessions generated", {
    totalInterestingSessions: output.summary.totalInterestingSessions,
    totalQueriesUsed: output.summary.totalQueriesUsed,
    usedFallback: output.summary.usedFallback,
    fallbackSource,
    sessionTypes: [...allowedTypes],
    outputPath: OUTPUT_PATH.pathname
  });
}

run().catch((error) => {
  console.error("session generation failed", error);
  process.exitCode = 1;
});
