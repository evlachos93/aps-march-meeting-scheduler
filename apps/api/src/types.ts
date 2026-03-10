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
  talkId: string;
  addedAt: string;
};

export type Session = {
  sessionCode: string;
  title: string;
  url: string;
  sessionType: string;
  talkTitles: string[];
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
