import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getDayKey, parsePreferences, scoreTalk, withinPreferredHours } from "./planner.js";
import type { ParsedPreferences, ScoredTalk, Talk, TalksPayload } from "./planner.js";

type DaySchedule = {
  date: string;
  talkCount: number;
  talks: ScoredTalk[];
};

type GeneratedSchedule = {
  generatedAt: string;
  source: string;
  sourceTalkFile: string;
  preferencesFile: string;
  parsedPreferences: ParsedPreferences;
  summary: {
    totalTalksScheduled: number;
    daysCovered: number;
  };
  days: DaySchedule[];
};

const TALKS_PATH = new URL("../../../data/talks.generated.json", import.meta.url);
const PREFERENCES_PATH = new URL("../../../data/session-preferences.txt", import.meta.url);
const OUTPUT_PATH = new URL("../../../data/schedule.generated.json", import.meta.url);

function overlapsWithBreak(chosen: Talk, candidate: Talk, minBreakMinutes: number): boolean {
  const chosenStart = new Date(chosen.startTime).getTime();
  const chosenEnd = new Date(chosen.endTime).getTime();
  const candidateStart = new Date(candidate.startTime).getTime();
  const candidateEnd = new Date(candidate.endTime).getTime();

  const breakMs = minBreakMinutes * 60 * 1000;
  return !(candidateEnd <= chosenStart - breakMs || candidateStart >= chosenEnd + breakMs);
}

function buildSchedule(talks: Talk[], preferences: ParsedPreferences): DaySchedule[] {
  const talksByDay = new Map<string, Talk[]>();
  for (const talk of talks) {
    const dayKey = getDayKey(talk.startTime);
    const bucket = talksByDay.get(dayKey) ?? [];
    bucket.push(talk);
    talksByDay.set(dayKey, bucket);
  }

  const weekDays = [...talksByDay.keys()].sort().slice(0, 7);
  const result: DaySchedule[] = [];

  for (const day of weekDays) {
    const dayTalks = talksByDay.get(day) ?? [];

    const scored = dayTalks
      .map((talk) => {
        const { score, reasons } = scoreTalk(talk, preferences);
        return { ...talk, score, reasons };
      })
      .filter((talk) => withinPreferredHours(talk, preferences))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.startTime !== b.startTime) {
          return a.startTime.localeCompare(b.startTime);
        }
        return a.endTime.localeCompare(b.endTime);
      });

    const selected: ScoredTalk[] = [];
    for (const talk of scored) {
      if (selected.length >= preferences.maxTalksPerDay) {
        break;
      }

      if (talk.score <= 0) {
        continue;
      }

      const hasConflict = selected.some((picked) => overlapsWithBreak(picked, talk, preferences.minBreakMinutes));
      if (hasConflict) {
        continue;
      }

      selected.push(talk);
    }

    selected.sort((a, b) => a.startTime.localeCompare(b.startTime));
    result.push({
      date: day,
      talkCount: selected.length,
      talks: selected
    });
  }

  return result;
}

async function run(): Promise<void> {
  const talksPayloadRaw = await readFile(TALKS_PATH, "utf-8");
  const preferencesRaw = await readFile(PREFERENCES_PATH, "utf-8");

  const talksPayload = JSON.parse(talksPayloadRaw) as TalksPayload;
  if (!Array.isArray(talksPayload.talks) || talksPayload.talks.length === 0) {
    throw new Error("No talks found in talks.generated.json. Run the scraper first.");
  }

  const preferences = parsePreferences(preferencesRaw);
  const days = buildSchedule(talksPayload.talks, preferences);

  const totalTalksScheduled = days.reduce((acc, day) => acc + day.talkCount, 0);
  const output: GeneratedSchedule = {
    generatedAt: new Date().toISOString(),
    source: talksPayload.source,
    sourceTalkFile: "data/talks.generated.json",
    preferencesFile: "data/session-preferences.txt",
    parsedPreferences: preferences,
    summary: {
      totalTalksScheduled,
      daysCovered: days.length
    },
    days
  };

  await mkdir(new URL("../../../data/", import.meta.url), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

  console.log("schedule generated", {
    daysCovered: output.summary.daysCovered,
    totalTalksScheduled: output.summary.totalTalksScheduled,
    outputPath: OUTPUT_PATH.pathname
  });
}

run().catch((error) => {
  console.error("schedule generation failed", error);
  process.exitCode = 1;
});
