import talksJson from "../../../data/talks.json" with { type: "json" };
import sessionsJson from "../../../data/sessions.json" with { type: "json" };
import uiTopicsJson from "../../../data/ui-topics.json" with { type: "json" };
import dailySummariesJson from "../../../data/daily-summaries.json" with { type: "json" };
import type { DailySummary, DailySummariesPayload, ScheduleEntry, Session, SessionsPayload, Talk } from "./types.js";

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
const rawSessions = (sessionsJson as SessionsPayload).sessions ?? [];

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
const scheduleByUser = new Map<string, Map<string, ScheduleEntry>>();

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

export function addToSchedule(userId: string, talkId: string): ScheduleEntry {
  const userSchedule = scheduleByUser.get(userId) ?? new Map<string, ScheduleEntry>();
  const entry: ScheduleEntry = { talkId, addedAt: new Date().toISOString() };
  userSchedule.set(talkId, entry);
  scheduleByUser.set(userId, userSchedule);
  return entry;
}

export function removeFromSchedule(userId: string, talkId: string): boolean {
  const userSchedule = scheduleByUser.get(userId);
  if (!userSchedule) {
    return false;
  }
  return userSchedule.delete(talkId);
}
