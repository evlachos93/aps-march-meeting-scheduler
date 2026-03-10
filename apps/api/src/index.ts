import cors from "cors";
import express from "express";
import { buildIcs } from "./ics.js";
import { addToSchedule, getSessions, getTalks, getUiTopics, getUserSchedule, removeFromSchedule } from "./store.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "aps-api" });
});

app.get("/topics", (_req, res) => {
  res.json({ topics: getUiTopics() });
});

app.get("/talks", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const topic = String(req.query.topic ?? "").trim().toLowerCase();
  const track = String(req.query.track ?? "").trim().toLowerCase();
  const sortBy = String(req.query.sortBy ?? "time").trim().toLowerCase();

  console.log(`[API /talks] Filtering by q="${q}", topic="${topic}", track="${track}", sortBy="${sortBy}"`);

  const filtered = getTalks().filter((talk) => {
    const matchesQuery =
      !q ||
      talk.title.toLowerCase().includes(q) ||
      talk.abstract.toLowerCase().includes(q) ||
      talk.speakers.some((s) => s.toLowerCase().includes(q));
    const matchesTopic = !topic || talk.topics.some((t) => t.toLowerCase() === topic);
    const matchesTrack = !track || talk.track.toLowerCase() === track;
    return matchesQuery && matchesTopic && matchesTrack;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "title") {
      return a.title.localeCompare(b.title);
    }
    if (sortBy === "track") {
      const byTrack = a.track.localeCompare(b.track);
      if (byTrack !== 0) return byTrack;
    }
    return a.startTime.localeCompare(b.startTime);
  });

  res.json({ talks: sorted });
});

app.get("/sessions", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const sessionType = String(req.query.sessionType ?? "").trim().toLowerCase();
  const sortBy = String(req.query.sortBy ?? "time").trim().toLowerCase();

  console.log(`[API /sessions] Filtering by q="${q}", sessionType="${sessionType}", sortBy="${sortBy}"`);

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

    return matchesQuery && matchesType;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "title") {
      return a.title.localeCompare(b.title);
    }

    if (sortBy === "code") {
      return a.sessionCode.localeCompare(b.sessionCode);
    }

    if (sortBy === "talk-count") {
      return b.talkTitles.length - a.talkTitles.length;
    }

    const aTime = a.startTime ?? "9999-12-31T23:59:59Z";
    const bTime = b.startTime ?? "9999-12-31T23:59:59Z";
    const byTime = aTime.localeCompare(bTime);
    if (byTime !== 0) {
      return byTime;
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
