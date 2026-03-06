import talksJson from "../../../data/talks.sample.json" with { type: "json" };
import type { ScheduleEntry, Talk } from "./types.js";

const talks = talksJson as Talk[];
const scheduleByUser = new Map<string, Map<string, ScheduleEntry>>();

export function getTalks(): Talk[] {
  return talks;
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
