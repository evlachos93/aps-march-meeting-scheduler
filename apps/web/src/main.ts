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
};

type Session = {
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
};

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8787";
const USER_ID = "internal-demo";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");

app.innerHTML = `
  <h1>APS Internal Scheduler</h1>
  <div class="panel row">
    <select id="view">
      <option value="talks">Talks</option>
      <option value="sessions">Sessions</option>
    </select>
    <input id="query" placeholder="Search talks" />
    <select id="sort"></select>
    <select id="topic">
      <option value="">All topics</option>
      <option value="hardware">Hardware</option>
      <option value="fabrication">Fabrication</option>
      <option value="simulation">Simulation</option>
      <option value="algorithms">Algorithms</option>
      <option value="error-correction">Error correction</option>
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
    <button id="export">Export .ics</button>
  </div>
  <div id="talks"></div>
`;

const talksContainer = document.querySelector<HTMLDivElement>("#talks");
if (!talksContainer) throw new Error("Talk list root missing");

const viewSelect = document.querySelector<HTMLSelectElement>("#view");
const queryInput = document.querySelector<HTMLInputElement>("#query");
const sortSelect = document.querySelector<HTMLSelectElement>("#sort");
const topicSelect = document.querySelector<HTMLSelectElement>("#topic");
const trackSelect = document.querySelector<HTMLSelectElement>("#track");
const sessionTypeSelect = document.querySelector<HTMLSelectElement>("#sessionType");

if (!viewSelect || !queryInput || !sortSelect || !topicSelect || !trackSelect || !sessionTypeSelect) {
  throw new Error("Missing UI controls");
}

function setSortOptions(view: "talks" | "sessions"): void {
  if (view === "talks") {
    sortSelect.innerHTML = `
      <option value="time">Sort: Start time</option>
      <option value="title">Sort: Title</option>
      <option value="track">Sort: Track</option>
    `;
    topicSelect.style.display = "";
    trackSelect.style.display = "";
    sessionTypeSelect.style.display = "none";
    queryInput.placeholder = "Search talks";
    return;
  }

  sortSelect.innerHTML = `
    <option value="time">Sort: Start time</option>
    <option value="title">Sort: Session title</option>
    <option value="code">Sort: Session code</option>
    <option value="talk-count">Sort: Talk count</option>
  `;
  topicSelect.style.display = "none";
  trackSelect.style.display = "none";
  sessionTypeSelect.style.display = "";
  queryInput.placeholder = "Search sessions";
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "TBD";
  }
  return new Date(value).toLocaleString();
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
  const track = trackSelect.value.trim();
  const sortBy = sortSelect.value;
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (topic) params.set("topic", topic);
  if (track) params.set("track", track);
  if (sortBy) params.set("sortBy", sortBy);

  const url = `${API_BASE}/talks?${params.toString()}`;
  console.log(`[loadTalks] Fetching: ${url}`);
  const response = await fetch(url);
  const payload = (await response.json()) as { talks: Talk[] };
  console.log(`[loadTalks] Received ${payload.talks.length} talks`);
  
  talksContainer.innerHTML = payload.talks
    .map(
      (talk) => `
      <div class="panel">
        <div class="talk-title">${talk.title}</div>
        <div>${talk.track} | ${formatDateTime(talk.startTime)}</div>
        <div>${talk.room}</div>
        <p>${talk.abstract}</p>
        <button data-talk-id="${talk.id}" class="save">Add to My Schedule</button>
      </div>
    `
    )
    .join("");
}

async function loadSessions(): Promise<void> {
  const query = queryInput.value.trim();
  const sessionType = sessionTypeSelect.value.trim();
  const sortBy = sortSelect.value;
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (sessionType) params.set("sessionType", sessionType);
  if (sortBy) params.set("sortBy", sortBy);

  const url = `${API_BASE}/sessions?${params.toString()}`;
  console.log(`[loadSessions] Fetching: ${url}`);
  const response = await fetch(url);
  const payload = (await response.json()) as { sessions: Session[] };
  console.log(`[loadSessions] Received ${payload.sessions.length} sessions`);
  talksContainer.innerHTML = payload.sessions
    .map((session, index) => {
      const detailsId = `session-talks-${index}`;
      const talksList = session.talkTitles
        .map((title) => `<li>${escapeHtml(title)}</li>`)
        .join("");

      return `
      <div class="panel">
        <div class="talk-title">${session.title}</div>
        <div>${session.sessionType} | ${session.weekday ?? ""} ${session.timeRange}</div>
        <div>${session.room ?? "Room TBD"}</div>
        <div><a href="${session.url}" target="_blank" rel="noopener noreferrer">${session.sessionCode}</a></div>
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
    await fetch(`${API_BASE}/schedule/${USER_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ talkId })
    });
    target.textContent = "Saved";
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
});

viewSelect.addEventListener("change", async () => {
  const view = viewSelect.value === "sessions" ? "sessions" : "talks";
  setSortOptions(view);
  await loadCurrentView();
});

setSortOptions("talks");
loadCurrentView();
