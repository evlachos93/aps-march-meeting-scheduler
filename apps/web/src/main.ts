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

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8787";
const USER_ID = "internal-demo";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");

app.innerHTML = `
  <h1>APS Internal Scheduler</h1>
  <div class="panel row">
    <input id="query" placeholder="Search talks" />
    <select id="topic">
      <option value="">All topics</option>
      <option value="hardware">Hardware</option>
      <option value="fabrication">Fabrication</option>
      <option value="simulation">Simulation</option>
      <option value="algorithms">Algorithms</option>
      <option value="error-correction">Error correction</option>
    </select>
    <button id="load">Find</button>
    <button id="export">Export .ics</button>
  </div>
  <div id="talks"></div>
`;

const talksContainer = document.querySelector<HTMLDivElement>("#talks");
if (!talksContainer) throw new Error("Talk list root missing");

async function loadTalks(): Promise<void> {
  const query = (document.querySelector<HTMLInputElement>("#query")?.value ?? "").trim();
  const topic = (document.querySelector<HTMLSelectElement>("#topic")?.value ?? "").trim();
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (topic) params.set("topic", topic);

  const response = await fetch(`${API_BASE}/talks?${params.toString()}`);
  const payload = (await response.json()) as { talks: Talk[] };
  talksContainer.innerHTML = payload.talks
    .map(
      (talk) => `
      <div class="panel">
        <div class="talk-title">${talk.title}</div>
        <div>${talk.track} | ${new Date(talk.startTime).toLocaleString()}</div>
        <div>${talk.room}</div>
        <p>${talk.abstract}</p>
        <button data-talk-id="${talk.id}" class="save">Add to My Schedule</button>
      </div>
    `
    )
    .join("");
}

document.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "load") {
    await loadTalks();
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
});

loadTalks();
