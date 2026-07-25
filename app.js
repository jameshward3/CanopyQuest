const apiUrl = String(window.ORANGE_TREE_DATABASE_URL || "").replace(/\/$/, "");
const message = document.querySelector("#message");
const form = document.querySelector("#findingForm");
let trees = [];

async function request(path, options = {}) {
  const response = await fetch(apiUrl + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

function renderTrees() {
  const select = document.querySelector("#treeId");
  select.innerHTML = `<option value="">Unlinked location</option>` + trees
    .map(tree => `<option value="${escapeHtml(tree.id)}">${escapeHtml(tree.id)} · ${escapeHtml(tree.street || "Unknown street")}</option>`)
    .join("");
  document.querySelector("#treeCount").textContent = trees.length.toLocaleString();
  document.querySelector("#verifiedCount").textContent =
    trees.filter(tree => tree.status === "Verified").length.toLocaleString();
}

function renderFindings(findings) {
  document.querySelector("#findingCount").textContent = findings.length.toLocaleString();
  document.querySelector("#findings").innerHTML = findings.length
    ? findings.slice(0, 12).map(finding => `
      <article>
        <strong>${escapeHtml(finding.category.replaceAll("-", " "))}</strong>
        <span>${escapeHtml(finding.treeId || "Unlinked location")} · ${new Date(finding.createdAt).toLocaleDateString()}</span>
        <p>${escapeHtml(finding.notes || "No notes supplied.")}</p>
      </article>`).join("")
    : `<p class="empty">No findings yet. Start the shared field record above.</p>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

async function load() {
  try {
    const [treeResult, findingResult] = await Promise.all([
      request("/v1/trees"),
      request("/v1/findings")
    ]);
    trees = treeResult.trees || [];
    renderTrees();
    renderFindings(findingResult.findings || []);
  } catch (error) {
    console.error(error);
    message.textContent = "The shared database is not available yet.";
  }
}

document.querySelector("#locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    message.textContent = "Location is not available in this browser.";
    return;
  }
  message.textContent = "Finding your location…";
  navigator.geolocation.getCurrentPosition(
    position => {
      form.elements.latitude.value = position.coords.latitude.toFixed(6);
      form.elements.longitude.value = position.coords.longitude.toFixed(6);
      message.textContent = "Location added.";
    },
    () => { message.textContent = "Location permission was not granted."; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const data = new FormData(form);
  const latitude = data.get("latitude");
  const longitude = data.get("longitude");
  const finding = {
    treeId: data.get("treeId") || null,
    category: data.get("category"),
    notes: data.get("notes"),
    latitude: latitude === "" ? null : Number(latitude),
    longitude: longitude === "" ? null : Number(longitude),
    source: "canopyquest"
  };
  message.textContent = "Publishing…";
  try {
    await request("/v1/findings", { method: "POST", body: JSON.stringify(finding) });
    form.reset();
    message.textContent = "Finding published to OrangeTreeDatabase.";
    await load();
  } catch (error) {
    console.error(error);
    message.textContent = "The finding could not be published. Please try again.";
  }
});

load();
