import type { Talk } from "./types.js";

function toUtcIcsDate(dateIso: string): string {
  return new Date(dateIso).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
}

export function buildIcs(userId: string, talks: Talk[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//APS Internal Scheduler//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];

  for (const talk of talks) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${talk.id}-${userId}@aps-internal`);
    lines.push(`DTSTAMP:${toUtcIcsDate(new Date().toISOString())}`);
    lines.push(`DTSTART:${toUtcIcsDate(talk.startTime)}`);
    lines.push(`DTEND:${toUtcIcsDate(talk.endTime)}`);
    lines.push(`SUMMARY:${escapeIcs(talk.title)}`);
    lines.push(`LOCATION:${escapeIcs(talk.room)}`);
    lines.push(`DESCRIPTION:${escapeIcs(talk.abstract)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
