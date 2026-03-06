import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Talk, TalksPayload } from "./planner.js";

type SessionRecord = {
  sessionCode: string;
  title: string;
  url: string;
  sessionType: string;
  talkTitles?: string[];
  date?: string;
  weekday?: string;
  startTime?: string;
  endTime?: string;
  timeRange?: string;
  room?: string;
  timingSource?: "event" | "talks" | "none";
};

type SessionsPayload = {
  generatedAt: string;
  source: string;
  sourceUrl: string;
  sessions: SessionRecord[];
};

type SessionTiming = {
  startTime?: string;
  endTime?: string;
  room?: string;
  source: "event" | "talks" | "none";
};

type EnrichedSession = SessionRecord & {
  startTime?: string;
  endTime?: string;
  room?: string;
  weekday?: Weekday;
  timeRange: string;
  timingSource: SessionTiming["source"];
};

type OutputJson = {
  generatedAt: string;
  sourceSessionsFile: string;
  sourceTalksFile: string;
  outputHtmlFile?: string;
  outputConfluenceFile?: string;
  summary: {
    totalSessionsInInput: number;
    sessionsPlacedInWeekTable: number;
    skippedOutsideMondayFriday: number;
    withInferredWeekday: number;
    withEventMetadata: number;
    withTalkFallback: number;
    withoutTiming: number;
  };
  days: Record<Weekday, EnrichedSession[]>;
};

type EventApiPayload = {
  start_time?: string;
  end_time?: string;
  startTime?: string;
  endTime?: string;
  start?: string;
  end?: string;
  room?: string;
  room_name?: string;
  location?: string;
  venue?: { name?: string };
};

type TalksIndexEntry = {
  talks: Talk[];
  eventIds: number[];
};

type Weekday = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday";

const MEETING_TIME_ZONE = process.env.SCHEDULE_TIME_ZONE ?? "America/Denver";
const APS_DATA_ROOT = "https://makoshark-data.aps.org/441";
const SESSIONS_PATH = new URL("../../../data/sessions.generated.json", import.meta.url);
const TALKS_PATH = new URL("../../../data/talks.generated.json", import.meta.url);
const OUTPUT_HTML_PATH = new URL("../../../data/sessions.week-table.generated.html", import.meta.url);
const OUTPUT_CONFLUENCE_PATH = new URL("../../../data/sessions.week-table.generated.confluence.txt", import.meta.url);
const OUTPUT_JSON_PATH = new URL("../../../data/sessions.week-table.generated.json", import.meta.url);
const WEEKDAY_ORDER: Weekday[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const SESSION_LETTER_SEQUENCE = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "J",
  "K",
  "L",
  "M",
  "N",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z"
] as const;

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

function escapeHtml(text: string): string {
  return decodeHtml(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractSessionCode(url: string): string | undefined {
  const match = url.match(/\/events\/([^/?#]+)(?:\/\d+)?(?:$|[?#/])/i);
  const code = match?.[1];
  return code ? code.toUpperCase() : undefined;
}

function extractEventId(url: string): number | undefined {
  const match = url.match(/\/events\/[^/]+\/(\d+)(?:$|[/?#])/i);
  const eventId = Number(match?.[1]);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return undefined;
  }
  return eventId;
}

function extractSessionLetter(sessionCode: string): string | undefined {
  const match = sessionCode.trim().toUpperCase().match(/^[A-Z]+-([A-Z])/);
  return match?.[1];
}

function parseIso(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return undefined;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function toWeekday(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MEETING_TIME_ZONE,
    weekday: "long"
  }).format(new Date(iso));
}

function toWeekdayOrUndefined(iso?: string): Weekday | undefined {
  if (!iso) {
    return undefined;
  }
  const weekday = toWeekday(iso);
  if (!WEEKDAY_ORDER.includes(weekday as Weekday)) {
    return undefined;
  }
  return weekday as Weekday;
}

function normalizeWeekday(value?: string): Weekday | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const mapped = WEEKDAY_ORDER.find((weekday) => weekday.toLowerCase() === normalized);
  return mapped;
}

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

function incrementWeekdayCounter(counter: Map<Weekday, number>, weekday: Weekday): void {
  counter.set(weekday, (counter.get(weekday) ?? 0) + 1);
}

function mostFrequentWeekday(counter: Map<Weekday, number>): Weekday | undefined {
  const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0];
}

function inferWeekdayFromLetterHeuristic(letter: string): Weekday | undefined {
  const normalized = letter.trim().toUpperCase();
  const index = SESSION_LETTER_SEQUENCE.indexOf(normalized as (typeof SESSION_LETTER_SEQUENCE)[number]);
  if (index < 0) {
    return undefined;
  }

  // APS session letters often progress in three slots per day (morning/noon/afternoon).
  const dayIndex = Math.floor(index / 3) % WEEKDAY_ORDER.length;
  return WEEKDAY_ORDER[dayIndex];
}

function buildWeekdayHints(talks: Talk[]): {
  bySessionCode: Map<string, Weekday>;
  bySessionLetter: Map<string, Weekday>;
} {
  const sessionCounter = new Map<string, Map<Weekday, number>>();
  const letterCounter = new Map<string, Map<Weekday, number>>();

  for (const talk of talks) {
    if (!talk.sourceUrl) {
      continue;
    }

    const sessionCode = extractSessionCode(talk.sourceUrl);
    const weekday = toWeekdayOrUndefined(talk.startTime);
    if (!sessionCode || !weekday) {
      continue;
    }

    const normalizedCode = sessionCode.toUpperCase();
    const sessionCount = sessionCounter.get(normalizedCode) ?? new Map<Weekday, number>();
    incrementWeekdayCounter(sessionCount, weekday);
    sessionCounter.set(normalizedCode, sessionCount);

    const letter = extractSessionLetter(normalizedCode);
    if (!letter) {
      continue;
    }

    const letterCount = letterCounter.get(letter) ?? new Map<Weekday, number>();
    incrementWeekdayCounter(letterCount, weekday);
    letterCounter.set(letter, letterCount);
  }

  const bySessionCode = new Map<string, Weekday>();
  for (const [sessionCode, counter] of sessionCounter.entries()) {
    const weekday = mostFrequentWeekday(counter);
    if (weekday) {
      bySessionCode.set(sessionCode, weekday);
    }
  }

  const bySessionLetter = new Map<string, Weekday>();
  for (const [letter, counter] of letterCounter.entries()) {
    const weekday = mostFrequentWeekday(counter);
    if (weekday) {
      bySessionLetter.set(letter, weekday);
    }
  }

  return { bySessionCode, bySessionLetter };
}

function buildTalksIndex(talks: Talk[]): Map<string, TalksIndexEntry> {
  const index = new Map<string, TalksIndexEntry>();

  for (const talk of talks) {
    if (!talk.sourceUrl) {
      continue;
    }

    const sessionCode = extractSessionCode(talk.sourceUrl);
    if (!sessionCode) {
      continue;
    }

    const existing = index.get(sessionCode) ?? { talks: [], eventIds: [] };
    existing.talks.push(talk);

    const eventId = extractEventId(talk.sourceUrl);
    if (eventId && !existing.eventIds.includes(eventId)) {
      existing.eventIds.push(eventId);
    }

    index.set(sessionCode, existing);
  }

  return index;
}

function summarizeFromTalks(entry?: TalksIndexEntry): SessionTiming {
  if (!entry || entry.talks.length === 0) {
    return { source: "none" };
  }

  const talks = [...entry.talks].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const startTime = parseIso(talks[0]?.startTime);
  const endTime = parseIso(talks[talks.length - 1]?.endTime);

  const roomCounter = new Map<string, number>();
  for (const talk of talks) {
    const room = decodeHtml(talk.room ?? "").trim();
    if (!room) {
      continue;
    }
    roomCounter.set(room, (roomCounter.get(room) ?? 0) + 1);
  }

  const room = [...roomCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value)[0];

  return {
    startTime,
    endTime,
    room,
    source: "talks"
  };
}

async function fetchEventTiming(eventId: number): Promise<SessionTiming> {
  const response = await fetch(`${APS_DATA_ROOT}/event/${eventId}.json`, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    return { source: "none" };
  }

  const payload = (await response.json()) as EventApiPayload;

  const startTime =
    parseIso(payload.start_time) ?? parseIso(payload.startTime) ?? parseIso(payload.start);
  const endTime = parseIso(payload.end_time) ?? parseIso(payload.endTime) ?? parseIso(payload.end);
  const room = decodeHtml(
    payload.room ?? payload.room_name ?? payload.location ?? payload.venue?.name ?? ""
  );

  if (!startTime && !endTime && !room) {
    return { source: "none" };
  }

  return {
    startTime,
    endTime,
    room: room || undefined,
    source: "event"
  };
}

function sortDaySessions(entries: EnrichedSession[]): EnrichedSession[] {
  return [...entries].sort((a, b) => {
    const aStart = a.startTime ?? "9999-12-31T00:00:00.000Z";
    const bStart = b.startTime ?? "9999-12-31T00:00:00.000Z";

    if (aStart !== bStart) {
      return aStart.localeCompare(bStart);
    }

    return a.title.localeCompare(b.title);
  });
}

function buildHtml(days: Record<Weekday, EnrichedSession[]>, generatedAt: string): string {
  const maxRows = Math.max(...WEEKDAY_ORDER.map((day) => days[day].length), 0);
  const rows: string[] = [];
  for (let row = 0; row < maxRows; row += 1) {
    const cells = WEEKDAY_ORDER.map((day): string => {
      const session = days[day][row];
      if (!session) {
        return "<td></td>";
      }

      const title = escapeHtml(session.title);
      const url = escapeHtml(session.url);
      const timeRange = escapeHtml(session.timeRange);
      const roomPart = session.room ? ` - ${escapeHtml(session.room)}` : "";
      const code = escapeHtml(session.sessionCode);

      return `<td><a href="${url}">${title}</a><br/>${timeRange}${roomPart}<br/><code>${code}</code></td>`;
    });

    rows.push(`<tr>${cells.join("")}</tr>`);
  }

  const headerCells = WEEKDAY_ORDER.map((day) => `<th>${day}</th>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>APS Interesting Sessions (Monday-Friday)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.4; }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; }
    th, td { border: 1px solid #dfe1e6; padding: 8px; vertical-align: top; }
    th { background: #f4f5f7; text-align: left; }
    code { background: #f4f5f7; padding: 1px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>APS Interesting Sessions (Monday-Friday)</h1>
  <p><strong>Generated at:</strong> ${escapeHtml(generatedAt)}<br/>
  <strong>Source:</strong> data/sessions.generated.json (+ data/talks.generated.json fallback)</p>
  <table>
    <thead>
      <tr>${headerCells}</tr>
    </thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>
  <p>Note: If you need extra context for a talk title, use <a href="https://summit.aps.org/schedule/search/">https://summit.aps.org/schedule/search/</a>.</p>
</body>
</html>
`;
}

function escapeConfluenceCell(text: string): string {
  return decodeHtml(text)
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .trim();
}

function buildConfluenceWiki(days: Record<Weekday, EnrichedSession[]>, generatedAt: string): string {
  const maxRows = Math.max(...WEEKDAY_ORDER.map((day) => days[day].length), 0);
  const lines: string[] = [];

  lines.push("h1. APS Interesting Sessions (Monday-Friday)");
  lines.push(`Generated at: ${generatedAt}`);
  lines.push("Source: data/sessions.generated.json (+ data/talks.generated.json fallback)");
  lines.push("");
  lines.push("|| Monday || Tuesday || Wednesday || Thursday || Friday ||");

  for (let row = 0; row < maxRows; row += 1) {
    const cells = WEEKDAY_ORDER.map((day): string => {
      const session = days[day][row];
      if (!session) {
        return " ";
      }

      const title = escapeConfluenceCell(session.title);
      const url = session.url;
      const roomPart = session.room ? ` - ${escapeConfluenceCell(session.room)}` : "";
      const code = escapeConfluenceCell(session.sessionCode);
      return `[${title}|${url}]\\\\${session.timeRange}${roomPart}\\\\${code}`;
    });

    lines.push(`| ${cells.join(" | ")} |`);
  }

  lines.push("");
  lines.push("Note: If you need extra context for a talk title, use https://summit.aps.org/schedule/search/.");

  return `${lines.join("\n")}\n`;
}

function parseOutputFormat(): "html" | "confluence" | "both" {
  const value = (process.env.SESSIONS_TABLE_FORMAT ?? "html").trim().toLowerCase();
  if (value === "confluence" || value === "both") {
    return value;
  }
  return "html";
}

function countNonEmptyWeekdays(days: Record<Weekday, EnrichedSession[]>): number {
  return WEEKDAY_ORDER.filter((day) => days[day].length > 0).length;
}

async function run(): Promise<void> {
  const sessionsRaw = await readFile(SESSIONS_PATH, "utf-8");
  const talksRaw = await readFile(TALKS_PATH, "utf-8");

  const sessionsPayload = JSON.parse(sessionsRaw) as SessionsPayload;
  const talksPayload = JSON.parse(talksRaw) as TalksPayload;

  if (!Array.isArray(sessionsPayload.sessions) || sessionsPayload.sessions.length === 0) {
    throw new Error("No sessions found in data/sessions.generated.json. Run generate:sessions first.");
  }

  if (!Array.isArray(talksPayload.talks)) {
    throw new Error("Invalid talks payload in data/talks.generated.json.");
  }

  const talksIndex = buildTalksIndex(talksPayload.talks);
  const weekdayHints = buildWeekdayHints(talksPayload.talks);
  const eventCache = new Map<number, Promise<SessionTiming>>();

  const enriched: EnrichedSession[] = [];
  let withEventMetadata = 0;
  let withTalkFallback = 0;
  let withoutTiming = 0;
  let withInferredWeekday = 0;
  let skippedOutsideMondayFriday = 0;

  for (const session of sessionsPayload.sessions) {
    const sessionCode = session.sessionCode || extractSessionCode(session.url || "") || "UNKNOWN";
    const talksEntry = talksIndex.get(sessionCode.toUpperCase());

    const sessionStart = parseIso(session.startTime);
    const sessionEnd = parseIso(session.endTime);
    const sessionWeekday = normalizeWeekday(session.weekday) ?? toWeekdayOrUndefined(sessionStart);
    const sessionRoom = session.room ? decodeHtml(session.room).trim() : undefined;

    let timing: SessionTiming = {
      startTime: sessionStart,
      endTime: sessionEnd,
      room: sessionRoom,
      source: session.timingSource ?? ((sessionStart || sessionEnd || sessionRoom) ? "talks" : "none")
    };

    let weekday = sessionWeekday;

    if (!timing.startTime && !timing.endTime && !timing.room) {
      timing = { source: "none" };
    }

    if (timing.source === "none") {
      const candidateEventIds = new Set<number>();
      const urlEventId = extractEventId(session.url);
      if (urlEventId) {
        candidateEventIds.add(urlEventId);
      }
      for (const eventId of talksEntry?.eventIds ?? []) {
        candidateEventIds.add(eventId);
      }

      for (const eventId of candidateEventIds) {
        if (!eventCache.has(eventId)) {
          eventCache.set(eventId, fetchEventTiming(eventId));
        }
        const eventTiming = await eventCache.get(eventId);
        if (eventTiming && (eventTiming.startTime || eventTiming.endTime || eventTiming.room)) {
          timing = eventTiming;
          break;
        }
      }

      if (timing.source === "none") {
        timing = summarizeFromTalks(talksEntry);
      }

      if (!weekday) {
        weekday = toWeekdayOrUndefined(timing.startTime);
      }
    }

    if (!weekday) {
      weekday =
        weekdayHints.bySessionCode.get(sessionCode.toUpperCase()) ??
        (extractSessionLetter(sessionCode)
          ? weekdayHints.bySessionLetter.get(extractSessionLetter(sessionCode) as string)
          : undefined) ??
        (extractSessionLetter(sessionCode)
          ? inferWeekdayFromLetterHeuristic(extractSessionLetter(sessionCode) as string)
          : undefined);
      if (weekday) {
        withInferredWeekday += 1;
      }
    }

    if (!weekday) {
      skippedOutsideMondayFriday += 1;
      if (timing.source === "event") {
        withEventMetadata += 1;
      } else if (timing.source === "talks") {
        withTalkFallback += 1;
      } else {
        withoutTiming += 1;
      }
      continue;
    }

    if (timing.source === "event") {
      withEventMetadata += 1;
    } else if (timing.source === "talks") {
      withTalkFallback += 1;
    } else {
      withoutTiming += 1;
    }

    enriched.push({
      ...session,
      sessionCode,
      startTime: timing.startTime,
      endTime: timing.endTime,
      room: timing.room,
      weekday,
      timeRange: session.timeRange && session.timeRange.trim().length > 0
        ? session.timeRange
        : formatTimeRange(timing.startTime, timing.endTime),
      timingSource: timing.source
    });
  }

  const days: Record<Weekday, EnrichedSession[]> = {
    Monday: [],
    Tuesday: [],
    Wednesday: [],
    Thursday: [],
    Friday: []
  };

  for (const session of enriched) {
    if (!session.weekday) {
      continue;
    }
    days[session.weekday].push(session);
  }

  for (const day of WEEKDAY_ORDER) {
    days[day] = sortDaySessions(days[day]);
  }

  const nonEmptyWeekdays = countNonEmptyWeekdays(days);

  const generatedAt = new Date().toISOString();
  const outputFormat = parseOutputFormat();
  const shouldWriteHtml = outputFormat === "html" || outputFormat === "both";
  const shouldWriteConfluence = outputFormat === "confluence" || outputFormat === "both";

  const html = shouldWriteHtml ? buildHtml(days, generatedAt) : undefined;
  const confluenceWiki = shouldWriteConfluence ? buildConfluenceWiki(days, generatedAt) : undefined;

  const outputJson: OutputJson = {
    generatedAt,
    sourceSessionsFile: "data/sessions.generated.json",
    sourceTalksFile: "data/talks.generated.json",
    outputHtmlFile: shouldWriteHtml ? "data/sessions.week-table.generated.html" : undefined,
    outputConfluenceFile: shouldWriteConfluence ? "data/sessions.week-table.generated.confluence.txt" : undefined,
    summary: {
      totalSessionsInInput: sessionsPayload.sessions.length,
      sessionsPlacedInWeekTable: enriched.length,
      skippedOutsideMondayFriday,
      withInferredWeekday,
      withEventMetadata,
      withTalkFallback,
      withoutTiming
    },
    days
  };

  await mkdir(new URL("../../../data/", import.meta.url), { recursive: true });
  if (html) {
    await writeFile(OUTPUT_HTML_PATH, html, "utf-8");
  }
  if (confluenceWiki) {
    await writeFile(OUTPUT_CONFLUENCE_PATH, confluenceWiki, "utf-8");
  }
  await writeFile(OUTPUT_JSON_PATH, `${JSON.stringify(outputJson, null, 2)}\n`, "utf-8");

  if (nonEmptyWeekdays <= 1 && outputJson.summary.sessionsPlacedInWeekTable > 0) {
    console.warn(
      "week-table warning: sessions occupy only one weekday column. Consider regenerating talks with a higher SCRAPER_MAX_EVENTS and rerun generate:sessions + generate:sessions-table."
    );
  }

  console.log("sessions week-table generated", {
    totalSessionsInInput: outputJson.summary.totalSessionsInInput,
    sessionsPlacedInWeekTable: outputJson.summary.sessionsPlacedInWeekTable,
    skippedOutsideMondayFriday: outputJson.summary.skippedOutsideMondayFriday,
    withInferredWeekday: outputJson.summary.withInferredWeekday,
    withEventMetadata: outputJson.summary.withEventMetadata,
    withTalkFallback: outputJson.summary.withTalkFallback,
    withoutTiming: outputJson.summary.withoutTiming,
    outputFormat,
    htmlOutputPath: shouldWriteHtml ? OUTPUT_HTML_PATH.pathname : undefined,
    confluenceOutputPath: shouldWriteConfluence ? OUTPUT_CONFLUENCE_PATH.pathname : undefined,
    jsonOutputPath: OUTPUT_JSON_PATH.pathname
  });
}

run().catch((error) => {
  console.error("sessions week-table generation failed", error);
  process.exitCode = 1;
});
