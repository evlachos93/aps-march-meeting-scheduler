import "./styles.css";

type Talk = {
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

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");

app.innerHTML = `
  <h1>APS Internal Scheduler</h1>
  <div class="app-layout">
    <main class="content-column">
      <div class="panel row">
        <select id="view">
          <option value="talks">Talks</option>
          <option value="sessions">Sessions</option>
        </select>
        <input id="query" placeholder="Search talks" />
        <div class="time-filter-group">
          <label>
            <input type="radio" name="timeSlot" value="all" checked /> All times
          </label>
          <label>
            <input type="radio" name="timeSlot" value="morning" /> Morning (8-11am)
          </label>
          <label>
            <input type="radio" name="timeSlot" value="afternoon" /> Afternoon (11am-2pm)
          </label>
          <label>
            <input type="radio" name="timeSlot" value="lateafternoon" /> Late Afternoon (2-5pm)
          </label>
        </div>
        <select id="topic">
          <option value="">All topics</option>
        </select>
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
      <div id="schedule-list" class="schedule-list"></div>
      <button id="export" class="schedule-export">Export .ics</button>
    </aside>
  </div>
`;

const talksContainer = document.querySelector<HTMLDivElement>("#talks")!;
const statsContainer = document.querySelector<HTMLDivElement>("#stats")!;
const scheduleContainer = document.querySelector<HTMLDivElement>("#schedule-list")!;
const scheduleCount = document.querySelector<HTMLSpanElement>("#schedule-count")!;
if (!talksContainer || !statsContainer || !scheduleContainer || !scheduleCount) {
  throw new Error("App layout rendered without required sections");
}

const viewSelect = document.querySelector<HTMLSelectElement>("#view")!;
const queryInput = document.querySelector<HTMLInputElement>("#query")!;
const topicSelect = document.querySelector<HTMLSelectElement>("#topic")!;
const daySelect = document.querySelector<HTMLSelectElement>("#day")!;
const trackSelect = document.querySelector<HTMLSelectElement>("#track")!;
const sessionTypeSelect = document.querySelector<HTMLSelectElement>("#sessionType")!;
const timeSlotRadios = document.querySelectorAll<HTMLInputElement>('input[name="timeSlot"]');

if (!viewSelect || !queryInput || !topicSelect || !daySelect || !trackSelect || !sessionTypeSelect) {
  throw new Error("Missing UI controls");
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "TBD";
  }
  return new Date(value).toLocaleString();
}

function getSelectedTimeSlot(): string {
  const checked = document.querySelector<HTMLInputElement>('input[name="timeSlot"]:checked');
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

async function loadSchedule(): Promise<void> {
  scheduleContainer.innerHTML = `<div class="schedule-loading">Loading schedule...</div>`;
  try {
    const response = await fetch(`${API_BASE}/schedule/${USER_ID}`);
    if (!response.ok) {
      throw new Error("schedule request failed");
    }
    const payload = (await response.json()) as { talks: Talk[] };
    const savedTalks = Array.isArray(payload.talks) ? payload.talks : [];
    scheduleCount.textContent = `${savedTalks.length} talk${savedTalks.length === 1 ? "" : "s"}`;

    if (!savedTalks.length) {
      scheduleContainer.innerHTML = `
        <div class="schedule-empty">
          No talks saved yet. Use the buttons on the left to build your agenda.
        </div>
      `;
      return;
    }

    scheduleContainer.innerHTML = savedTalks
      .map(
        (talk) => `
          <article class="schedule-item">
            <div>
              <p class="schedule-item-title">${escapeHtml(talk.title)}</p>
              <p class="schedule-item-meta">
                ${escapeHtml(talk.track)} | ${escapeHtml(formatDateTime(talk.startTime))}
              </p>
              <p class="schedule-item-room">${escapeHtml(talk.room)}</p>
            </div>
            <button
              class="schedule-action remove-schedule"
              type="button"
              data-talk-id="${talk.id}"
            >
              Remove
            </button>
          </article>
        `
      )
      .join("\n");
  } catch (err) {
    console.warn("[loadSchedule]", err);
    scheduleCount.textContent = "0 talks";
    scheduleContainer.innerHTML = `<div class="schedule-error">Couldn\'t load your schedule yet.</div>`;
  }
}

async function loadSummary(date: string): Promise<{ overview: string; topTalkIds: string[] } | null> {
  try {
    const response = await fetch(`${API_BASE}/summaries?date=${encodeURIComponent(date)}`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { summary: { overview: string; topTalkIds: string[] } };
    return payload.summary;
  } catch (err) {
    console.warn(`[loadSummary] Failed to load summary for ${date}`, err);
    return null;
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

async function loadTalks(): Promise<void> {
  const query = queryInput.value.trim();
  const topic = topicSelect.value.trim();
  const day = daySelect.value.trim();
  const track = trackSelect.value.trim();
  const timeSlot = getSelectedTimeSlot();
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (topic) params.set("topic", topic);
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

  // Render grouped talks with date headers and summary toggles
  const html = Array.from(talksByDate.entries())
    .map(([date, talks]) => {
      const summaryId = `summary-${date}`;
      const talksId = `talks-${date}`;
      const talksHtml = talks
        .map(
          (talk) => `
          <div class="panel">
            <div class="talk-title">${talk.sourceUrl ? `<a href="${talk.sourceUrl}" target="_blank" rel="noopener noreferrer">${talk.title}</a>` : talk.title}</div>
            <div>${talk.track} | ${formatDateTime(talk.startTime)}</div>
            <div>${talk.room}</div>
            <p>${talk.abstract}</p>
            <button data-talk-id="${talk.id}" class="save">Add to My Schedule</button>
          </div>
        `
        )
        .join("");

      return `
        <div class="day-section">
          <div class="day-header">
            <h2>${formatDate(date)}</h2>
            <button class="summary-toggle" data-date="${date}" data-summary-id="${summaryId}" type="button">
              📋 Summary
            </button>
          </div>
          <div id="${summaryId}" class="summary-content hidden"></div>
          <div id="${talksId}" class="talks-list">${talksHtml}</div>
        </div>
      `;
    })
    .join("");

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

  // Render grouped sessions with date headers and summary toggles
  const html = Array.from(sessionsByDate.entries())
    .map(([date, sessions]) => {
      const summaryId = `summary-${date}`;
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
            <button
              class="session-talks-toggle"
              data-target-id="${detailsId}"
              data-expanded="false"
              type="button"
            >Show talks</button>
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
            <button class="summary-toggle" data-date="${date}" data-summary-id="${summaryId}" type="button">
              📋 Summary
            </button>
          </div>
          <div id="${summaryId}" class="summary-content hidden"></div>
          <div id="${sessionsId}" class="sessions-list">${sessionsHtml}</div>
        </div>
      `;
    })
    .join("");

  talksContainer.innerHTML = html;
}

async function loadCurrentView(): Promise<void> {
  const view = viewSelect.value === "sessions" ? "sessions" : "talks";
  if (view === "sessions") {
    await loadSessions();
    return;
  }
  await loadTalks();
}

document.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
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
      body: JSON.stringify({ talkId })
    });
    if (response.ok) {
      target.textContent = "Saved";
      await loadSchedule();
    } else {
      console.warn("[save talk] failed", response.status);
    }
  }

  if (target.classList.contains("remove-schedule")) {
    const talkId = target.getAttribute("data-talk-id");
    if (!talkId) return;
    const response = await fetch(`${API_BASE}/schedule/${USER_ID}/${talkId}`, {
      method: "DELETE"
    });
    if (!response.ok && response.status !== 404) {
      console.warn("[remove schedule] failed", response.status);
    }
    await loadSchedule();
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

  if (target.classList.contains("summary-toggle")) {
    const date = target.getAttribute("data-date");
    const summaryId = target.getAttribute("data-summary-id");
    if (!date || !summaryId) {
      return;
    }

    const summaryContainer = document.getElementById(summaryId);
    if (!summaryContainer) {
      return;
    }

    const isHidden = summaryContainer.classList.contains("hidden");
    
    if (isHidden) {
      // Loading summary
      summaryContainer.textContent = "Loading summary...";
      summaryContainer.classList.remove("hidden");
      
      const summary = await loadSummary(date);
      if (summary) {
        // Build summary HTML with top talks
        const talksHtml = summary.topTalkIds.length > 0 
          ? `<div class="top-talks"><strong>Top talks:</strong><ul>` + 
            summary.topTalkIds.map(id => `<li>${escapeHtml(id)}</li>`).join("") + 
            `</ul></div>`
          : "";
        summaryContainer.innerHTML = `
          <div class="summary-panel">
            <p>${escapeHtml(summary.overview)}</p>
            ${talksHtml}
          </div>
        `;
      } else {
        summaryContainer.innerHTML = `<div class="summary-panel"><p>No summary available for this date.</p></div>`;
      }
    } else {
      // Hide summary
      summaryContainer.classList.add("hidden");
    }
  }
});

loadSchedule().catch((err) => {
  console.warn("[init] Could not load schedule", err);
});

viewSelect.addEventListener("change", async () => {
  const view = viewSelect.value === "sessions" ? "sessions" : "talks";
  // Update visibility of topic/track/sessionType selects based on view
  if (view === "talks") {
    topicSelect.style.display = "";
    trackSelect.style.display = "";
    sessionTypeSelect.style.display = "none";
    queryInput.placeholder = "Search talks";
  } else {
    topicSelect.style.display = "none";
    trackSelect.style.display = "none";
    sessionTypeSelect.style.display = "";
    queryInput.placeholder = "Search sessions";
  }
  await loadCurrentView();
});

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
    const fragment = document.createDocumentFragment();
    for (const t of payload.topics) {
      const opt = document.createElement("option");
      opt.value = t.value;
      opt.textContent = t.label;
      fragment.appendChild(opt);
    }
    topicSelect.appendChild(fragment);
    console.log(`[initTopics] Loaded ${payload.topics.length} topics from API`);
  } catch (err) {
    console.warn("[initTopics] Failed to load topics from API, dropdown will be empty", err);
  }
}

// Initialize with talks view settings
topicSelect.style.display = "";
trackSelect.style.display = "";
sessionTypeSelect.style.display = "none";
queryInput.placeholder = "Search talks";

initTopics().then(() => loadCurrentView());
