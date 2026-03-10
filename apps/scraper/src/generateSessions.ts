import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDayKey, parsePreferences, scoreTalk } from "./planner.js";
import type { ParsedPreferences, Talk, TalksPayload } from "./planner.js";
import { CONCURRENCY, mapConcurrent } from "./utils.js";

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
const TALKS_PATH = new URL("../../../data/talks.json", import.meta.url);
const PREFERENCES_PATH = new URL("../../../data/session-preferences.txt", import.meta.url);
const DEFAULT_OUTPUT_RELATIVE = "data/sessions.json";
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const LLM_API_URL = process.env.SESSIONS_LLM_API_URL ?? "https://api.githubcopilot.com/chat/completions";
const LLM_MODEL = process.env.SESSIONS_LLM_MODEL ?? "gpt-4o-mini";
const LLM_BATCH_SIZE = Math.max(1, Number(process.env.SESSIONS_LLM_BATCH_SIZE ?? 20));
const LLM_CONCURRENCY = 3;

function getOutputPath(): string {
  const configured = process.env.SCRAPER_OUTPUT_FILE?.trim();
  const target = configured && configured.length > 0 ? configured : DEFAULT_OUTPUT_RELATIVE;
  return resolve(WORKSPACE_ROOT, target);
}

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

const DEFAULT_SESSION_TYPES = [
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
const MEETING_TIME_ZONE = process.env.SCHEDULE_TIME_ZONE ?? "America/Denver";
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

function toDiscoveryPreferences(preferences: ParsedPreferences): ParsedPreferences {
  return {
    ...preferences,
    // Session discovery should never be constrained by per-day planning limits.
    maxTalksPerDay: Number.MAX_SAFE_INTEGER,
    dayStartMinutes: undefined,
    dayEndMinutes: undefined,
    minBreakMinutes: 0
  };
}

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

function normalizeEventTypeToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function canonicalizeEventType(value: string | undefined): string {
  const normalized = normalizeEventTypeToken(value ?? "");
  return EVENT_TYPE_ALIASES[normalized] ?? normalized;
}

function parseSessionTypeFilter(): Set<string> {
  const raw = process.env.SCRAPER_EVENT_TYPES?.trim();
  const source = raw ? raw.split(",") : DEFAULT_SESSION_TYPES;
  const normalized = source
    .map((value) => canonicalizeEventType(value.trim()))
    .filter((value) => value.length > 0);

  if (normalized.includes("ALL")) {
    return new Set(DEFAULT_SESSION_TYPES);
  }

  return new Set(normalized);
}

function sessionTypeAllowed(sessionType: string | undefined, allowedTypes: Set<string>): boolean {
  const normalized = canonicalizeEventType(sessionType ?? "UNKNOWN");
  return allowedTypes.has(normalized);
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
  let score = queryMatches.length * 2;

  for (const phrase of preferences.preferredPhrases) {
    if (lowerTitle.includes(phrase.toLowerCase())) {
      score += 1;
      reasons.push(`title contains: ${phrase}`);
    }
  }

  for (const phrase of preferences.avoidPhrases) {
    if (lowerTitle.includes(phrase.toLowerCase())) {
      score -= 10;
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

  // Avoid phrases take precedence: a talk matching an avoid phrase is not relevant
  // even if it also matches a preferred phrase.
  for (const phrase of preferences.avoidPhrases) {
    const normalized = normalizePhraseForTalkFilter(phrase);
    if (normalized && lower.includes(normalized)) {
      return false;
    }
  }

  // A talk is interesting when its title matches at least one preferred phrase.
  for (const phrase of preferences.preferredPhrases) {
    const normalized = normalizePhraseForTalkFilter(phrase);
    if (normalized && lower.includes(normalized)) {
      return true;
    }
  }

  return false;
}

async function fetchPresentationTitles(presentationIds: number[]): Promise<string[]> {
  const results = await Promise.allSettled(
    presentationIds.map((id) =>
      fetchJson<PresentationRecord>(`${APS_DATA_ROOT}/presentation/${id}.json`)
    )
  );
  const titles = results
    .filter((r): r is PromiseFulfilledResult<PresentationRecord> => r.status === "fulfilled")
    .map((r) => r.value.title)
    .filter(Boolean)
    .map((t) => decodeHtml(t));
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
  const diagnostics = {
    inputSessions: sessions.length,
    droppedByAvoidSessionTitle: 0,
    droppedNoTalkTitles: 0,
    droppedNoPreferredPhraseMatch: 0,
    eventLookupsAttempted: 0,
    eventLookupsFailed: 0,
    presentationFetchesAttempted: 0,
    outputSessions: 0
  };

  type EnrichedEntry = { session: SessionItem; presentationIds: number[] | undefined; talkTitles: string[] };

  const enrichResults = await mapConcurrent<SessionItem, EnrichedEntry | null>(
    sessions,
    CONCURRENCY,
    async (session) => {
      // Hard-block sessions whose title matches an avoid phrase.
      const sessionTitleLower = session.title.toLowerCase();
      for (const phrase of preferences.avoidPhrases) {
        const normalized = normalizePhraseForTalkFilter(phrase);
        if (normalized && sessionTitleLower.includes(normalized)) {
          diagnostics.droppedByAvoidSessionTitle += 1;
          return null;
        }
      }

      let talkTitles = session.talkTitles ?? [];
      let presentationIds = session.presentationIds;

      if ((!talkTitles || talkTitles.length === 0) && session.eventId) {
        diagnostics.eventLookupsAttempted += 1;
        try {
          const event = await fetchJson<EventRecord>(`${APS_DATA_ROOT}/event/${session.eventId}.json`);
          presentationIds = event.presentation_ids ?? presentationIds;
        } catch {
          diagnostics.eventLookupsFailed += 1;
          // Keep best-effort behavior if event lookup fails.
        }
      }

      if ((!talkTitles || talkTitles.length === 0) && presentationIds?.length) {
        diagnostics.presentationFetchesAttempted += 1;
        talkTitles = await fetchPresentationTitles(presentationIds);
      }

      talkTitles = [...new Set((talkTitles ?? []).map((title) => decodeHtml(title)).filter(Boolean))];
      if (talkTitles.length === 0) {
        diagnostics.droppedNoTalkTitles += 1;
        return null;
      }

      const hasQcTalk = talkTitles.some((title) => talkLooksRelevantToQc(title, preferences));
      if (!hasQcTalk) {
        diagnostics.droppedNoPreferredPhraseMatch += 1;
        return null;
      }

      return { session, presentationIds, talkTitles };
    }
  );

  const enriched = enrichResults
    .filter((r): r is EnrichedEntry => r !== null)
    .map(({ session, presentationIds, talkTitles }) => ({ ...session, presentationIds, talkTitles }));

  diagnostics.outputSessions = enriched.length;
  console.log("session enrichment diagnostics", diagnostics);

  return enriched;
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
  const meetingPrefix = (process.env.SCRAPER_MEETING_PREFIX ?? "").trim().toUpperCase();
  const maxEvents = Number(process.env.SCRAPER_MAX_EVENTS ?? eventIds.length);

  const sessionsByCode = new Map<string, SessionItem>();
  let skippedByEventType = 0;
  let skippedByScore = 0;

  const fetchedEvents = await mapConcurrent(
    eventIds.slice(0, maxEvents),
    CONCURRENCY,
    async (eventId): Promise<EventRecord | null> => {
      try {
        return await fetchJson<EventRecord>(`${APS_DATA_ROOT}/event/${eventId}.json`);
      } catch {
        return null;
      }
    }
  );

  const eventFetchErrors = fetchedEvents.filter((e) => e === null).length;
  for (const event of fetchedEvents) {
    if (!event) continue;

    if (!event.code || (meetingPrefix && !event.code.toUpperCase().startsWith(meetingPrefix))) {
      continue;
    }
    if (event.type?.toUpperCase() === "ONDEMAND") {
      continue;
    }
    if (!sessionTypeAllowed(event.type, allowedTypes)) {
      skippedByEventType += 1;
      continue;
    }

    const { score, matchedQueries } = scoreEvent(event, preferences);

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

  console.log("event-index fallback diagnostics", {
    eventIdsConsidered: Math.min(eventIds.length, maxEvents),
    eventFetchErrors,
    skippedByEventType,
    skippedByScore,
    outputSessions: sessionsByCode.size
  });

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
  let skippedMissingSourceUrl = 0;
  let skippedMissingSessionCode = 0;
  let skippedByScore = 0;
  let skippedByEventType = 0;

  for (const talk of talks) {
    if (!talk.sourceUrl) {
      skippedMissingSourceUrl += 1;
      continue;
    }

    const sessionCode = normalizeSessionCode(talk.sourceUrl);
    if (!sessionCode) {
      skippedMissingSessionCode += 1;
      continue;
    }

    const { score, reasons } = scoreTalk(talk, preferences);
    if (score <= 0) {
      skippedByScore += 1;
      continue;
    }
    if (!sessionTypeAllowed(talk.track, allowedTypes)) {
      skippedByEventType += 1;
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
    const uniqueEventIds = [
      ...new Set(
        [...bySessionCode.keys()]
          .map((code) => eventIdBySessionCode.get(code))
          .filter((id): id is number => id !== undefined)
      )
    ];

    const fetchedMetadata = await mapConcurrent(
      uniqueEventIds,
      CONCURRENCY,
      async (eventId): Promise<{ eventId: number; meta: { title?: string; type?: string } }> => {
        try {
          return { eventId, meta: await fetchEventMetadata(eventId) };
        } catch {
          return { eventId, meta: {} };
        }
      }
    );

    const eventMetadataCache = new Map<number, { title?: string; type?: string }>(
      fetchedMetadata.map(({ eventId, meta }) => [eventId, meta])
    );

    for (const [sessionCode, session] of bySessionCode.entries()) {
      const eventId = eventIdBySessionCode.get(sessionCode);
      if (!eventId) continue;
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

  console.log("talks fallback diagnostics", {
    talksInput: talks.length,
    skippedMissingSourceUrl,
    skippedMissingSessionCode,
    skippedByScore,
    skippedByEventType,
    outputSessions: bySessionCode.size
  });

  return [...bySessionCode.values()];
}

// ---------------------------------------------------------------------------
// LLM-based relevance filter
// ---------------------------------------------------------------------------

type LLMDecision = { sessionCode: string; relevant: boolean; reason: string };

async function classifySessionBatch(
  batch: SessionItem[],
  preferences: ParsedPreferences,
  apiKey: string
): Promise<LLMDecision[]> {
  const interested = preferences.preferredPhrases.slice(0, 25).join(", ");
  const avoid = preferences.avoidPhrases.slice(0, 25).join(", ");

  const sessions = batch.map((s) => ({
    code: s.sessionCode,
    title: s.title,
    talks: (s.talkTitles ?? []).slice(0, 12)
  }));

  const systemPrompt =
    `You are a quantum computing researcher's conference schedule assistant.\n` +
    `Your task: decide whether each session at the APS March Meeting is relevant to the researcher's interests.\n\n` +
    `INTERESTED IN: ${interested}\n` +
    `NOT INTERESTED IN: ${avoid}\n\n` +
    `Rules:\n` +
    `- RELEVANT: session is primarily about quantum computing hardware, algorithms, error correction, quantum information, or quantum sensing.\n` +
    `- NOT RELEVANT: primarily concerns high-energy physics, nuclear physics, astrophysics, condensed matter theory unrelated to qubits, or uses quantum computers only as an incidental tool for unrelated physics.\n` +
    `- When genuinely uncertain, mark as relevant.\n\n` +
    `Respond ONLY with valid JSON (no markdown fences): {"decisions": [{"sessionCode": "...", "relevant": true, "reason": "brief reason"}, ...]}`;

  const response = await fetch(LLM_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(sessions) }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API ${response.status}: ${text.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  const content = payload.choices[0]?.message?.content;
  if (!content) throw new Error("LLM returned empty content");

  const parsed = JSON.parse(content) as { decisions?: unknown };
  if (!Array.isArray(parsed.decisions)) throw new Error("LLM response missing decisions array");

  return (parsed.decisions as unknown[]).filter(
    (d): d is LLMDecision =>
      typeof d === "object" && d !== null &&
      typeof (d as LLMDecision).sessionCode === "string" &&
      typeof (d as LLMDecision).relevant === "boolean"
  );
}

async function filterSessionsWithLLM(
  sessions: SessionItem[],
  preferences: ParsedPreferences
): Promise<SessionItem[]> {
  const apiKey = (process.env.GITHUB_TOKEN ?? process.env.OPENAI_API_KEY)?.trim();
  if (!apiKey) {
    console.warn("LLM filter skipped: GITHUB_TOKEN (or OPENAI_API_KEY) not set");
    return sessions;
  }

  const batches: SessionItem[][] = [];
  for (let i = 0; i < sessions.length; i += LLM_BATCH_SIZE) {
    batches.push(sessions.slice(i, i + LLM_BATCH_SIZE));
  }

  console.log("LLM filter start", { sessions: sessions.length, batches: batches.length, model: LLM_MODEL, batchSize: LLM_BATCH_SIZE });

  const decisionMap = new Map<string, boolean>();
  let failedBatches = 0;

  const batchResults = await mapConcurrent(batches, LLM_CONCURRENCY, async (batch) => {
    try {
      return await classifySessionBatch(batch, preferences, apiKey);
    } catch (err) {
      console.warn("LLM batch failed, keeping sessions", err instanceof Error ? err.message : String(err));
      failedBatches += 1;
      return batch.map((s): LLMDecision => ({ sessionCode: s.sessionCode, relevant: true, reason: "batch error – kept" }));
    }
  });

  for (const decisions of batchResults) {
    for (const d of decisions) {
      decisionMap.set(d.sessionCode, d.relevant);
    }
  }

  const dropped: Array<{ sessionCode: string; title: string; reason: string }> = [];
  const filtered = sessions.filter((s) => {
    if (decisionMap.get(s.sessionCode) === false) {
      const decision = batchResults.flat().find((d) => d.sessionCode === s.sessionCode);
      dropped.push({ sessionCode: s.sessionCode, title: s.title, reason: decision?.reason ?? "unknown" });
      return false;
    }
    return true;
  });

  console.log("LLM filter diagnostics", {
    input: sessions.length,
    output: filtered.length,
    dropped: dropped.length,
    failedBatches
  });

  if (dropped.length > 0) {
    console.log("LLM filter — dropped sessions:");
    for (const { sessionCode, title, reason } of dropped) {
      console.log(`  [${sessionCode}] ${title} — ${reason}`);
    }
  }

  return filtered;
}

async function run(): Promise<void> {
  const talksPayloadRaw = await readFile(TALKS_PATH, "utf-8");
  const preferencesRaw = await readFile(PREFERENCES_PATH, "utf-8");
  const talksPayload = JSON.parse(talksPayloadRaw) as TalksPayload;
  if (!Array.isArray(talksPayload.talks) || talksPayload.talks.length === 0) {
    throw new Error("No talks found in data/talks.json. Run scraper first.");
  }

  const sessionTimingIndex = buildSessionTimingIndex(talksPayload.talks);

  const preferences = toDiscoveryPreferences(parsePreferences(preferencesRaw));
  const queries = [...new Set(preferences.preferredPhrases.map((phrase) => phrase.trim()).filter((phrase) => phrase.length >= 3))];
  const allowedTypes = parseSessionTypeFilter();

  const sessionsByCode = new Map<string, SessionItem>();
  let usedFallback = false;
  let fallbackSource = "";
  const skipEventIndexFallback = process.env.SESSIONS_SKIP_EVENT_INDEX === "1";

  console.log("session generation start", {
    talksCount: talksPayload.talks.length,
    preferredPhraseCount: preferences.preferredPhrases.length,
    queryCount: queries.length,
    allowedSessionTypes: [...allowedTypes],
    skipEventIndexFallback
  });

  // JSON-first pipeline: build sessions directly from APS event index/event/presentation data.
  try {
    for (const session of await buildFallbackSessionsFromEventIndex(preferences, allowedTypes)) {
      sessionsByCode.set(session.sessionCode, session);
    }
  } catch (error) {
    console.warn("event-index source failed, using talks fallback", error);
  }

  if (sessionsByCode.size === 0) {
    if (skipEventIndexFallback) {
      console.warn("event-index source unavailable and SESSIONS_SKIP_EVENT_INDEX=1 is set");
    }
    for (const session of await buildFallbackSessionsFromTalks(talksPayload.talks, preferences, allowedTypes)) {
      sessionsByCode.set(session.sessionCode, session);
    }
    usedFallback = true;
    fallbackSource = "talks-generated";
  }

  console.log("json source diagnostics", {
    sessionsFromEventIndex: usedFallback ? 0 : sessionsByCode.size,
    usedFallback,
    fallbackSource
  });

  const sessions = [...sessionsByCode.values()]
    .map((session) => {
      const { score, reasons } = scoreSession(session.title, session.matchedQueries, preferences);
      return {
        ...session,
        score: Math.max(session.score, score),
        reasons: [...new Set([...session.reasons, ...reasons])]
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.sessionCode.localeCompare(b.sessionCode);
    });

  console.log("session scoring diagnostics", {
    candidateSessionsBeforeScoreFilter: sessionsByCode.size,
    candidateSessionsAfterScoreFilter: sessions.length,
    note: "No score-based filtering applied; talk-title preferred-phrase filtering happens during enrichment"
  });

  const enrichedSessions = await enrichSessionsWithTalkTitles(sessions, preferences);
  const qcRelevantSessions =
    process.env.SESSIONS_LLM_FILTER === "1"
      ? await filterSessionsWithLLM(enrichedSessions, preferences)
      : enrichedSessions;

  const outputPath = getOutputPath();
  const output: GeneratedSessions = {
    generatedAt: new Date().toISOString(),
    source: "APS Summit schedule search",
    sourceUrl: SCHEDULE_BASE_URL,
    fallbackSourceTalkFile: usedFallback && fallbackSource === "talks-generated" ? "data/talks.json" : undefined,
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

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

  console.log("sessions generated", {
    totalInterestingSessions: output.summary.totalInterestingSessions,
    totalQueriesUsed: output.summary.totalQueriesUsed,
    usedFallback: output.summary.usedFallback,
    fallbackSource,
    sessionTypes: [...allowedTypes],
    outputPath
  });
}

run().catch((error) => {
  console.error("session generation failed", error);
  process.exitCode = 1;
});
