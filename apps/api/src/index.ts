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

function getHourFromTimestamp(value?: string): number {
  if (!value) {
    return -1;
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return -1;
  }
  return date.getUTCHours();
}

function isInTimeSlot(startTime: string | undefined, timeSlot: string): boolean {
  if (!startTime || !timeSlot || timeSlot === "all") {
    return true;
  }
  const hour = getHourFromTimestamp(startTime);
  if (hour === -1) {
    return true;
  }
  
  const timeSlotLower = timeSlot.toLowerCase();
  if (timeSlotLower === "morning") {
    // 8 AM to 11 AM (hour 8-10)
    return hour >= 8 && hour < 11;
  }
  if (timeSlotLower === "afternoon") {
    // 11 AM to 2 PM (hour 11-13)
    return hour >= 11 && hour < 14;
  }
  if (timeSlotLower === "lateafternoon") {
    // 2 PM to 5 PM (hour 14-16)
    return hour >= 14 && hour < 17;
  }
  
  return true;
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
    const matchesTopic = !topic || talk.topics.some((t) => t.toLowerCase() === topic);
    const matchesTrack = !track || talk.track.toLowerCase() === track;
    const matchesDay = dayFilter === null || getWeekdayFromTimestamp(talk.startTime) === dayFilter;
    const matchesTimeSlot = isInTimeSlot(talk.startTime, timeSlot);
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
    const matchesTimeSlot = isInTimeSlot(session.startTime, timeSlot);
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
  const talks = getUserSchedule(userId)
    .map((entry) => talksById.get(entry.talkId))
    .filter((talk) => Boolean(talk));

  res.json({ talks });
});

app.post("/schedule/:userId", (req, res) => {
  const { userId } = req.params;
  const talkId = String(req.body?.talkId ?? "").trim();
  if (!talkId) {
    return res.status(400).json({ error: "talkId is required" });
  }

  const talkExists = getTalks().some((talk) => talk.id === talkId);
  if (!talkExists) {
    return res.status(404).json({ error: "talk not found" });
  }

  const entry = addToSchedule(userId, talkId);
  return res.status(201).json({ entry });
});

app.delete("/schedule/:userId/:talkId", (req, res) => {
  const { userId, talkId } = req.params;
  const removed = removeFromSchedule(userId, talkId);
  if (!removed) {
    return res.status(404).json({ error: "schedule entry not found" });
  }
  return res.status(204).send();
});

app.get("/schedule/:userId/export.ics", (req, res) => {
  const { userId } = req.params;
  const talksById = new Map(getTalks().map((talk) => [talk.id, talk]));
  const talks = getUserSchedule(userId)
    .map((entry) => talksById.get(entry.talkId))
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
