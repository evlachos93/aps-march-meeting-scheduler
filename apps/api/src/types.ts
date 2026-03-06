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
};

export type ScheduleEntry = {
  talkId: string;
  addedAt: string;
};
