import cors from "cors";
import express from "express";
import { buildIcs } from "./ics.js";
import { addToSchedule, deleteNote, getDailySummary, getSessions, getTalks, getUiTopics, getUserNotes, getUserSchedule, removeFromSchedule, setNote } from "./store.js";
import type { AiSummary, AiSummaryHighlight, AiSummaryTopic, Session, Talk } from "./types.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const LLM_API_URL = process.env.SESSIONS_LLM_API_URL?.trim();
const LLM_API_KEY = process.env.SESSIONS_LLM_API_KEY?.trim();
const LLM_MODEL = process.env.SESSIONS_LLM_MODEL?.trim() ?? "gpt-4o-mini";
const SUMMARY_RESPONSE_TEMPERATURE = 0.3;

const WEEKDAY_ORDER: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

function parseDay(value?: string): number | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const direct = WEEKDAY_ORDER[normalized];
  if (direct !== undefined) {
    return direct;
  }
  const short = normalized.slice(0, 3);
  const shortMatch = WEEKDAY_ORDER[short];
  if (shortMatch !== undefined) {
    return shortMatch;
  }
  return null;
}

function getWeekdayFromTimestamp(value?: string): number {
  if (!value) {
    return 7;
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return 7;
  }
  return date.getUTCDay();
}

function getWeekdayFromLabel(value?: string): number {
  if (!value) {
    return 7;
  }
  const normalized = value.trim().toLowerCase();
  return WEEKDAY_ORDER[normalized] ?? WEEKDAY_ORDER[normalized.slice(0, 3)] ?? 7;
}

function getSessionWeekday(session: Session): number {
  const fromTimestamp = getWeekdayFromTimestamp(session.startTime);
  if (fromTimestamp !== 7) {
    return fromTimestamp;
  }
  return getWeekdayFromLabel(session.weekday);
}

function getTalkWeekday(talk: Talk): number {
  const fromLabel = getWeekdayFromLabel(talk.weekday);
  if (fromLabel !== 7) {
    return fromLabel;
  }
  return getWeekdayFromTimestamp(talk.startTime);
}

const MINUTES_PER_DAY = 24 * 60;
const TIME_SLOT_RANGES: Record<string, { start: number; end: number }> = {
  morning: { start: 8 * 60, end: 11 * 60 },
  afternoon: { start: 11 * 60, end: 14 * 60 },
  lateafternoon: { start: 14 * 60, end: MINUTES_PER_DAY }
};

function getLocalMinutesFromTimestamp(value?: string): number | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  let offsetMinutes = 0;
  const offsetMatch = value.match(/([+-]\d{2})(?::?(\d{2}))?$/);
  if (offsetMatch) {
    const sign = offsetMatch[1].startsWith("-") ? -1 : 1;
    const hours = Math.abs(Number(offsetMatch[1]));
    const minutes = Number(offsetMatch[2] ?? "0");
    offsetMinutes = sign * (hours * 60 + minutes);
  } else if (/Z$/i.test(value)) {
    offsetMinutes = 0;
  }
  const localMinutes = utcMinutes + offsetMinutes;
  const normalized = ((localMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return normalized;
}

function isInTimeSlot(startTime: string | undefined, endTime: string | undefined, timeSlot: string): boolean {
  if (!timeSlot || timeSlot === "all") {
    return true;
  }
  const slotRange = TIME_SLOT_RANGES[timeSlot.toLowerCase()];
  if (!slotRange) {
    return true;
  }

  const startMinutes = getLocalMinutesFromTimestamp(startTime);
  if (startMinutes === null) {
    return true;
  }
  let endMinutes = getLocalMinutesFromTimestamp(endTime);
  if (endMinutes === null) {
    endMinutes = startMinutes;
  }
  if (endMinutes < startMinutes) {
    endMinutes += MINUTES_PER_DAY;
  }

  return startMinutes < slotRange.end && endMinutes > slotRange.start;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isAiSummaryAvailable(): boolean {
  return Boolean(LLM_API_URL && LLM_API_KEY);
}

function isoDateFromTimestamp(value?: string): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function formatTime(timestamp?: string): string {
  if (!timestamp) return "TBD";
  const d = new Date(timestamp);
  if (Number.isNaN(d.valueOf())) return "TBD";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function buildSessionContext(sessions: Session[]): string {
  const items = sessions.map((session) => ({
    code: session.sessionCode,
    title: session.title,
    type: session.sessionType,
    time: session.timeRange,
    talks: session.talkTitles
  }));
  return JSON.stringify(items);
}

function normalizeTopic(input: unknown): AiSummaryTopic | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const detail = typeof candidate.detail === "string" ? candidate.detail.trim() : "";
  if (!name || !detail) {
    return null;
  }
  return { name, detail };
}

function normalizeHighlight(input: unknown): AiSummaryHighlight | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
  if (!title || !reason) {
    return null;
  }
  const talkId = typeof candidate.talkId === "string" && candidate.talkId.trim() ? candidate.talkId.trim() : undefined;
  return { title, reason, talkId };
}

function parseAiSummaryPayload(content: string, weekday: string): AiSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`LLM response could not be parsed as JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("LLM response is not an object");
  }
  const payload = parsed as Record<string, unknown>;
  const overview = typeof payload.overview === "string" ? payload.overview.trim() : "";
  if (!overview) {
    throw new Error("LLM response missing overview");
  }
  const rawTopics = Array.isArray(payload.topics) ? payload.topics : [];
  const topics = rawTopics.map(normalizeTopic).filter((item): item is AiSummaryTopic => Boolean(item));
  if (!topics.length) {
    throw new Error("LLM response missing topic breakdown");
  }
  const rawHighlights = Array.isArray(payload.highlights) ? payload.highlights : [];
  const highlights = rawHighlights
    .map(normalizeHighlight)
    .filter((item): item is AiSummaryHighlight => Boolean(item));

  return {
    date: weekday,
    overview,
    topics,
    highlights: highlights.length ? highlights : undefined
  };
}

async function generateAiSummary(weekday: string, sessions: Session[]): Promise<AiSummary> {
  if (!LLM_API_URL || !LLM_API_KEY) {
    throw new Error("LLM configuration missing");
  }

  const sessionContext = buildSessionContext(sessions);
  const userPrompt = `Summarize the APS March Meeting sessions for ${weekday}. The input is a JSON array of sessions, each with code, title, type, time range, and talk titles. Group the output topics by time of day (morning, afternoon, late afternoon). Write a single plain sentence for the overview. For each topic group, state the subject matter in one sentence. Use only what is in the data. Input: ${sessionContext}\nReturn only valid JSON: {"overview": "...", "topics": [{"name": "...", "detail": "..."}, ...], "highlights": [{"title": "...", "talkId": "...", "reason": "..."}]}. No markdown fences.`;

  const response = await fetch(LLM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: "You are a factual conference schedule assistant. Be concise and neutral. No filler words, no enthusiasm, no encouragement. Report only what is in the data." },
        { role: "user", content: userPrompt }
      ],
      temperature: SUMMARY_RESPONSE_TEMPERATURE,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API ${response.status}: ${text.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("LLM returned empty content");
  }

  return parseAiSummaryPayload(content, weekday);
}

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "aps-api" });
});

app.get("/topics", (_req, res) => {
  res.json({ topics: getUiTopics() });
});

app.get("/summaries/capabilities", (_req, res) => {
  res.json({ aiSummaryEnabled: isAiSummaryAvailable() });
});

app.get("/summaries", (req, res) => {
  const date = String(req.query.date ?? "").trim();
  
  if (!date) {
    // Return all summaries
    res.json({ summaries: {} });
    return;
  }

  const summary = getDailySummary(date);
  if (!summary) {
    return res.status(404).json({ error: "summary not found for date" });
  }

  res.json({ summary });
});

app.post("/summaries", async (req, res) => {
  if (!isAiSummaryAvailable()) {
    return res.status(503).json({ error: "AI summary endpoint is not configured" });
  }

  const weekday = String(req.body?.weekday ?? "").trim().toLowerCase();
  const dayNumber = parseDay(weekday);
  if (dayNumber === null) {
    return res.status(400).json({ error: "weekday must be a day name, e.g. monday" });
  }

  const daySessions = getSessions().filter(
    (session) => session.weekday?.toLowerCase() === weekday
  );
  if (!daySessions.length) {
    return res.status(404).json({ error: "no sessions found for the requested weekday" });
  }

  const talkIdSet = new Set(daySessions.flatMap((session) => session.talkIds));
  const talks = getTalks().filter((talk) => talkIdSet.has(talk.id));
  if (!talks.length) {
    return res.status(404).json({ error: "no talks resolved for the requested weekday" });
  }

  try {
    const summary = await generateAiSummary(weekday, daySessions);
    res.json({ summary });
  } catch (err) {
    console.error("[AI summary]", err);
    res.status(502).json({ error: "Failed to generate AI summary" });
  }
});

app.get("/talks", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const topic = String(req.query.topic ?? "").trim().toLowerCase();
  const topicsParam = String(req.query.topics ?? "").trim().toLowerCase();
  const track = String(req.query.track ?? "").trim().toLowerCase();
  const timeSlot = String(req.query.timeSlot ?? "all").trim().toLowerCase();
  const dayFilter = parseDay(String(req.query.day ?? ""));

  const topicFilters = topicsParam
    ? topicsParam
        .split(",")
        .map((value) => value.trim())
        .filter((value) => Boolean(value))
    : topic
    ? [topic]
    : [];
  console.log(`[API /talks] Filtering by q="${q}", topics="${topicFilters.join(",")}", track="${track}", timeSlot="${timeSlot}", day="${req.query.day ?? ""}"`);

  const filtered = getTalks().filter((talk) => {
    const matchesQuery =
      !q ||
      talk.title.toLowerCase().includes(q) ||
      talk.abstract.toLowerCase().includes(q) ||
      talk.speakers.some((s) => s.toLowerCase().includes(q));
    const matchesTopic =
      !topicFilters.length ||
      topicFilters.some((topicFilter) =>
        talk.topics.some((t) => t.toLowerCase() === topicFilter) ||
        talk.title.toLowerCase().includes(topicFilter) ||
        talk.abstract.toLowerCase().includes(topicFilter)
      );
    const matchesTrack = !track || talk.track.toLowerCase() === track;
    const matchesDay = dayFilter === null || getTalkWeekday(talk) === dayFilter;
    const matchesTimeSlot = isInTimeSlot(talk.startTime, talk.endTime, timeSlot);
    return matchesQuery && matchesTopic && matchesTrack && matchesDay && matchesTimeSlot;
  });

  const sorted = [...filtered].sort((a, b) => {
    // Always sort chronologically by start time, then by day
    const weekdayDiff = getTalkWeekday(a) - getTalkWeekday(b);
    if (weekdayDiff !== 0) {
      return weekdayDiff;
    }
    return a.startTime.localeCompare(b.startTime);
  });

  res.json({ talks: sorted });
});

app.get("/sessions", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const sessionType = String(req.query.sessionType ?? "").trim().toLowerCase();
  const timeSlot = String(req.query.timeSlot ?? "all").trim().toLowerCase();
  const dayFilter = parseDay(String(req.query.day ?? ""));

  console.log(`[API /sessions] Filtering by q="${q}", sessionType="${sessionType}", timeSlot="${timeSlot}", day="${req.query.day ?? ""}"`);

  const filtered = getSessions().filter((session) => {
    const searchableText = [
      session.sessionCode,
      session.title,
      session.sessionType,
      session.room ?? "",
      ...session.talkTitles
    ]
      .join(" ")
      .toLowerCase();

    const matchesQuery = !q || searchableText.includes(q);
    const matchesType = !sessionType || session.sessionType.toLowerCase() === sessionType;
    const matchesDay = dayFilter === null || getSessionWeekday(session) === dayFilter;
    const matchesTimeSlot = isInTimeSlot(session.startTime, session.endTime, timeSlot);
    return matchesQuery && matchesType && matchesDay && matchesTimeSlot;
  });

  const sorted = [...filtered].sort((a, b) => {
    // Always sort chronologically by start time, then by day
    const weekdayDiff = getSessionWeekday(a) - getSessionWeekday(b);
    if (weekdayDiff !== 0) {
      return weekdayDiff;
    }
    const aTime = a.startTime ?? "";
    const bTime = b.startTime ?? "";
    if (aTime || bTime) {
      return aTime.localeCompare(bTime);
    }
    return a.sessionCode.localeCompare(b.sessionCode);
  });

  res.json({ sessions: sorted });
});

app.get("/notes/:userId", (req, res) => {
  const { userId } = req.params;
  res.json({ notes: getUserNotes(userId) });
});

app.put("/notes/:userId/:talkId", (req, res) => {
  const { userId, talkId } = req.params;
  const content = String(req.body?.content ?? "").trim();
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }
  const note = setNote(userId, talkId, content);
  return res.status(200).json({ note });
});

app.delete("/notes/:userId/:talkId", (req, res) => {
  const { userId, talkId } = req.params;
  const removed = deleteNote(userId, talkId);
  if (!removed) {
    return res.status(404).json({ error: "note not found" });
  }
  return res.status(204).send();
});

app.get("/schedule/:userId", (req, res) => {
  const { userId } = req.params;
  const talksById = new Map(getTalks().map((talk) => [talk.id, talk]));
  const sessionsById = new Map(getSessions().map((session) => [session.sessionCode, session]));
  const schedule = getUserSchedule(userId);

  const talks = schedule
    .filter((entry) => entry.type === "talk")
    .map((entry) => talksById.get(entry.id))
    .filter((talk) => Boolean(talk));

  const sessions = schedule
    .filter((entry) => entry.type === "session")
    .map((entry) => sessionsById.get(entry.id))
    .filter((session) => Boolean(session));

  res.json({ talks, sessions });
});

app.post("/schedule/:userId", (req, res) => {
  const { userId } = req.params;
  const id = String(req.body?.id ?? "").trim();
  const type = String(req.body?.type ?? "").trim().toLowerCase() as "talk" | "session" | "";

  if (!id || !type || !["talk", "session"].includes(type)) {
    return res.status(400).json({ error: "id and type (talk|session) are required" });
  }

  if (type === "talk") {
    const talkExists = getTalks().some((talk) => talk.id === id);
    if (!talkExists) {
      return res.status(404).json({ error: "talk not found" });
    }
  } else {
    const sessionExists = getSessions().some((session) => session.sessionCode === id);
    if (!sessionExists) {
      return res.status(404).json({ error: "session not found" });
    }
  }

  const entry = addToSchedule(userId, id, type as "talk" | "session");
  return res.status(201).json({ entry });
});

app.delete("/schedule/:userId", (req, res) => {
  const { userId } = req.params;
  const id = String(req.query.id ?? "").trim();
  const type = String(req.query.type ?? "").trim().toLowerCase() as "talk" | "session" | "";

  if (!id || !type || !["talk", "session"].includes(type)) {
    return res.status(400).json({ error: "id and type (talk|session) query params required" });
  }

  const removed = removeFromSchedule(userId, id, type as "talk" | "session");
  if (!removed) {
    return res.status(404).json({ error: "schedule entry not found" });
  }
  return res.status(204).send();
});

app.get("/schedule/:userId/export.ics", (req, res) => {
  const { userId } = req.params;
  const talksById = new Map(getTalks().map((talk) => [talk.id, talk]));
  const talks = getUserSchedule(userId)
    .filter((entry) => entry.type === "talk")
    .map((entry) => talksById.get(entry.id))
    .filter((talk): talk is NonNullable<typeof talk> => Boolean(talk));
  const ics = buildIcs(userId, talks);

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=aps-schedule-${userId}.ics`);
  res.send(ics);
});

const server = app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    console.error("Run `npm run stop:api` to stop the process using the API port.");
    console.error("Or run with a different port: `PORT=8788 npm run dev:api`.");
    process.exit(1);
  }

  throw err;
});
