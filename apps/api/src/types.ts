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

export type ScheduleEntry = {
  id: string;
  type: "talk" | "session";
  addedAt: string;
};

export type Session = {
  sessionCode: string;
  title: string;
  url: string;
  sessionType: string;
  talkTitles: string[];
  talkIds: string[];
  date?: string;
  weekday?: string;
  startTime?: string;
  endTime?: string;
  timeRange: string;
  room?: string;
  timingSource: "talks" | "none";
};

export type SessionsPayload = {
  sessions: Session[];
};

export type DailySummary = {
  date: string;
  weekday: string;
  overview: string;
  topTalkIds: string[];
};

export type DailySummariesPayload = {
  summaries: Record<string, DailySummary>;
};

export type AiSummaryTopic = {
  name: string;
  detail: string;
};

export type AiSummaryHighlight = {
  talkId?: string;
  title: string;
  reason: string;
};

export type AiSummary = {
  date: string;
  overview: string;
  topics: AiSummaryTopic[];
  highlights?: AiSummaryHighlight[];
};

export type AiSummaryResponse = {
  summary: AiSummary;
};

export type TalkNote = {
  content: string;
  updatedAt: string;
};
