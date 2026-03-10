export type Talk = {
  id: string;
  title: string;
  abstract: string;
  speakers: string[];
  track: string;
  topics: string[];
  room: string;
  startTime: string;
  endTime: string;
  sourceUrl?: string;
};

export type TalksPayload = {
  source: string;
  fetchedAt: string;
  talkCount: number;
  talks: Talk[];
};

export type ParsedPreferences = {
  preferredPhrases: string[];
  preferredTags: string[];
  hardwareArchitectures: string[];
  avoidPhrases: string[];
  maxTalksPerDay: number;
  dayStartMinutes?: number;
  dayEndMinutes?: number;
  minBreakMinutes: number;
};

export type ScoredTalk = Talk & {
  score: number;
  reasons: string[];
};

const DEFAULT_MAX_TALKS_PER_DAY = 4;
const DEFAULT_MIN_BREAK_MINUTES = 15;
const MEETING_TIME_ZONE = process.env.SCHEDULE_TIME_ZONE ?? "America/Denver";

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-+/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toMinutes(timeValue: string): number | undefined {
  const match = timeValue.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) {
    return undefined;
  }

  const hourRaw = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();

  if (Number.isNaN(hourRaw) || Number.isNaN(minute) || minute < 0 || minute > 59) {
    return undefined;
  }

  if (meridiem) {
    if (hourRaw < 1 || hourRaw > 12) {
      return undefined;
    }
    const hour24 = (hourRaw % 12) + (meridiem === "pm" ? 12 : 0);
    return hour24 * 60 + minute;
  }

  if (hourRaw < 0 || hourRaw > 23) {
    return undefined;
  }

  return hourRaw * 60 + minute;
}

function splitPhrases(raw: string): string[] {
  return raw
    .split(/,|;|\||\band\b|\bor\b/i)
    .map((part) => normalize(part))
    .filter((part) => part.length >= 3)
    .filter((part) => !/\d/.test(part))
    .filter((part) => !/\b(?:am|pm|between|before|after)\b/.test(part))
    .filter((part) => !["talks", "sessions", "physics", "user"].includes(part));
}

function singularizePhrase(phrase: string): string | undefined {
  if (!phrase.endsWith("s")) {
    return undefined;
  }

  const words = phrase.split(" ");
  const last = words[words.length - 1] ?? "";
  if (last.length <= 3 || !last.endsWith("s") || last.endsWith("ss")) {
    return undefined;
  }

  words[words.length - 1] = last.slice(0, -1);
  const singular = normalize(words.join(" "));
  return singular && singular !== phrase ? singular : undefined;
}

function augmentPreferredPhrases(rawPhrases: Iterable<string>): string[] {
  const augmented = new Set<string>();
  const aliasMap: Record<string, string[]> = {
    qec: ["error correction", "fault tolerance", "logical qubit"],
    "error correction": ["qec", "fault tolerance", "logical qubit"],
    "fault tolerance": ["error correction", "qec", "logical qubit"],
    "superconducting qubit": ["transmon", "superconducting qubits"],
    "superconducting qubits": ["transmon", "superconducting qubit"],
    transmon: ["superconducting qubit", "superconducting qubits", "circuit qed"],
    "circuit qed": ["superconducting qubit", "transmon"],
    "trapped ion": ["trapped ions"],
    "trapped ions": ["trapped ion"],
    "ion trap": ["trapped ion", "trapped ions"],
    "neutral atom": ["neutral atoms"],
    "neutral atoms": ["neutral atom"],
    rydberg: ["neutral atom", "neutral atoms"],
    photonic: ["photonic quantum computing", "linear optics"],
    "photonic quantum computing": ["photonic", "linear optics"],
    "linear optics": ["photonic", "photonic quantum computing"],
    "spin qubit": ["spin qubits"],
    "spin qubits": ["spin qubit"],
    "quantum error correction": ["error correction", "qec"],
    "quantum computing": ["quantum information", "quantum hardware"]
  };

  for (const phrase of rawPhrases) {
    const normalized = normalize(phrase);
    if (!normalized) {
      continue;
    }

    augmented.add(normalized);

    const singular = singularizePhrase(normalized);
    if (singular) {
      augmented.add(singular);
    }

    for (const alias of aliasMap[normalized] ?? []) {
      const normalizedAlias = normalize(alias);
      if (normalizedAlias) {
        augmented.add(normalizedAlias);
      }
    }
  }

  return [...augmented];
}

function parsePreferredTagLine(line: string): string[] {
  const cleaned = line.replace(/^[-*]\s*/, "").trim();
  const match = cleaned.match(/^(?:tags?|preferred[\s_-]*tags?|preferred[\s_-]*phrases?|preffered[\s_-]*phrases?)\s*[:=]\s*(.+)$/i);
  if (!match?.[1]) {
    return [];
  }
  return splitPhrases(match[1]);
}

function parseHashtagPhrases(line: string): string[] {
  const hashtags = line.match(/#[a-z0-9][a-z0-9+\-/]*/gi) ?? [];
  return hashtags
    .map((tag) => normalize(tag.slice(1).replace(/[-_]/g, " ")))
    .filter((phrase) => phrase.length >= 3);
}

function parseHardwareArchitectureLine(line: string): string[] {
  const cleaned = line.replace(/^[-*]\s*/, "").trim();
  const match = cleaned.match(
    /^(?:architectures?|hardware(?:[\s_-]*architectures?)?|quantum(?:[\s_-]*hardware)?(?:[\s_-]*architectures?)?)\s*[:=]\s*(.+)$/i
  );
  if (!match?.[1]) {
    return [];
  }
  return splitPhrases(match[1]);
}

export function parsePreferences(input: string): ParsedPreferences {
  const preferred = new Set<string>();
  const preferredTags = new Set<string>();
  const hardwareArchitectures = new Set<string>();
  const avoid = new Set<string>();
  const lower = input.toLowerCase();

  const preferencePatterns = [
    /(?:^|\b)i\s+(?:am\s+)?(?:also\s+)?interested in\s+(.+)/i,
    /(?:^|\b)i\s+(?:would\s+)?(?:really\s+)?like\s+(.+)/i,
    /(?:^|\b)i\s+(?:also\s+)?want\s+(?:to\s+)?(?:focus on\s+)?(.+)/i,
    /(?:^|\b)(?:prefer|focus on|prioritize|prioritise)\s+(.+)/i
  ];

  const avoidPatterns = [
    /(?:^|\b)please\s+avoid\s+(.+)/i,
    /(?:^|\b)i\s+want\s+to\s+avoid\s+(.+)/i,
    /(?:^|\b)(?:avoid|skip|exclude|not interested in)\s+(.+)/i
  ];

  for (const lineRaw of input.split("\n")) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    for (const phrase of parsePreferredTagLine(line)) {
      preferredTags.add(phrase);
    }
    for (const phrase of parseHashtagPhrases(line)) {
      preferredTags.add(phrase);
    }
    for (const architecture of parseHardwareArchitectureLine(line)) {
      hardwareArchitectures.add(architecture);
    }

    for (const pattern of preferencePatterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        for (const phrase of splitPhrases(match[1])) {
          preferred.add(phrase);
        }
        break;
      }
    }

    for (const pattern of avoidPatterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        for (const phrase of splitPhrases(match[1])) {
          avoid.add(phrase);
        }
        break;
      }
    }
  }

  const betweenMatch = lower.match(/between\s+([0-9: ]+(?:am|pm)?)\s+(?:and|to|-)\s+([0-9: ]+(?:am|pm)?)/i);
  const dayStartMinutes = betweenMatch ? toMinutes(betweenMatch[1].trim()) : undefined;
  const dayEndMinutes = betweenMatch ? toMinutes(betweenMatch[2].trim()) : undefined;

  const maxTalksMatch =
    lower.match(/(?:at most|no more than|max(?:imum)?(?: of)?)\s+(\d+)\s+(?:talks?|sessions?)(?:\s+per\s+day)?/) ??
    lower.match(/(\d+)\s+(?:talks?|sessions?)\s+per\s+day/);

  const minBreakMatch =
    lower.match(/(?:at least|minimum of?)\s+(\d+)\s*(?:minutes?|mins?)\s*(?:break|gap)/) ??
    lower.match(/(\d+)\s*(?:minutes?|mins?)\s*(?:break|gap)/);

  if (preferred.size === 0) {
    for (const fallback of ["quantum computing", "qubit", "error correction", "quantum control"]) {
      preferred.add(fallback);
    }
  }

  const preferredPhrases = augmentPreferredPhrases([...preferred, ...preferredTags, ...hardwareArchitectures]);

  return {
    preferredPhrases,
    preferredTags: [...preferredTags],
    hardwareArchitectures: [...hardwareArchitectures],
    avoidPhrases: [...avoid],
    maxTalksPerDay: Number(maxTalksMatch?.[1] ?? DEFAULT_MAX_TALKS_PER_DAY),
    dayStartMinutes,
    dayEndMinutes,
    minBreakMinutes: Number(minBreakMatch?.[1] ?? DEFAULT_MIN_BREAK_MINUTES)
  };
}

export function getDayKey(iso: string): string {
  const date = new Date(iso);
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEETING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = dateParts.find((part) => part.type === "year")?.value;
  const month = dateParts.find((part) => part.type === "month")?.value;
  const day = dateParts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return iso.slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

function minutesIntoMeetingDay(iso: string): number {
  const date = new Date(iso);
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: MEETING_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const hour = Number(timeParts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(timeParts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function withinPreferredHours(talk: Talk, preferences: ParsedPreferences): boolean {
  const start = minutesIntoMeetingDay(talk.startTime);
  const end = minutesIntoMeetingDay(talk.endTime);

  if (preferences.dayStartMinutes !== undefined && start < preferences.dayStartMinutes) {
    return false;
  }

  if (preferences.dayEndMinutes !== undefined && end > preferences.dayEndMinutes) {
    return false;
  }

  return true;
}

export function scoreTalk(talk: Talk, preferences: ParsedPreferences): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const searchable = normalize([talk.title, talk.abstract, talk.track, ...talk.topics].join(" "));
  const topicSet = new Set(talk.topics.map((topic) => normalize(topic)));

  for (const phrase of preferences.preferredPhrases) {
    const normalizedPhrase = normalize(phrase);
    if (!normalizedPhrase) {
      continue;
    }

    if (topicSet.has(normalizedPhrase)) {
      score += 2;
      reasons.push(`topic match: ${normalizedPhrase}`);
      continue;
    }

    if (searchable.includes(normalizedPhrase)) {
      score += 1;
      reasons.push(`keyword match: ${normalizedPhrase}`);
    }
  }

  for (const phrase of preferences.avoidPhrases) {
    const normalizedPhrase = normalize(phrase);
    if (!normalizedPhrase) {
      continue;
    }

    if (topicSet.has(normalizedPhrase)) {
      score -= 10;
      reasons.push(`avoid topic: ${normalizedPhrase}`);
      continue;
    }

    if (searchable.includes(normalizedPhrase)) {
      score -= 8;
      reasons.push(`avoid keyword: ${normalizedPhrase}`);
    }
  }

  return { score, reasons };
}
