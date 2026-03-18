import "./styles.css";
import DOMPurify from "dompurify";
import { marked } from "marked";

type Author = {
  name: string;
  affiliations: string[];
};

type Talk = {
  id: string;
  title: string;
  abstract: string;
  speakers: string[];
  authors: Author[];
  presenter: string;
  track: string;
  topics: string[];
  room: string;
  startTime: string;
  endTime: string;
  weekday?: string;
  sourceUrl?: string;
};

type Session = {
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
};

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8787";
const USER_ID = "internal-demo";

// In-memory note cache; populated from API on init and kept in sync on save/delete
const talkNotes = new Map<string, string>();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");

app.innerHTML = `
  <div class="app-layout">
    <aside class="summary-column hidden">
      <div id="summary-card" class="summary-card hidden">
        <div class="summary-card-header">
          <div>
            <p class="summary-card-label">AI insight</p>
            <h2>Daily overview</h2>
          </div>
          <div class="summary-card-header-actions">
            <span id="summary-card-state" class="summary-card-state"></span>
            <button id="summary-hide" class="summary-hide-btn" type="button" title="Hide summary">&#x2212;</button>
          </div>
        </div>
        <div id="summary-collapsible">
          <div class="summary-card-controls">
            <label for="summary-date-select">Day</label>
            <select id="summary-date-select">
              <option value="">Select a day</option>
            </select>
            <button id="summary-generate" type="button" disabled>Generate AI summary</button>
          </div>
          <p id="summary-card-message" class="summary-card-message">Checking AI summary availability…</p>
          <div id="summary-result" class="summary-panel hidden"></div>
        </div>
      </div>
    </aside>
    <main class="content-column">
      <h1>APS Internal Scheduler</h1>
      <div class="panel row">
        <div class="view-toggle" role="group" aria-label="View selector">
          <button type="button" class="view-button active" data-view="talks">Talks</button>
          <button type="button" class="view-button" data-view="sessions">Sessions</button>
        </div>
        <input id="query" placeholder="Search talks" />
        <div class="time-filter-group">
          <label>
            <input type="radio" name="timeSlot" value="all" checked /> All times
          </label>
          <label>
            <input type="radio" name="timeSlot" value="morning" /> 8-11am
          </label>
          <label>
            <input type="radio" name="timeSlot" value="afternoon" /> 11am-2pm
          </label>
          <label>
            <input type="radio" name="timeSlot" value="lateafternoon" /> 2pm-midnight
          </label>
        </div>
        <div class="topic-dropdown" id="topic-filter">
          <button
            type="button"
            id="topic-toggle"
            class="topic-toggle-button"
            aria-haspopup="true"
            aria-expanded="false"
          >
            <span id="topic-toggle-label">Topics: All</span>
            <span aria-hidden="true" class="topic-toggle-icon">▾</span>
          </button>
          <div id="topic-panel" class="topic-dropdown-panel hidden">
            <div class="topic-dropdown-header">
              <span>Topics</span>
              <button type="button" id="topic-clear" class="topic-clear">Clear</button>
            </div>
            <div id="topic-options" class="topic-options"></div>
          </div>
        </div>
        <select id="day">
          <option value="">All days</option>
          <option value="sunday">Sunday</option>
          <option value="monday">Monday</option>
          <option value="tuesday">Tuesday</option>
          <option value="wednesday">Wednesday</option>
          <option value="thursday">Thursday</option>
          <option value="friday">Friday</option>
          <option value="saturday">Saturday</option>
        </select>
        <select id="track">
          <option value="">All tracks</option>
          <option value="INVITED">Invited</option>
          <option value="FOCUS">Focus</option>
          <option value="ORAL">Oral</option>
          <option value="POSTER">Poster</option>
        </select>
        <select id="sessionType">
          <option value="">All session types</option>
          <option value="INVITED">Invited</option>
          <option value="FOCUS">Focus</option>
          <option value="ORAL">Oral</option>
          <option value="POSTER">Poster</option>
        </select>
        <button id="load">Find</button>
      </div>
      <div id="stats" class="stats"></div>
      <div id="talks"></div>
    </main>
    <aside class="schedule-panel">
      <div class="schedule-header">
        <div>
          <h2>My Schedule</h2>
          <p class="schedule-subtitle">All your saved talks stay here.</p>
        </div>
        <span id="schedule-count">0 talks</span>
      </div>
      <div class="schedule-filters">
        <select id="schedule-day">
          <option value="">All days</option>
          <option value="sunday">Sunday</option>
          <option value="monday">Monday</option>
          <option value="tuesday">Tuesday</option>
          <option value="wednesday">Wednesday</option>
          <option value="thursday">Thursday</option>
          <option value="friday">Friday</option>
          <option value="saturday">Saturday</option>
        </select>
        <div class="schedule-type-toggle" role="group" aria-label="Schedule type filter">
          <button type="button" class="schedule-type-button active" data-type="talk">Talks</button>
          <button type="button" class="schedule-type-button active" data-type="session">Sessions</button>
        </div>
      </div>
      <div id="schedule-list" class="schedule-list"></div>
      <button id="export" class="schedule-export">Export .ics</button>
    </aside>
  </div>
`;

const talksContainer = document.querySelector<HTMLDivElement>("#talks")!;
const statsContainer = document.querySelector<HTMLDivElement>("#stats")!;
const summaryCard = document.querySelector<HTMLDivElement>("#summary-card")!;
const summaryDateSelect = document.querySelector<HTMLSelectElement>("#summary-date-select")!;
const summaryGenerateButton = document.querySelector<HTMLButtonElement>("#summary-generate")!;
const summaryCardState = document.querySelector<HTMLSpanElement>("#summary-card-state")!;
const summaryCardMessage = document.querySelector<HTMLParagraphElement>("#summary-card-message")!;
const summaryResult = document.querySelector<HTMLDivElement>("#summary-result")!;
const scheduleContainer = document.querySelector<HTMLDivElement>("#schedule-list")!;
const scheduleCount = document.querySelector<HTMLSpanElement>("#schedule-count")!;
const scheduleDaySelect = document.querySelector<HTMLSelectElement>("#schedule-day")!;
const scheduleTypeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".schedule-type-button"));
const scheduleTypeState: Record<"talk" | "session", boolean> = { talk: true, session: true };
if (
  !talksContainer ||
  !statsContainer ||
  !scheduleContainer ||
  !scheduleCount ||
  !scheduleDaySelect ||
  !scheduleTypeButtons.length
) {
  throw new Error("App layout rendered without required sections");
}

const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".view-button"));
const queryInput = document.querySelector<HTMLInputElement>("#query")!;
const topicFilterContainer = document.querySelector<HTMLDivElement>("#topic-filter")!;
const topicToggleButton = document.querySelector<HTMLButtonElement>("#topic-toggle")!;
const topicToggleLabel = document.querySelector<HTMLSpanElement>("#topic-toggle-label")!;
const topicPanel = document.querySelector<HTMLDivElement>("#topic-panel")!;
const topicOptions = document.querySelector<HTMLDivElement>("#topic-options")!;
const topicClearButton = document.querySelector<HTMLButtonElement>("#topic-clear")!;
const daySelect = document.querySelector<HTMLSelectElement>("#day")!;
const trackSelect = document.querySelector<HTMLSelectElement>("#track")!;
const sessionTypeSelect = document.querySelector<HTMLSelectElement>("#sessionType")!;
const timeSlotRadios = document.querySelectorAll<HTMLInputElement>("input[name=\"timeSlot\"]");
const topicLabels = new Map<string, string>();
let currentView: 'talks' | 'sessions' = 'talks';

if (
  !viewButtons.length ||
  !queryInput ||
  !topicFilterContainer ||
  !topicToggleButton ||
  !topicToggleLabel ||
  !topicPanel ||
  !topicOptions ||
  !topicClearButton ||
  !daySelect ||
  !trackSelect ||
  !sessionTypeSelect
) {
  throw new Error("Missing UI controls");
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "TBD";
  }
  return new Date(value).toLocaleString();
}

function getSelectedTimeSlot(): string {
  const checked = document.querySelector<HTMLInputElement>("input[name=\"timeSlot\"]:checked");
  return checked?.value ?? "all";
}

function getDateFromTimestamp(startTime?: string): string {
  if (!startTime) return "unknown";
  const match = startTime.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "unknown";
}

function formatDate(dateStr: string): string {
  if (dateStr === "unknown") return "Unknown date";
  const parts = dateStr.split("-").map((segment) => Number(segment));
  if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {
    return dateStr;
  }
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function normalizeWeekdayLabel(value?: string): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (WEEKDAY_NAMES.includes(normalized)) {
    return normalized;
  }
  const prefix = normalized.slice(0, 3);
  return WEEKDAY_NAMES.find((name) => name.startsWith(prefix)) ?? null;
}

function getWeekdayLabelFromTimestamp(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return WEEKDAY_NAMES[date.getUTCDay()];
}

function getTalkWeekdayLabel(talk: Talk): string | null {
  return normalizeWeekdayLabel(talk.weekday) ?? getWeekdayLabelFromTimestamp(talk.startTime);
}

function getSessionWeekdayLabel(session: Session): string | null {
  return normalizeWeekdayLabel(session.weekday) ?? getWeekdayLabelFromTimestamp(session.startTime);
}

function matchesScheduleDay(filter: string, itemWeekday: string | null): boolean {
  if (!filter) return true;
  return Boolean(itemWeekday && itemWeekday === filter);
}

function renderMarkdownPreview(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "<p class=\"note-preview-empty\">Preview your note as Markdown once you start typing.</p>";
  }
  const html = marked.parse(trimmed, { gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}

function updateNotePreview(talkId: string, content: string): void {
  const preview = document.querySelector<HTMLDivElement>(`.note-markdown-preview[data-note-preview=\"${talkId}\"]`);
  if (!preview) {
    return;
  }
  preview.innerHTML = renderMarkdownPreview(content);
}

function getSelectedTopics(): string[] {
  return Array.from(topicOptions.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")).map((input) => input.value);
}

function updateTopicButtonLabel(): void {
  const selected = getSelectedTopics();
  if (!selected.length) {
    topicToggleLabel.textContent = "Topics: All";
  } else if (selected.length === 1) {
    const label = topicLabels.get(selected[0]) ?? selected[0];
    topicToggleLabel.textContent = `Topics: ${label}`;
  } else {
    topicToggleLabel.textContent = `Topics (${selected.length})`;
  }
}

function openTopicPanel(): void {
  topicPanel.classList.remove("hidden");
  topicToggleButton.setAttribute("aria-expanded", "true");
}

function closeTopicPanel(): void {
  topicPanel.classList.add("hidden");
  topicToggleButton.setAttribute("aria-expanded", "false");
}

function toggleTopicPanel(): void {
  if (topicPanel.classList.contains("hidden")) {
    openTopicPanel();
  } else {
    closeTopicPanel();
  }
}

function clearTopicSelection(): void {
  topicOptions.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((input) => {
    input.checked = false;
  });
  updateTopicButtonLabel();
}

function setView(view: "talks" | "sessions"): void {
  currentView = view;
  viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const showingTalks = view === "talks";
  topicFilterContainer.classList.toggle("hidden", !showingTalks);
  if (!showingTalks) {
    closeTopicPanel();
  }
  trackSelect.style.display = showingTalks ? "" : "none";
  sessionTypeSelect.style.display = showingTalks ? "none" : "";
  queryInput.placeholder = showingTalks ? "Search talks" : "Search sessions";
}

async function loadSchedule(): Promise<void> {
  scheduleContainer.innerHTML = `<div class="schedule-loading">Loading schedule...</div>`;
  try {
    const response = await fetch(`${API_BASE}/schedule/${USER_ID}`);
    if (!response.ok) {
      throw new Error("schedule request failed");
    }
    const payload = (await response.json()) as { talks?: Talk[]; sessions?: Session[] };
    const savedTalks = Array.isArray(payload.talks) ? payload.talks : [];
    const savedSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    const hasSavedItems = savedTalks.length + savedSessions.length > 0;
    const dayFilterValue = scheduleDaySelect.value;
    const filteredTalks = scheduleTypeState.talk
      ? savedTalks.filter((talk) => matchesScheduleDay(dayFilterValue, getTalkWeekdayLabel(talk)))
      : [];
    const filteredSessions = scheduleTypeState.session
      ? savedSessions.filter((session) => matchesScheduleDay(dayFilterValue, getSessionWeekdayLabel(session)))
      : [];
    const displayedCount = filteredTalks.length + filteredSessions.length;

    scheduleCount.textContent = `${displayedCount} item${displayedCount === 1 ? "" : "s"}`;

    if (!displayedCount) {
      const message = hasSavedItems
        ? "No talks or sessions match the filters."
        : "No talks or sessions saved yet. Use the buttons on the left to build your agenda.";
      scheduleContainer.innerHTML = `
        <div class="schedule-empty">
          ${message}
        </div>
      `;
      return;
    }

    const talkItems = filteredTalks
      .map(
        (talk) => `
          <article class="schedule-item schedule-item-talk">
            <div>
              <p class="schedule-item-title">${escapeHtml(talk.title)}</p>
              <p class="schedule-item-meta">
                ${escapeHtml(talk.track)} | ${escapeHtml(formatDateTime(talk.startTime))}
              </p>
              <p class="schedule-item-room">${escapeHtml(talk.room)}</p>
              <a
                href="${buildGCalUrl(talk.title, talk.startTime, talk.endTime, talk.room, talk.abstract.slice(0, 200))}"
                target="_blank"
                rel="noopener noreferrer"
                class="gcal-link gcal-link-sm"
              >Add to Google Calendar</a>
            </div>
            <button
              class="schedule-action remove-schedule"
              type="button"
              data-item-id="${talk.id}"
              data-item-type="talk"
            >
              Remove
            </button>
          </article>
        `
      )
      .join("\n");

    const sessionItems = filteredSessions
      .map(
        (session) => `
          <article class="schedule-item schedule-item-session">
            <div>
              <p class="schedule-item-title">${escapeHtml(session.title)}</p>
              <p class="schedule-item-meta">
                ${escapeHtml(session.sessionType)} | ${escapeHtml(session.timeRange)}
              </p>
              <p class="schedule-item-room">${escapeHtml(session.room || "Room TBD")}</p>
              ${session.startTime && session.endTime ? `<a
                href="${buildGCalUrl(session.title, session.startTime, session.endTime, session.room ?? '', session.talkTitles.length + ' talks\n' + session.url)}"
                target="_blank"
                rel="noopener noreferrer"
                class="gcal-link gcal-link-sm"
              >Add to Google Calendar</a>` : ''}
            </div>
            <button
              class="schedule-action remove-schedule"
              type="button"
              data-item-id="${session.sessionCode}"
              data-item-type="session"
            >
              Remove
            </button>
          </article>
        `
      )
      .join("\n");

    scheduleContainer.innerHTML = talkItems + sessionItems;
  } catch (err) {
    console.warn("[loadSchedule]", err);
    scheduleCount.textContent = "0 items";
    scheduleContainer.innerHTML = `<div class="schedule-error">Couldn\'t load your schedule yet.</div>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadNotes(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/notes/${USER_ID}`);
    if (!response.ok) return;
    const payload = (await response.json()) as { notes: Record<string, { content: string }> };
    talkNotes.clear();
    for (const [talkId, note] of Object.entries(payload.notes)) {
      talkNotes.set(talkId, note.content);
    }
  } catch (err) {
    console.warn("[loadNotes]", err);
  }
}

async function saveNote(talkId: string, content: string): Promise<void> {
  if (content.trim()) {
    await fetch(`${API_BASE}/notes/${USER_ID}/${encodeURIComponent(talkId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.trim() })
    });
    talkNotes.set(talkId, content.trim());
  } else {
    await fetch(`${API_BASE}/notes/${USER_ID}/${encodeURIComponent(talkId)}`, { method: "DELETE" });
    talkNotes.delete(talkId);
  }
}

function buildGCalUrl(title: string, startTime: string, endTime: string, location: string, details: string): string {
  const toGCalDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${toGCalDate(startTime)}/${toGCalDate(endTime)}`,
    location,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function loadTalks(): Promise<void> {
  const query = queryInput.value.trim();
  const day = daySelect.value.trim();
  const track = trackSelect.value.trim();
  const timeSlot = getSelectedTimeSlot();
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const selectedTopics = getSelectedTopics();
  if (selectedTopics.length) params.set("topics", selectedTopics.join(","));
  if (day) params.set("day", day);
  if (track) params.set("track", track);
  if (timeSlot !== "all") params.set("timeSlot", timeSlot);

  const url = `${API_BASE}/talks?${params.toString()}`;
  console.log(`[loadTalks] Fetching: ${url}`);
  const response = await fetch(url);
  const payload = (await response.json()) as { talks: Talk[] };
  console.log(`[loadTalks] Received ${payload.talks.length} talks`);
  statsContainer.textContent = `${payload.talks.length} talk${payload.talks.length === 1 ? "" : "s"} found`;

  // Group talks by date
  const talksByDate = new Map<string, Talk[]>();
  for (const talk of payload.talks) {
    const date = getDateFromTimestamp(talk.startTime);
    if (!talksByDate.has(date)) {
      talksByDate.set(date, []);
    }
    talksByDate.get(date)!.push(talk);
  }

  // Render grouped talks with date headers
  const html = Array.from(talksByDate.entries())
    .map(([date, talks]) => {
      const talksId = `talks-${date}`;
      const talksHtml = talks
        .map((talk) => {
          const existingNote = talkNotes.get(talk.id) ?? "";
          const hasNote = Boolean(existingNote);
          return `
          <div class="panel">
            <div class="talk-title">${talk.sourceUrl ? `<a href="${talk.sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(talk.title)}</a>` : escapeHtml(talk.title)}</div>
            ${talk.authors?.length ? `<div class="talk-authors">${talk.authors.map((a) => `<span class="talk-author">${escapeHtml(a.name)}${a.affiliations.length ? `<span class="talk-affiliation">${escapeHtml(a.affiliations[0]!)}</span>` : ""}</span>`).join("")}</div>` : ""}
            <div>${escapeHtml(talk.track)} | ${formatDateTime(talk.startTime)}</div>
            <div>${talk.room}</div>
            <p>${talk.abstract}</p>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
              <button data-talk-id="${talk.id}" class="save">Add to My Schedule</button>
              <a
                href="${buildGCalUrl(talk.title, talk.startTime, talk.endTime, talk.room, talk.abstract.slice(0, 200) + (talk.sourceUrl ? '\n' + talk.sourceUrl : ''))}"
                target="_blank"
                rel="noopener noreferrer"
                class="gcal-link"
              >Add to Google Calendar</a>
              <button class="note-toggle" data-talk-id="${talk.id}" type="button">${hasNote ? "\uD83D\uDCDD Edit note" : "\uD83D\uDCDD Add note"}</button>
            </div>
            <div class="note-area${hasNote ? "" : " hidden"}">
              <textarea class="note-textarea" data-talk-id="${talk.id}" placeholder="Your private note…" rows="3">${escapeHtml(existingNote)}</textarea>
              <span class="note-save-state"></span>
              <button type="button" class="note-preview-toggle" data-preview-target="${talk.id}" aria-expanded="false">Show Markdown preview</button>
              <div class="note-markdown-preview hidden" data-note-preview="${talk.id}">${renderMarkdownPreview(existingNote)}</div>
            </div>
          </div>
        `;
        })
        .join("");

      return `
        <div class="day-section">
          <div class="day-header">
            <h2>${formatDate(date)}</h2>
          </div>
          <div id="${talksId}" class="talks-list">${talksHtml}</div>
        </div>
      `;
    })
    .join("");

  refreshSummaryOptions(Array.from(talksByDate.keys()));
  talksContainer.innerHTML = html;
}

async function loadSessions(): Promise<void> {
  const query = queryInput.value.trim();
  const sessionType = sessionTypeSelect.value.trim();
  const day = daySelect.value.trim();
  const timeSlot = getSelectedTimeSlot();
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (sessionType) params.set("sessionType", sessionType);
  if (day) params.set("day", day);
  if (timeSlot !== "all") params.set("timeSlot", timeSlot);

  const url = `${API_BASE}/sessions?${params.toString()}`;
  console.log(`[loadSessions] Fetching: ${url}`);
  const response = await fetch(url);
  const payload = (await response.json()) as { sessions: Session[] };
  console.log(`[loadSessions] Received ${payload.sessions.length} sessions`);
  statsContainer.textContent = `${payload.sessions.length} session${payload.sessions.length === 1 ? "" : "s"} found`;

  // Group sessions by date
  const sessionsByDate = new Map<string, Session[]>();
  for (const session of payload.sessions) {
    const date = getDateFromTimestamp(session.startTime);
    if (!sessionsByDate.has(date)) {
      sessionsByDate.set(date, []);
    }
    sessionsByDate.get(date)!.push(session);
  }

  // Render grouped sessions with date headers
  const html = Array.from(sessionsByDate.entries())
    .map(([date, sessions]) => {
      const sessionsId = `sessions-${date}`;
      const sessionsHtml = sessions
        .map((session, index) => {
          const detailsId = `session-talks-${date}-${index}`;
          const talksList = session.talkTitles
            .map((title) => `<li>${escapeHtml(title)}</li>`)
            .join("");

          return `
          <div class="panel">
            <div class="talk-title">${session.title}</div>
            <div>${session.sessionType} | ${session.weekday ?? ""} ${session.timeRange}</div>
            <div>${session.room ?? "Room TBD"}</div>
            <div><a href="${session.url}" target="_blank" rel="noopener noreferrer">${session.sessionCode} ↗</a></div>
            <p>${session.talkTitles.length} talks in session</p>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
              <button
                class="session-talks-toggle"
                data-target-id="${detailsId}"
                data-expanded="false"
                type="button"
              >Show talks</button>
              <button
                class="save-session"
                type="button"
                data-session-code="${session.sessionCode}"
              >Add to My Schedule</button>
              ${session.startTime && session.endTime ? `<a
                href="${buildGCalUrl(session.title, session.startTime, session.endTime, session.room ?? '', session.talkTitles.length + ' talks\n' + session.url)}"
                target="_blank"
                rel="noopener noreferrer"
                class="gcal-link"
              >Add to Google Calendar</a>` : ''}
            </div>
            <div id="${detailsId}" class="session-talks hidden">
              <ul>${talksList}</ul>
            </div>
          </div>
        `;
        })
        .join("");

      return `
        <div class="day-section">
          <div class="day-header">
            <h2>${formatDate(date)}</h2>
          </div>
          <div id="${sessionsId}" class="sessions-list">${sessionsHtml}</div>
        </div>
      `;
    })
    .join("");

  talksContainer.innerHTML = html;
}

async function loadCurrentView(): Promise<void> {
  if (currentView === "sessions") {
    await loadSessions();
    return;
  }
  await loadTalks();
}

type AiSummaryPayload = {
  overview: string;
  topics: { name: string; detail: string }[];
  highlights?: { title: string; reason: string; talkId?: string }[];
};

type SummaryResponse = {
  summary: AiSummaryPayload;
};

let summaryEnabled = false;
let isGeneratingSummary = false;

function updateSummaryButtonState(): void {
  const hasDate = Boolean(summaryDateSelect.value);
  summaryGenerateButton.disabled = !summaryEnabled || isGeneratingSummary || !hasDate;
  summaryDateSelect.disabled = !summaryEnabled;
}

function refreshSummaryOptions(dates: string[]): void {
  const sanitized = Array.from(new Set(dates.filter((value) => value && value !== "unknown"))).sort((a, b) => a.localeCompare(b));
  const previousSelection = summaryDateSelect.value;
  summaryDateSelect.innerHTML = `<option value="">Select a day</option>`;
  for (const date of sanitized) {
    const option = document.createElement("option");
    option.value = date;
    option.textContent = formatDate(date);
    summaryDateSelect.appendChild(option);
  }
  if (previousSelection && sanitized.includes(previousSelection)) {
    summaryDateSelect.value = previousSelection;
  } else {
    summaryDateSelect.value = "";
  }
  summaryResult.classList.add("hidden");
  summaryResult.innerHTML = "";
  if (summaryEnabled) {
    summaryCardMessage.textContent = sanitized.length
      ? "Pick a day and click Generate AI summary."
      : "Filter talks to populate the day list.";
  }
  updateSummaryButtonState();
}

function applySummaryCapability(): void {
  // AI summary feature is temporarily hidden (still in development)
  // summaryCard.classList.remove("hidden");
  summaryCardState.textContent = summaryEnabled ? "LLM ready" : "LLM not configured";
  summaryCardMessage.textContent = summaryEnabled
    ? "Pick a day and click Generate AI summary once the day appears."
    : "AI summaries require the API URL and key to be configured.";
  if (!summaryEnabled) {
    summaryResult.classList.add("hidden");
  }
  updateSummaryButtonState();
}

async function initSummaryPanel(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/summaries/capabilities`);
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const payload = (await response.json()) as { aiSummaryEnabled: boolean };
    summaryEnabled = Boolean(payload.aiSummaryEnabled);
  } catch (err) {
    console.warn("[summary cap]", err);
    summaryEnabled = false;
  } finally {
    applySummaryCapability();
  }
}

function renderSummaryResponse(summary: AiSummaryPayload, date: string): void {
  const topicsHtml = summary.topics
    .map((topic) => `
      <li>
        <span>${escapeHtml(topic.name)}</span>
        <p>${escapeHtml(topic.detail)}</p>
      </li>
    `)
    .join("");
  const highlightsHtml = summary.highlights?.length
    ? `
      <div class="summary-highlights">
        <strong>Highlights</strong>
        <ul>
          ${summary.highlights
            .map((highlight) => {
              const reference = highlight.talkId
                ? `<span class="summary-highlight-id">${escapeHtml(highlight.talkId)}</span> `
                : "";
              return `<li>${reference}<strong>${escapeHtml(highlight.title)}</strong><p>${escapeHtml(highlight.reason)}</p></li>`;
            })
            .join("")}
        </ul>
      </div>
    `
    : "";
  summaryResult.innerHTML = `
    <div class="summary-panel">
      <p>${escapeHtml(summary.overview)}</p>
      ${topicsHtml ? `<div class="summary-topics"><strong>Topics to watch</strong><ul>${topicsHtml}</ul></div>` : ""}
      ${highlightsHtml}
    </div>
  `;
  summaryResult.classList.remove("hidden");
  summaryCardState.textContent = `Summary ready for ${formatDate(date)}`;
}

summaryDateSelect.addEventListener("change", () => {
  summaryResult.classList.add("hidden");
  summaryResult.innerHTML = "";
  summaryCardMessage.textContent = summaryEnabled
    ? "Pick a day and click Generate AI summary."
    : "AI summaries require the API URL and key to be configured.";
  summaryCardState.textContent = summaryEnabled ? "LLM ready" : "LLM not configured";
  updateSummaryButtonState();
});

summaryGenerateButton.addEventListener("click", async () => {
  const date = summaryDateSelect.value;
  if (!date || isGeneratingSummary) {
    return;
  }
  isGeneratingSummary = true;
  updateSummaryButtonState();
  summaryCardState.textContent = `Generating summary for ${formatDate(date)}…`;
  summaryCardMessage.textContent = "Summarizing the day's talks…";
  summaryResult.innerHTML = `<div class="summary-panel"><p>Generating summary…</p></div>`;
  summaryResult.classList.remove("hidden");
  try {
    const response = await fetch(`${API_BASE}/summaries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekday: new Date(date).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase() })
    });
    const data = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const errorMessage = (() => {
        if (typeof data === "object" && data !== null) {
          const candidate = data as Record<string, unknown>;
          if (typeof candidate.error === "string") {
            return candidate.error;
          }
        }
        return `Status ${response.status}`;
      })();
      throw new Error(errorMessage);
    }
    if (!data || typeof data !== "object" || !("summary" in data)) {
      throw new Error("AI summary format invalid");
    }
    renderSummaryResponse((data as SummaryResponse).summary, date);
    summaryCardMessage.textContent = `Overview ready for ${formatDate(date)}.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summaryResult.innerHTML = `<div class="summary-panel summary-error"><p>${escapeHtml(message)}</p></div>`;
    summaryCardMessage.textContent = "An error occurred. Try again later.";
    summaryCardState.textContent = "LLM error";
  } finally {
    isGeneratingSummary = false;
    updateSummaryButtonState();
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  if (!topicPanel.classList.contains("hidden") && !topicFilterContainer.contains(target)) {
    closeTopicPanel();
  }
  if (target.id === "summary-hide") {
    const collapsible = document.getElementById("summary-collapsible");
    if (!collapsible) return;
    const isHidden = collapsible.classList.toggle("hidden");
    target.textContent = isHidden ? "+" : "\u2212";
  }

  if (target.id === "load") {
    await loadCurrentView();
  }

  if (target.id === "export") {
    window.open(`${API_BASE}/schedule/${USER_ID}/export.ics`, "_blank");
  }

  if (target.classList.contains("save")) {
    const talkId = target.getAttribute("data-talk-id");
    if (!talkId) return;
    const response = await fetch(`${API_BASE}/schedule/${USER_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: talkId, type: "talk" })
    });
    if (response.ok) {
      target.textContent = "Saved";
      await loadSchedule();
    } else {
      console.warn("[save talk] failed", response.status);
    }
  }

  if (target.classList.contains("save-session")) {
    const sessionCode = target.getAttribute("data-session-code");
    if (!sessionCode) return;
    const response = await fetch(`${API_BASE}/schedule/${USER_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionCode, type: "session" })
    });
    if (response.ok) {
      target.textContent = "Saved";
      await loadSchedule();
    } else {
      console.warn("[save session] failed", response.status);
    }
  }

  if (target.classList.contains("remove-schedule")) {
    const itemId = target.getAttribute("data-item-id");
    const itemType = target.getAttribute("data-item-type");
    if (!itemId || !itemType) return;
    const response = await fetch(`${API_BASE}/schedule/${USER_ID}?id=${encodeURIComponent(itemId)}&type=${encodeURIComponent(itemType)}`, {
      method: "DELETE"
    });
    if (!response.ok && response.status !== 404) {
      console.warn("[remove schedule] failed", response.status);
    }
    await loadSchedule();
  }

  if (target.classList.contains("note-preview-toggle")) {
    const targetId = target.getAttribute("data-preview-target");
    if (!targetId) return;
    const preview = document.querySelector<HTMLDivElement>(`.note-markdown-preview[data-note-preview="${targetId}"]`);
    if (!preview) return;
    const nowHidden = preview.classList.toggle("hidden");
    target.setAttribute("aria-expanded", nowHidden ? "false" : "true");
    target.textContent = nowHidden ? "Show Markdown preview" : "Hide Markdown preview";
  }

  if (target.classList.contains("session-talks-toggle")) {
    const detailsId = target.getAttribute("data-target-id");
    if (!detailsId) {
      return;
    }

    const details = document.getElementById(detailsId);
    if (!details) {
      return;
    }

    const expanded = target.getAttribute("data-expanded") === "true";
    target.setAttribute("data-expanded", String(!expanded));
    target.textContent = expanded ? "Show talks" : "Hide talks";
    details.classList.toggle("hidden", expanded);
  }

  if (target.classList.contains("note-toggle")) {
    const talkId = target.getAttribute("data-talk-id");
    if (!talkId) return;
    const panel = target.closest(".panel");
    const noteArea = panel?.querySelector(".note-area");
    noteArea?.classList.toggle("hidden");
  }
});

document.addEventListener("input", (event) => {
  const target = event.target as HTMLElement;
  if (!target.classList.contains("note-textarea")) return;
  const talkId = target.getAttribute("data-talk-id");
  if (!talkId) return;
  const textarea = target as HTMLTextAreaElement;
  updateNotePreview(talkId, textarea.value);
});

document.addEventListener("focusout", async (event) => {
  const target = event.target as HTMLElement;
  if (!target.classList.contains("note-textarea")) return;
  const talkId = target.getAttribute("data-talk-id");
  if (!talkId) return;
  const textarea = target as HTMLTextAreaElement;
  const content = textarea.value;
  const noteArea = target.closest(".note-area");
  const saveState = noteArea?.querySelector(".note-save-state");
  const panel = target.closest(".panel");
  const toggleBtn = panel?.querySelector<HTMLButtonElement>(".note-toggle");
  try {
    await saveNote(talkId, content);
    if (saveState) {
      saveState.textContent = "Saved";
      setTimeout(() => { saveState.textContent = ""; }, 2000);
    }
    updateNotePreview(talkId, content);
    if (toggleBtn) {
      toggleBtn.textContent = content.trim() ? "\uD83D\uDCDD Edit note" : "\uD83D\uDCDD Add note";
    }
  } catch (err) {
    console.warn("[saveNote]", err);
    if (saveState) saveState.textContent = "Save failed";
  }
});


loadSchedule().catch((err) => {
  console.warn("[init] Could not load schedule", err);
});

viewButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const view = button.dataset.view === "sessions" ? "sessions" : "talks";
    if (view === currentView) {
      return;
    }
    setView(view);
    await loadCurrentView();
  });
});

topicToggleButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleTopicPanel();
});

topicClearButton.addEventListener("click", (event) => {
  event.stopPropagation();
  clearTopicSelection();
});

topicOptions.addEventListener("change", () => {
  updateTopicButtonLabel();
});

scheduleDaySelect.addEventListener("change", () => {
  loadSchedule();
});

scheduleTypeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const type = button.dataset.type as "talk" | "session" | undefined;
    if (!type) {
      return;
    }
    scheduleTypeState[type] = !scheduleTypeState[type];
    button.classList.toggle("active", scheduleTypeState[type]);
    loadSchedule();
  });
});

setView("talks");

// Add event listener for time slot changes
timeSlotRadios.forEach((radio) => {
  radio.addEventListener("change", async () => {
    await loadCurrentView();
  });
});

async function initTopics(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/topics`);
    const payload = (await response.json()) as { topics: { label: string; value: string }[] };
    const topics = Array.isArray(payload.topics) ? payload.topics : [];
    topicOptions.innerHTML = "";
    topicLabels.clear();
    const fragment = document.createDocumentFragment();
    topics.forEach((topic, index) => {
      topicLabels.set(topic.value, topic.label);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = topic.value;
      checkbox.id = `topic-option-${index}`;
      const label = document.createElement("label");
      label.className = "topic-option";
      const labelText = document.createElement("span");
      labelText.textContent = topic.label;
      label.append(checkbox, labelText);
      fragment.appendChild(label);
    });
    topicOptions.appendChild(fragment);
    updateTopicButtonLabel();
    console.log(`[initTopics] Loaded ${topics.length} topics from API`);
  } catch (err) {
    console.warn("[initTopics] Failed to load topics from API, dropdown will be empty", err);
  }
}

initSummaryPanel();
loadNotes().then(() => initTopics()).then(() => loadCurrentView());
