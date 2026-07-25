(function () {
  "use strict";

  const API_URL = String(window.ORANGE_TREE_DATABASE_URL || "https://orange-tree-database.vercel.app").replace(/\/$/, "");
  const ORANGE_BOUNDARY_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/1/query?where=STATE%3D%2734%27%20AND%20COUSUB%3D%2713045%27&outFields=GEOID%2CNAME&returnGeometry=true&outSR=4326&f=geojson";
  const FALLBACK_BOUNDARY = [
    [-74.25514, 40.75838], [-74.25004, 40.75617], [-74.24374, 40.75370],
    [-74.23815, 40.75224], [-74.23313, 40.75672], [-74.22648, 40.76265],
    [-74.22052, 40.76796], [-74.22000, 40.77009], [-74.22351, 40.77425],
    [-74.22113, 40.78067], [-74.21853, 40.78821], [-74.22320, 40.78757],
    [-74.23048, 40.78233], [-74.23695, 40.77849], [-74.23950, 40.77378],
    [-74.24421, 40.76797], [-74.24990, 40.76660], [-74.25209, 40.76249],
    [-74.25514, 40.75838]
  ];
  const DEMO_LOCATION = { latitude: 40.7673, longitude: -74.2391, accuracy: 7 };
  const MAP_BOUNDS = { west: -74.2605, east: -74.2125, south: 40.748, north: 40.792 };
  const PRIORITY_AREAS = [
    { latitude: 40.7702, longitude: -74.2255, label: "UNMAPPED" },
    { latitude: 40.7584, longitude: -74.2478, label: "LOW COVERAGE" },
    { latitude: 40.7812, longitude: -74.2315, label: "VERIFY" }
  ];
  const DEFAULT_QUESTS = [
    { id: "daily-first-capture", title: "Field Notes", description: "Capture one tree today.", rewardXp: 120, progress: 0, target: 1 },
    { id: "daily-coverage", title: "Fill the Gap", description: "Map a tree in a low-coverage cell.", rewardXp: 180, progress: 0, target: 1 },
    { id: "weekly-diversity", title: "Species Scout", description: "Confirm three different species this week.", rewardXp: 400, progress: 0, target: 3 }
  ];

  const state = {
    stream: null, location: null, heading: null, trees: [], boundary: FALLBACK_BOUNDARY,
    profile: null, dashboard: null, analysis: null, matchedTree: null, demo: false,
    scanning: false, syncing: false, queueCount: 0, lastFrameHash: null
  };
  const elements = {};
  [
    "app", "camera", "captureCanvas", "mapCanvas", "permissionDialog", "profileDialog",
    "confirmDialog", "questsDialog", "leadersDialog", "aboutDialog", "enableFieldMode",
    "demoModeButton", "captureButton", "profileButton", "aboutButton", "questsButton",
    "leadersButton", "syncButton", "profileForm", "confirmForm", "retryButton",
    "displayNameInput", "communityNotice", "playerName", "avatarInitials", "levelValue",
    "xpText", "xpBar", "streakValue", "syncLabel", "priorityText", "accuracyText",
    "wardText", "coordinatesText", "captureHeadline", "captureInstruction", "rewardPreview",
    "speciesValue", "confidenceValue", "heightValue", "canopyValue", "dbhValue",
    "healthValue", "modelLabel", "analysisCard", "speciesInput", "conditionInput",
    "heightInput", "canopyInput", "dbhInput", "notesInput", "matchNotice", "questList",
    "questBadge", "leaderList", "toast", "rewardBurst"
  ].forEach(id => { elements[id] = document.getElementById(id); });

  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : `cq-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function sanitizeName(value) {
    return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[character]);
  }
  function toast(message, duration = 3200) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => elements.toast.classList.remove("show"), duration);
  }
  async function request(path, options = {}) {
    const response = await fetch(API_URL + path, {
      ...options,
      headers: { "Content-Type": "application/json", "Accept": "application/json", ...(options.headers || {}) }
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.error || `Database request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  function saveProfileLocal(profile) {
    state.profile = profile;
    localStorage.setItem("canopyQuestPlayer", JSON.stringify(profile));
    renderProfile();
  }
  function loadProfileLocal() {
    try {
      const profile = JSON.parse(localStorage.getItem("canopyQuestPlayer") || "null");
      if (profile?.id) state.profile = profile;
    } catch (_error) {
      localStorage.removeItem("canopyQuestPlayer");
    }
  }
  function levelProgress(xp = 0) {
    const level = Math.floor(Math.sqrt(Math.max(0, xp) / 250)) + 1;
    const floor = Math.pow(level - 1, 2) * 250;
    const ceiling = Math.pow(level, 2) * 250;
    return { level, floor, ceiling, percent: Math.min(100, ((xp - floor) / Math.max(1, ceiling - floor)) * 100) };
  }
  function renderProfile() {
    const profile = state.dashboard?.player || state.profile || {};
    const displayName = sanitizeName(profile.displayName) || "EXPLORER";
    const xp = Number(profile.xp || 0);
    const progress = levelProgress(xp);
    elements.playerName.textContent = displayName.toUpperCase();
    elements.avatarInitials.textContent = displayName.split(" ").slice(0, 2).map(part => part[0]).join("").toUpperCase() || "CQ";
    elements.levelValue.textContent = String(profile.level || progress.level).padStart(2, "0");
    elements.xpText.textContent = `${xp.toLocaleString()} / ${progress.ceiling.toLocaleString()} XP`;
    elements.xpBar.style.width = `${progress.percent}%`;
    elements.streakValue.textContent = profile.currentStreak || 0;
  }
  function wardFor(latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "—";
    const latitudeOffset = latitude - 40.76730;
    const longitudeOffset = (longitude - (-74.23905)) * Math.cos(40.76730 * Math.PI / 180);
    if (Math.abs(latitudeOffset) >= Math.abs(longitudeOffset)) {
      return latitudeOffset >= 0 ? "NORTH" : "SOUTH";
    }
    return longitudeOffset >= 0 ? "EAST" : "WEST";
  }
  function updateLocationHud() {
    const location = state.location;
    if (!location) {
      elements.accuracyText.textContent = "GPS —";
      elements.wardText.textContent = "WARD —";
      elements.coordinatesText.textContent = "LOCATION NEEDED";
      return;
    }
    elements.accuracyText.textContent = `GPS ±${Math.round(location.accuracy || 0)} m`;
    elements.wardText.textContent = `WARD ${wardFor(location.latitude, location.longitude)}`;
    elements.coordinatesText.textContent = `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
    const nearest = nearestPriority(location);
    elements.priorityText.textContent = `${nearest.area.label} · ${Math.round(nearest.distance)} m`;
    drawMap();
  }
  function radians(value) { return value * Math.PI / 180; }
  function distanceMeters(a, b) {
    const earth = 6371000;
    const lat1 = radians(a.latitude);
    const lat2 = radians(b.latitude);
    const dLat = lat2 - lat1;
    const dLon = radians(b.longitude - a.longitude);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * earth * Math.asin(Math.sqrt(value));
  }
  function nearestPriority(location) {
    return PRIORITY_AREAS.map(area => ({ area, distance: distanceMeters(location, area) }))
      .sort((left, right) => left.distance - right.distance)[0];
  }
  function pointInPolygon(location, polygon = state.boundary) {
    if (!location || !Array.isArray(polygon) || polygon.length < 3) return false;
    const x = location.longitude;
    const y = location.latitude;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      const intersects = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }
  function treeLocation(tree) {
    const latitude = Number(tree.lat ?? tree.latitude);
    const longitude = Number(tree.lng ?? tree.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  }
  function matchNearbyTree(location) {
    if (!location) return null;
    const threshold = Math.min(35, Math.max(8, Number(location.accuracy || 8) * 1.5));
    const candidates = state.trees.map(tree => {
      const coordinates = treeLocation(tree);
      return coordinates ? { tree, distance: distanceMeters(location, coordinates) } : null;
    }).filter(Boolean).filter(candidate => candidate.distance <= threshold)
      .sort((left, right) => left.distance - right.distance);
    if (!candidates[0]) return null;
    return { ...candidates[0], confidence: Math.max(0.5, Math.min(0.99, 1 - candidates[0].distance / (threshold * 1.6))) };
  }
  function mapPoint(longitude, latitude, width, height) {
    const x = (longitude - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west) * width;
    const y = height - (latitude - MAP_BOUNDS.south) / (MAP_BOUNDS.north - MAP_BOUNDS.south) * height;
    return [x, y];
  }
  function drawMap() {
    const canvas = elements.mapCanvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const context = canvas.getContext("2d");
    context.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#17363a");
    gradient.addColorStop(1, "#173326");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.save();
    context.strokeStyle = "rgba(206, 225, 202, .22)";
    context.lineWidth = 1;
    [0.06, 0.15, 0.27, 0.38, 0.51, 0.64, 0.76, 0.88, 0.96].forEach((seed, index) => {
      context.beginPath();
      context.moveTo(width * seed, 0);
      context.bezierCurveTo(width * (seed - .1), height * .36, width * (seed + .12), height * .62, width * (seed - .03), height);
      context.stroke();
      context.beginPath();
      context.moveTo(0, height * seed);
      context.bezierCurveTo(width * .29, height * (seed - .1), width * .63, height * (seed + .09), width, height * (seed - .025));
      context.stroke();
      context.strokeStyle = index % 2 === 0 ? "rgba(223, 233, 215, .31)" : "rgba(206, 225, 202, .18)";
      context.lineWidth = index % 2 === 0 ? 1.5 : 1;
    });
    context.restore();
    context.beginPath();
    state.boundary.forEach(([longitude, latitude], index) => {
      const [x, y] = mapPoint(longitude, latitude, width, height);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.closePath();
    context.fillStyle = "rgba(48, 101, 57, .22)";
    context.fill();
    context.strokeStyle = "#d5ff85";
    context.lineWidth = 2;
    context.shadowColor = "rgba(201, 255, 104, .45)";
    context.shadowBlur = 6;
    context.stroke();
    context.shadowBlur = 0;
    state.trees.slice(0, 180).forEach(tree => {
      const coordinates = treeLocation(tree);
      if (!coordinates) return;
      const [x, y] = mapPoint(coordinates.longitude, coordinates.latitude, width, height);
      context.beginPath();
      context.arc(x, y, 3.2, 0, Math.PI * 2);
      context.fillStyle = String(tree.status || "").toLowerCase() === "verified" ? "#c8f24a" : "#f4c16a";
      context.fill();
      context.strokeStyle = "rgba(4, 20, 13, .85)";
      context.lineWidth = 1;
      context.stroke();
    });
    PRIORITY_AREAS.forEach((area, index) => {
      const [x, y] = mapPoint(area.longitude, area.latitude, width, height);
      context.beginPath();
      context.arc(x, y, 7 + index, 0, Math.PI * 2);
      context.strokeStyle = "#ff8a2b";
      context.globalAlpha = .8;
      context.lineWidth = 1.5;
      context.stroke();
      context.beginPath();
      context.arc(x, y, 14 + index * 2, 0, Math.PI * 2);
      context.globalAlpha = .3;
      context.stroke();
      context.globalAlpha = 1;
    });
    if (state.location) {
      const [x, y] = mapPoint(state.location.longitude, state.location.latitude, width, height);
      const heading = radians(Number(state.heading || 0) - 90);
      context.beginPath();
      context.moveTo(x, y);
      context.arc(x, y, 62, heading - .32, heading + .32);
      context.closePath();
      context.fillStyle = "rgba(196, 244, 65, .25)";
      context.fill();
      context.strokeStyle = "rgba(211, 255, 105, .55)";
      context.stroke();
      context.beginPath();
      context.arc(x, y, 7, 0, Math.PI * 2);
      context.fillStyle = "#d7ff63";
      context.shadowColor = "#c8f24a";
      context.shadowBlur = 14;
      context.fill();
      context.shadowBlur = 0;
      context.strokeStyle = "white";
      context.lineWidth = 2;
      context.stroke();
    }
  }
  async function loadBoundary() {
    try {
      const response = await fetch(ORANGE_BOUNDARY_URL);
      const data = await response.json();
      const geometry = data.features?.[0]?.geometry;
      const ring = geometry?.type === "Polygon" ? geometry.coordinates?.[0] : geometry?.coordinates?.[0]?.[0];
      if (Array.isArray(ring) && ring.length > 20) state.boundary = ring;
    } catch (_error) {
      // The reviewed Census-derived fallback remains available offline.
    }
    drawMap();
  }
  function setSyncState(label, offline = false) {
    elements.syncLabel.textContent = label;
    elements.syncButton.classList.toggle("offline", offline);
  }
  async function loadSharedData() {
    setSyncState("SYNCING");
    try {
      const treeResult = await request("/v1/trees");
      state.trees = treeResult.trees || [];
      setSyncState("SYNC");
    } catch (error) {
      console.warn("Tree inventory unavailable", error);
      setSyncState("OFFLINE", true);
    }
    drawMap();
    await refreshDashboard();
  }
  async function refreshDashboard() {
    if (!state.profile?.id) {
      renderQuests(DEFAULT_QUESTS);
      return;
    }
    try {
      const result = await request(`/v1/players/${encodeURIComponent(state.profile.id)}/dashboard`);
      state.dashboard = result;
      saveProfileLocal(result.player);
      renderQuests(result.quests || DEFAULT_QUESTS);
    } catch (_error) {
      renderQuests(DEFAULT_QUESTS);
    }
  }
  function renderQuests(quests) {
    const active = quests.filter(quest => Number(quest.progress || 0) < Number(quest.target || 1));
    elements.questBadge.textContent = active.length;
    elements.questBadge.hidden = active.length === 0;
    elements.questList.innerHTML = quests.map(quest => {
      const progress = Number(quest.progress || 0);
      const target = Math.max(1, Number(quest.target || 1));
      return `<article class="quest-card"><header><h3>${escapeHtml(quest.title)}</h3><em>+${Number(quest.rewardXp || 0)} XP</em></header><p>${escapeHtml(quest.description)}</p><div class="quest-progress" aria-label="${progress} of ${target} complete"><span style="width:${Math.min(100, progress / target * 100)}%"></span></div></article>`;
    }).join("");
  }
  async function renderLeaders(period = "weekly") {
    elements.leaderList.innerHTML = "<li><strong>Loading explorers…</strong><span>—</span></li>";
    try {
      const result = await request(`/v1/leaderboards?period=${encodeURIComponent(period)}&metric=xp`);
      const leaders = result.leaders || [];
      elements.leaderList.innerHTML = leaders.length
        ? leaders.map(leader => `<li><strong>${escapeHtml(leader.displayName)}</strong><span>${Number(leader.value || leader.xp || 0).toLocaleString()} XP</span></li>`).join("")
        : "<li><strong>No ranked captures yet</strong><span>0 XP</span></li>";
    } catch (_error) {
      const profile = state.profile;
      elements.leaderList.innerHTML = profile
        ? `<li><strong>${escapeHtml(profile.displayName)}</strong><span>${Number(profile.xp || 0).toLocaleString()} XP</span></li>`
        : "<li><strong>Connect to load rankings</strong><span>—</span></li>";
    }
  }
  async function enableCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera is not supported by this browser.");
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    elements.camera.srcObject = state.stream;
    await elements.camera.play();
  }
  function requestLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Location is not supported by this browser."));
      navigator.geolocation.getCurrentPosition(position => {
        state.location = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          capturedAt: new Date(position.timestamp).toISOString()
        };
        updateLocationHud();
        resolve(state.location);
      }, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
    });
  }
  async function requestOrientation() {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== "granted") return;
      }
      window.addEventListener("deviceorientationabsolute", onOrientation, true);
      window.addEventListener("deviceorientation", onOrientation, true);
    } catch (_error) {
      // Heading is optional.
    }
  }
  function onOrientation(event) {
    const heading = event.webkitCompassHeading ?? (Number.isFinite(event.alpha) ? 360 - event.alpha : null);
    if (Number.isFinite(heading)) {
      state.heading = Number(heading.toFixed(1));
      drawMap();
    }
  }
  async function enableFieldMode() {
    elements.enableFieldMode.disabled = true;
    elements.enableFieldMode.textContent = "OPENING FIELD MODE…";
    const results = await Promise.allSettled([enableCamera(), requestLocation(), requestOrientation()]);
    elements.enableFieldMode.disabled = false;
    elements.enableFieldMode.textContent = "ENABLE FIELD MODE";
    const cameraReady = results[0].status === "fulfilled";
    const locationReady = results[1].status === "fulfilled";
    if (elements.permissionDialog.open) elements.permissionDialog.close();
    if (!cameraReady && !locationReady) {
      toast("Camera and location were not granted. You can still explore in preview mode.", 4800);
      startDemo();
      return;
    }
    if (!cameraReady) toast("Camera was not granted. The scanner will use the visual preview.");
    if (!locationReady) toast("Location is required before a real capture can be submitted.");
    elements.captureHeadline.textContent = locationReady ? "TREE IN RANGE" : "LOCATION NEEDED";
    elements.captureInstruction.textContent = "Hold steady, then tap the scanner";
    elements.captureButton.querySelector(".capture-label").textContent = "CAPTURE";
  }
  function startDemo() {
    state.demo = true;
    state.location = { ...DEMO_LOCATION };
    updateLocationHud();
    elements.captureHeadline.textContent = "PREVIEW MODE";
    elements.captureInstruction.textContent = "Try the scanner—no record will be submitted";
    elements.captureButton.querySelector(".capture-label").textContent = "SCAN";
    if (elements.permissionDialog.open) elements.permissionDialog.close();
  }
  function captureFrame() {
    const canvas = elements.captureCanvas;
    const video = elements.camera;
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 960;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (video.readyState >= 2 && video.videoWidth) {
      context.drawImage(video, 0, 0, width, height);
    } else {
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "#1d5444");
      gradient.addColorStop(1, "#193019");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#285b2b";
      for (let index = 0; index < 160; index += 1) {
        const x = (index * 83) % width;
        const y = (index * 137) % height;
        context.beginPath();
        context.arc(x, y, 8 + (index % 11), 0, Math.PI * 2);
        context.fill();
      }
    }
    return { canvas, imageData: context.getImageData(0, 0, Math.min(320, width), Math.min(320, height)), width, height };
  }
  async function hashFrame(canvas) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.5));
    if (!blob || !crypto.subtle) return `fallback-${Date.now()}`;
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  function renderAnalysis(analysis) {
    elements.speciesValue.textContent = analysis.speciesPrediction.toUpperCase();
    elements.confidenceValue.textContent = `${Math.round(analysis.speciesConfidence * 100)}%`;
    elements.heightValue.textContent = `${analysis.estimatedHeight} FT`;
    elements.canopyValue.textContent = `${analysis.estimatedCanopyDiameter} FT`;
    elements.dbhValue.textContent = `~${analysis.estimatedDbh} IN`;
    elements.healthValue.textContent = analysis.estimatedCondition.toUpperCase();
    elements.modelLabel.textContent = `${analysis.model} ${analysis.version} · on-device estimate`;
  }
  async function scanTree() {
    if (state.scanning) return;
    if (!state.stream && !state.demo && !state.location) {
      elements.permissionDialog.showModal();
      return;
    }
    if (!state.location && !state.demo) {
      try { await requestLocation(); } catch (_error) {
        toast("A precise location is required for a field capture.");
        return;
      }
    }
    state.scanning = true;
    elements.app.classList.add("scanning");
    elements.captureHeadline.textContent = "ANALYZING CANOPY";
    elements.captureInstruction.textContent = "Estimating species and dimensions…";
    elements.captureButton.disabled = true;
    try {
      const frame = captureFrame();
      const [analysis, frameHash] = await Promise.all([
        window.CanopyAI.analyze({ imageData: frame.imageData, metadata: {
          width: frame.width, height: frame.height, gpsAccuracy: state.location?.accuracy, heading: state.heading
        } }),
        hashFrame(frame.canvas)
      ]);
      state.analysis = analysis;
      state.lastFrameHash = frameHash;
      state.matchedTree = matchNearbyTree(state.location);
      renderAnalysis(analysis);
      elements.captureHeadline.textContent = "TREE IN RANGE";
      elements.captureInstruction.textContent = "Review the estimates before syncing";
      elements.speciesInput.value = analysis.speciesPrediction;
      elements.conditionInput.value = analysis.estimatedCondition;
      elements.heightInput.value = analysis.estimatedHeight;
      elements.canopyInput.value = analysis.estimatedCanopyDiameter;
      elements.dbhInput.value = analysis.estimatedDbh;
      elements.notesInput.value = "";
      elements.matchNotice.textContent = state.matchedTree
        ? `Possible match: ${state.matchedTree.tree.id} · ${Math.round(state.matchedTree.distance)} m away · ${Math.round(state.matchedTree.confidence * 100)}% match confidence.`
        : "No existing inventory tree matched within the GPS-aware capture radius. This will be routed as a possible new tree.";
      elements.confirmDialog.showModal();
    } catch (error) {
      console.error(error);
      toast("The scan could not be completed. Please hold steady and retry.");
    } finally {
      state.scanning = false;
      elements.app.classList.remove("scanning");
      elements.captureButton.disabled = false;
    }
  }
  function buildCapture() {
    const analysis = state.analysis;
    const confirmedSpecies = elements.speciesInput.value;
    return {
      id: uuid(), playerId: state.profile.id, treeId: state.matchedTree?.tree?.id || null,
      latitude: state.location.latitude, longitude: state.location.longitude,
      gpsAccuracy: Number(state.location.accuracy || 0),
      heading: Number.isFinite(state.heading) ? state.heading : null,
      capturedAt: new Date().toISOString(), imageReference: null, imageHash: state.lastFrameHash,
      imageMetadata: { width: elements.captureCanvas.width, height: elements.captureCanvas.height, exifRetained: false },
      aiModel: analysis.model, aiModelVersion: analysis.version, aiProvider: analysis.provider,
      speciesPrediction: analysis.speciesPrediction, speciesConfidence: analysis.speciesConfidence,
      confirmedSpecies,
      userCorrected: confirmedSpecies !== analysis.speciesPrediction || elements.conditionInput.value !== analysis.estimatedCondition,
      estimatedHeight: Number(elements.heightInput.value),
      estimatedCanopyDiameter: Number(elements.canopyInput.value),
      estimatedCanopyArea: Math.round(Math.PI * Math.pow(Number(elements.canopyInput.value) / 2, 2)),
      estimatedDbh: Number(elements.dbhInput.value),
      estimatedCondition: elements.conditionInput.value,
      notes: elements.notesInput.value.trim().slice(0, 500),
      ward: wardFor(state.location.latitude, state.location.longitude),
      nearestAddress: state.matchedTree?.tree?.street || "Orange, NJ",
      existingTreeMatchConfidence: state.matchedTree?.confidence || 0,
      verificationStatus: state.location.accuracy > 50 ? "review" : "unverified",
      source: "canopyquest",
      metadata: {
        providerOnDevice: Boolean(analysis.onDevice),
        boundarySource: "U.S. Census TIGERweb 2025",
        clientVersion: "2.0.0",
        offlineDraft: !navigator.onLine
      }
    };
  }
  async function openQueue() {
    return new Promise((resolve, reject) => {
      const openRequest = indexedDB.open("canopyquest", 1);
      openRequest.onupgradeneeded = () => {
        const database = openRequest.result;
        if (!database.objectStoreNames.contains("captures")) database.createObjectStore("captures", { keyPath: "id" });
      };
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error);
    });
  }
  async function queueCapture(capture) {
    const database = await openQueue();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("captures", "readwrite");
      transaction.objectStore("captures").put(capture);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    await updateQueueCount();
  }
  async function readQueue() {
    const database = await openQueue();
    const items = await new Promise((resolve, reject) => {
      const transaction = database.transaction("captures", "readonly");
      const allRequest = transaction.objectStore("captures").getAll();
      allRequest.onsuccess = () => resolve(allRequest.result || []);
      allRequest.onerror = () => reject(allRequest.error);
    });
    database.close();
    return items;
  }
  async function removeQueuedCapture(id) {
    const database = await openQueue();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("captures", "readwrite");
      transaction.objectStore("captures").delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }
  async function updateQueueCount() {
    try {
      state.queueCount = (await readQueue()).length;
      if (state.queueCount) setSyncState(`${state.queueCount} QUEUED`, true);
    } catch (_error) {
      state.queueCount = 0;
    }
  }
  async function sendCapture(capture) {
    return request("/v1/captures", {
      method: "POST", headers: { "Idempotency-Key": capture.id }, body: JSON.stringify(capture)
    });
  }
  async function flushQueue() {
    if (!navigator.onLine || state.syncing) return;
    state.syncing = true;
    try {
      for (const capture of await readQueue()) {
        try {
          await sendCapture(capture);
          await removeQueuedCapture(capture.id);
        } catch (error) {
          if (error.status && error.status < 500 && error.status !== 429) await removeQueuedCapture(capture.id);
          else break;
        }
      }
      await updateQueueCount();
      if (!state.queueCount) setSyncState("SYNC");
      await refreshDashboard();
    } catch (error) {
      console.warn("Offline queue sync deferred", error);
      setSyncState("OFFLINE", true);
    } finally {
      state.syncing = false;
    }
  }
  function reward(xp = 120) {
    elements.rewardBurst.querySelector("span").textContent = `+${xp} XP`;
    elements.rewardBurst.classList.remove("show");
    void elements.rewardBurst.offsetWidth;
    elements.rewardBurst.classList.add("show");
  }
  async function confirmCapture(event) {
    event.preventDefault();
    if (state.demo) {
      elements.confirmDialog.close();
      reward(120);
      toast("Preview complete. Enable field mode when you’re ready to contribute.");
      return;
    }
    if (!state.profile?.id) {
      elements.confirmDialog.close();
      openProfileDialog(true);
      return;
    }
    if (!pointInPolygon(state.location)) {
      toast("Captures must be inside the City of Orange boundary. This draft was not submitted.", 5200);
      return;
    }
    const capture = buildCapture();
    const submitButton = elements.confirmForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = "SYNCING…";
    try {
      const result = await sendCapture(capture);
      if (result.player) saveProfileLocal(result.player);
      elements.confirmDialog.close();
      reward(result.reward?.xp || 120);
      toast(result.capture?.verificationStatus === "review"
        ? "Capture saved for review. Your draft is safely in the shared database."
        : "Capture synced to OrangeTreeDatabase.");
      await Promise.all([loadSharedData(), flushQueue()]);
    } catch (error) {
      console.warn("Capture queued", error);
      await queueCapture(capture);
      elements.confirmDialog.close();
      reward(120);
      toast("Connection interrupted. Your capture is saved on this device and will sync automatically.", 5200);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "CONFIRM + SYNC";
    }
  }
  function openProfileDialog(afterCapture = false) {
    elements.displayNameInput.value = state.profile?.displayName || "";
    elements.communityNotice.checked = Boolean(state.profile);
    elements.profileDialog.dataset.afterCapture = afterCapture ? "true" : "false";
    elements.profileDialog.showModal();
  }
  async function saveProfile(event) {
    event.preventDefault();
    const displayName = sanitizeName(elements.displayNameInput.value);
    if (displayName.length < 2) {
      toast("Display name must be at least two characters.");
      return;
    }
    const existing = state.profile || {};
    const profile = { id: existing.id || uuid(), displayName, settings: existing.settings || { reducedData: false }, source: "canopyquest" };
    const submitButton = elements.profileForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = "SAVING…";
    try {
      const result = await request("/v1/players", { method: "POST", body: JSON.stringify(profile) });
      saveProfileLocal(result.player);
      toast("Profile synced across devices with your private player ID.");
    } catch (_error) {
      saveProfileLocal({ ...existing, ...profile, xp: existing.xp || 0, currentStreak: existing.currentStreak || 0 });
      toast("Profile saved on this device. It will sync when the game service is available.");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "SAVE PROFILE";
      const resume = elements.profileDialog.dataset.afterCapture === "true";
      elements.profileDialog.close();
      if (resume && state.analysis) elements.confirmDialog.showModal();
    }
  }
  function registerEvents() {
    elements.enableFieldMode.addEventListener("click", enableFieldMode);
    elements.demoModeButton.addEventListener("click", startDemo);
    elements.captureButton.addEventListener("click", scanTree);
    elements.profileButton.addEventListener("click", () => openProfileDialog(false));
    elements.aboutButton.addEventListener("click", () => elements.aboutDialog.showModal());
    elements.questsButton.addEventListener("click", () => elements.questsDialog.showModal());
    elements.leadersButton.addEventListener("click", () => { elements.leadersDialog.showModal(); renderLeaders("weekly"); });
    elements.syncButton.addEventListener("click", async () => {
      await Promise.all([loadSharedData(), flushQueue()]);
      toast(state.queueCount ? `${state.queueCount} capture${state.queueCount === 1 ? "" : "s"} waiting for connection.` : "Shared inventory is up to date.");
    });
    elements.profileForm.addEventListener("submit", saveProfile);
    elements.confirmForm.addEventListener("submit", confirmCapture);
    elements.retryButton.addEventListener("click", () => { elements.confirmDialog.close(); scanTree(); });
    document.querySelectorAll("[data-close]").forEach(button => {
      button.addEventListener("click", () => button.closest("dialog").close());
    });
    document.querySelectorAll("[data-period]").forEach(button => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-period]").forEach(tab => tab.classList.toggle("active", tab === button));
        renderLeaders(button.dataset.period);
      });
    });
    window.addEventListener("resize", drawMap);
    window.addEventListener("online", () => { setSyncState("SYNCING"); flushQueue(); });
    window.addEventListener("offline", () => setSyncState("OFFLINE", true));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushQueue(); });
  }
  async function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("./sw.js", { scope: "./" }); }
      catch (error) { console.warn("Service worker unavailable", error); }
    }
  }
  async function init() {
    loadProfileLocal();
    renderProfile();
    renderQuests(DEFAULT_QUESTS);
    registerEvents();
    updateLocationHud();
    drawMap();
    await updateQueueCount();
    Promise.allSettled([loadBoundary(), loadSharedData(), registerServiceWorker(), flushQueue()]);
    setTimeout(() => {
      if (!state.stream && !state.demo && !elements.permissionDialog.open) elements.permissionDialog.showModal();
    }, 450);
    if (!state.profile) setTimeout(() => toast("Create a trail name before your first real capture."), 1800);
  }

  window.CanopyQuest = Object.freeze({ distanceMeters, pointInPolygon, sanitizeName, levelProgress, matchNearbyTree });
  init();
})();
