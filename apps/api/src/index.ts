import cors from "cors";
import express from "express";
import { buildIcs } from "./ics.js";
import { addToSchedule, getDailySummary, getSessions, getTalks, getUiTopics, getUserSchedule, removeFromSchedule } from "./store.js";
import type { Session } from "./types.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);

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

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "aps-api" });
});

app.get("/topics", (_req, res) => {
  res.json({ topics: getUiTopics() });
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

app.get("/talks", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const topic = String(req.query.topic ?? "").trim().toLowerCase();
  const track = String(req.query.track ?? "").trim().toLowerCase();
  const timeSlot = String(req.query.timeSlot ?? "all").trim().toLowerCase();
  const dayFilter = parseDay(String(req.query.day ?? ""));

  console.log(`[API /talks] Filtering by q="${q}", topic="${topic}", track="${track}", timeSlot="${timeSlot}", day="${req.query.day ?? ""}"`);

  const filtered = getTalks().filter((talk) => {
    const matchesQuery =
      !q ||
      talk.title.toLowerCase().includes(q) ||
      talk.abstract.toLowerCase().includes(q) ||
      talk.speakers.some((s) => s.toLowerCase().includes(q));
    const matchesTopic =
      !topic ||
      talk.topics.some((t) => t.toLowerCase() === topic) ||
      talk.title.toLowerCase().includes(topic) ||
      talk.abstract.toLowerCase().includes(topic);
    const matchesTrack = !track || talk.track.toLowerCase() === track;
    const matchesDay = dayFilter === null || getWeekdayFromTimestamp(talk.startTime) === dayFilter;
    const matchesTimeSlot = isInTimeSlot(talk.startTime, talk.endTime, timeSlot);
    return matchesQuery && matchesTopic && matchesTrack && matchesDay && matchesTimeSlot;
  });

  const sorted = [...filtered].sort((a, b) => {
    // Always sort chronologically by start time, then by day
    const weekdayDiff = getWeekdayFromTimestamp(a.startTime) - getWeekdayFromTimestamp(b.startTime);
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
