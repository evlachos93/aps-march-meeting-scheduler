import talksJson from "../../../data/talks.json" with { type: "json" };
import sessionsJson from "../../../data/sessions.json" with { type: "json" };
import uiTopicsJson from "../../../data/ui-topics.json" with { type: "json" };
import dailySummariesJson from "../../../data/daily-summaries.json" with { type: "json" };
import type { DailySummary, DailySummariesPayload, ScheduleEntry, Session, SessionsPayload, Talk } from "./types.js";

type TalksPayload = {
  talks: Talk[];
};

const talks = Array.isArray(talksJson) ? (talksJson as Talk[]) : ((talksJson as TalksPayload).talks ?? []);
const sessions = (sessionsJson as SessionsPayload).sessions ?? [];

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
