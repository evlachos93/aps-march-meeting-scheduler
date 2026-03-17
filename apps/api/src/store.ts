import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import talksJson from "../../../data/talks.json" with { type: "json" };
import sessionsJson from "../../../data/sessions.json" with { type: "json" };
import uiTopicsJson from "../../../data/ui-topics.json" with { type: "json" };
import dailySummariesJson from "../../../data/daily-summaries.json" with { type: "json" };
import type { DailySummary, DailySummariesPayload, ScheduleEntry, Session, SessionsPayload, Talk, TalkNote } from "./types.js";

type TalksPayload = {
  talks: Talk[];
};

const htmlEntityMap: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "..."
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (_match, entity) => {
    if (entity.startsWith("#x")) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? "" : String.fromCharCode(code);
    }
    if (entity.startsWith("#")) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? "" : String.fromCharCode(code);
    }
    return htmlEntityMap[entity] ?? " ";
  });
}

function normalizeTitleForLookup(value: string): string {
  const stripped = value.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(stripped);
  return decoded.replace(/\s+/g, " ").trim().toLowerCase();
}

const talks = Array.isArray(talksJson) ? (talksJson as Talk[]) : ((talksJson as TalksPayload).talks ?? []);
const rawSessions = (sessionsJson as unknown as SessionsPayload).sessions ?? [];

const talkTitleIndex = new Map<string, string>();
for (const talk of talks) {
  const key = normalizeTitleForLookup(talk.title);
  if (!talkTitleIndex.has(key)) {
    talkTitleIndex.set(key, talk.id);
  }
}

const sessions: Session[] = rawSessions.map((session) => {
  const talkIds = session.talkTitles
    .map((title) => talkTitleIndex.get(normalizeTitleForLookup(title)))
    .filter((id): id is string => Boolean(id));
  if (talkIds.length < session.talkTitles.length) {
    console.warn(
      `[store] Could not resolve ${session.talkTitles.length - talkIds.length} talk(s) for ${session.sessionCode}`
    );
  }
  return {
    ...session,
    talkIds
  };
});

type UiTopic = { label: string; value: string };
const uiTopics: UiTopic[] = Array.isArray(uiTopicsJson) ? (uiTopicsJson as UiTopic[]) : [];
const dailySummaries: Record<string, DailySummary> = ((dailySummariesJson as DailySummariesPayload).summaries ?? {});

// Persistent schedule storage
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scheduleFilePath = resolve(__dirname, "../../../data/schedule.json");

type SchedulePayload = {
  userSchedules: Record<string, ScheduleEntry[]>;
};

function loadScheduleFile(): Map<string, Map<string, ScheduleEntry>> {
  try {
    const content = readFileSync(scheduleFilePath, "utf-8");
    const payload: SchedulePayload = JSON.parse(content);
    const result = new Map<string, Map<string, ScheduleEntry>>();
    
    for (const [userId, entries] of Object.entries(payload.userSchedules ?? {})) {
      const userMap = new Map<string, ScheduleEntry>();
      for (const entry of entries) {
        const key = `${entry.type}:${entry.id}`;
        userMap.set(key, entry);
      }
      result.set(userId, userMap);
    }
    return result;
  } catch (err) {
    // File doesn't exist or is invalid; start fresh
    return new Map<string, Map<string, ScheduleEntry>>();
  }
}

function saveScheduleFile(scheduleByUser: Map<string, Map<string, ScheduleEntry>>): void {
  const userSchedules: Record<string, ScheduleEntry[]> = {};
  
  for (const [userId, userMap] of scheduleByUser.entries()) {
    userSchedules[userId] = Array.from(userMap.values());
  }
  
  const payload: SchedulePayload = { userSchedules };
  writeFileSync(scheduleFilePath, JSON.stringify(payload, null, 2), "utf-8");
}

const scheduleByUser = loadScheduleFile();

export function getTalks(): Talk[] {
  return talks;
}

export function getSessions(): Session[] {
  return sessions;
}

export function getUiTopics(): UiTopic[] {
  return uiTopics;
}

export function getDailySummaries(): Record<string, DailySummary> {
  return dailySummaries;
}

export function getDailySummary(date: string): DailySummary | undefined {
  return dailySummaries[date];
}

export function getUserSchedule(userId: string): ScheduleEntry[] {
  return [...(scheduleByUser.get(userId)?.values() ?? [])];
}

export function addToSchedule(userId: string, id: string, type: "talk" | "session"): ScheduleEntry {
  const userSchedule = scheduleByUser.get(userId) ?? new Map<string, ScheduleEntry>();
  const key = `${type}:${id}`;
  const entry: ScheduleEntry = { id, type, addedAt: new Date().toISOString() };
  userSchedule.set(key, entry);
  scheduleByUser.set(userId, userSchedule);
  saveScheduleFile(scheduleByUser);
  return entry;
}

export function removeFromSchedule(userId: string, id: string, type: "talk" | "session"): boolean {
  const userSchedule = scheduleByUser.get(userId);
  if (!userSchedule) {
    return false;
  }
  const key = `${type}:${id}`;
  const removed = userSchedule.delete(key);
  if (removed) {
    saveScheduleFile(scheduleByUser);
  }
  return removed;
}

// Persistent notes storage
const notesFilePath = resolve(__dirname, "../../../data/notes.json");

type NotesPayload = {
  userNotes: Record<string, Record<string, TalkNote>>;
};

function loadNotesFile(): Map<string, Map<string, TalkNote>> {
  try {
    const content = readFileSync(notesFilePath, "utf-8");
    const payload: NotesPayload = JSON.parse(content);
    const result = new Map<string, Map<string, TalkNote>>();
    for (const [userId, notes] of Object.entries(payload.userNotes ?? {})) {
      const userMap = new Map<string, TalkNote>();
      for (const [talkId, note] of Object.entries(notes)) {
        userMap.set(talkId, note);
      }
      result.set(userId, userMap);
    }
    return result;
  } catch {
    return new Map<string, Map<string, TalkNote>>();
  }
}

function saveNotesFile(notesByUser: Map<string, Map<string, TalkNote>>): void {
  const userNotes: Record<string, Record<string, TalkNote>> = {};
  for (const [userId, userMap] of notesByUser.entries()) {
    userNotes[userId] = Object.fromEntries(userMap.entries());
  }
  writeFileSync(notesFilePath, JSON.stringify({ userNotes }, null, 2), "utf-8");
}

const notesByUser = loadNotesFile();

export function getUserNotes(userId: string): Record<string, TalkNote> {
  return Object.fromEntries(notesByUser.get(userId)?.entries() ?? []);
}

export function setNote(userId: string, talkId: string, content: string): TalkNote {
  const userMap = notesByUser.get(userId) ?? new Map<string, TalkNote>();
  const note: TalkNote = { content, updatedAt: new Date().toISOString() };
  userMap.set(talkId, note);
  notesByUser.set(userId, userMap);
  saveNotesFile(notesByUser);
  return note;
}

export function deleteNote(userId: string, talkId: string): boolean {
  const userMap = notesByUser.get(userId);
  if (!userMap) return false;
  const removed = userMap.delete(talkId);
  if (removed) saveNotesFile(notesByUser);
  return removed;
}
