(function () {
  "use strict";

  const isLocalPreview = ["localhost", "127.0.0.1"].includes(window.location?.hostname);
  const API_URL = String(isLocalPreview
    ? "http://127.0.0.1:9"
    : window.ORANGE_TREE_DATABASE_URL || "https://orange-tree-database.vercel.app").replace(/\/$/, "");
  const ORANGE_BOUNDARY_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/1/query?where=STATE%3D%2734%27%20AND%20COUSUB%3D%2713045%27&outFields=GEOID%2CNAME&returnGeometry=true&outSR=4326&f=geojson";
  const ORANGE_STREETS_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer/2/query?where=1%3D1&geometry=-74.2605%2C40.748%2C-74.2125%2C40.792&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=BASENAME%2CNAME%2CMTFCC&returnGeometry=true&outSR=4326&f=geojson";
  const QUEUE_KEY = "canopyQuestCaptureQueueV2";
  const MAX_QUEUED_CAPTURES = 100;
  const QUEUE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const LEGACY_QUEUE_DB = "canopyquest";
  const LEGACY_QUEUE_STORE = "captures";
  const LEGACY_MIGRATION_TIMEOUT_MS = 2000;
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
    stream: null, location: null, heading: null, trees: [], streets: [], boundary: FALLBACK_BOUNDARY,
    profile: null, dashboard: null, analysis: null, matchedTree: null, demo: false,
    scanning: false, syncing: false, queueCount: 0, lastFrameHash: null,
    leafPhotoHash: null, leafIdentification: null, awaitingLeafPhoto: false, treeFrameMeta: null,
    uploadedImage: null, uploadedObjectUrl: null, uploadedFileMeta: null,
    photoJob: 0, confirming: false, completionCaptureId: null, pendingCaptureId: null,
    sessionCaptures: 0, memoryQueue: [], discardedCaptureIds: new Set(), mapDrawPending: false, profileSyncPromise: null,
    resettingCapture: false, lastOrientationDraw: 0, cameraJob: 0, lastCaptureMode: "live",
    mapView: {
      perspective: false, follow: true, zoom: 1, panX: 0, panY: 0, tilt: 0.82,
      frozenHeading: null, frozenLocation: null
    },
    mapGesture: { pointers: new Map(), lastDistance: 0 }
  };
  const elements = {};
  [
    "app", "camera", "captureCanvas", "mapCanvas", "permissionDialog", "profileDialog",
    "confirmDialog", "completionDialog", "questsDialog", "leadersDialog", "aboutDialog", "enableFieldMode",
    "demoModeButton", "captureButton", "profileButton", "aboutButton", "questsButton", "takePhotoButton",
    "leadersButton", "syncButton", "profileForm", "confirmForm", "retryButton",
    "addLeafPhotoButton", "leafPhotoStatus", "confirmSubmitButton",
    "displayNameInput", "communityNotice", "playerName", "avatarInitials", "levelValue",
    "xpText", "xpBar", "streakValue", "syncLabel", "priorityText", "accuracyText",
    "wardText", "coordinatesText", "captureHeadline", "captureInstruction", "rewardPreview",
    "speciesValue", "confidenceValue", "heightValue", "canopyValue", "dbhValue",
    "healthValue", "modelLabel", "analysisCard", "speciesInput", "conditionInput",
    "heightInput", "canopyInput", "dbhInput", "notesInput", "matchNotice", "questList",
    "questBadge", "leaderList", "toast", "rewardBurst", "shareButton", "photoPreview",
    "photoInput", "choosePhotoButton", "mapPerspectiveButton", "mapRecenterButton",
    "confirmStatus", "completionTitle", "completionMessage", "completionXp", "completionChain",
    "completionStatus", "completionLocationButton", "discardCaptureButton",
    "nextTreeButton", "completionShareButton"
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
  function parseExifGps(arrayBuffer) {
    if (!arrayBuffer || typeof arrayBuffer.byteLength !== "number" || arrayBuffer.byteLength < 16) return null;
    let view;
    try { view = new DataView(arrayBuffer); } catch (_error) { return null; }
    if (view.getUint16(0, false) !== 0xffd8) return null;

    let markerOffset = 2;
    while (markerOffset + 4 <= view.byteLength) {
      if (view.getUint8(markerOffset) !== 0xff) break;
      const marker = view.getUint8(markerOffset + 1);
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        markerOffset += 2;
        continue;
      }
      const segmentLength = view.getUint16(markerOffset + 2, false);
      if (segmentLength < 2 || markerOffset + 2 + segmentLength > view.byteLength) break;
      const dataStart = markerOffset + 4;
      const segmentEnd = markerOffset + 2 + segmentLength;
      const isExif = marker === 0xe1
        && dataStart + 6 <= segmentEnd
        && view.getUint32(dataStart, false) === 0x45786966
        && view.getUint16(dataStart + 4, false) === 0;
      if (isExif) {
        const tiffStart = dataStart + 6;
        if (tiffStart + 8 > segmentEnd) return null;
        const byteOrder = view.getUint16(tiffStart, false);
        const littleEndian = byteOrder === 0x4949;
        if (!littleEndian && byteOrder !== 0x4d4d) return null;
        const readU16 = offset => {
          if (offset < tiffStart || offset + 2 > segmentEnd) throw new RangeError("Invalid EXIF offset");
          return view.getUint16(offset, littleEndian);
        };
        const readU32 = offset => {
          if (offset < tiffStart || offset + 4 > segmentEnd) throw new RangeError("Invalid EXIF offset");
          return view.getUint32(offset, littleEndian);
        };
        try {
          if (readU16(tiffStart + 2) !== 42) return null;
          const ifd0 = tiffStart + readU32(tiffStart + 4);
          const entryCount = readU16(ifd0);
          let gpsIfd = null;
          for (let index = 0; index < entryCount; index += 1) {
            const entry = ifd0 + 2 + index * 12;
            if (readU16(entry) === 0x8825) {
              gpsIfd = tiffStart + readU32(entry + 8);
              break;
            }
          }
          if (!gpsIfd) return null;
          const gpsEntries = readU16(gpsIfd);
          const tags = new Map();
          for (let index = 0; index < gpsEntries; index += 1) {
            const entry = gpsIfd + 2 + index * 12;
            const tag = readU16(entry);
            const type = readU16(entry + 2);
            const count = readU32(entry + 4);
            const valueOffset = type === 2 && count <= 4 ? entry + 8 : tiffStart + readU32(entry + 8);
            tags.set(tag, { type, count, valueOffset });
          }
          const readReference = tag => {
            const item = tags.get(tag);
            if (!item || item.type !== 2 || item.valueOffset >= segmentEnd) return "";
            return String.fromCharCode(view.getUint8(item.valueOffset)).toUpperCase();
          };
          const readCoordinate = tag => {
            const item = tags.get(tag);
            if (!item || item.type !== 5 || item.count < 3) return null;
            const values = [];
            for (let index = 0; index < 3; index += 1) {
              const numerator = readU32(item.valueOffset + index * 8);
              const denominator = readU32(item.valueOffset + index * 8 + 4);
              if (!denominator) return null;
              values.push(numerator / denominator);
            }
            return values[0] + values[1] / 60 + values[2] / 3600;
          };
          let latitude = readCoordinate(2);
          let longitude = readCoordinate(4);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
          if (readReference(1) === "S") latitude *= -1;
          if (readReference(3) === "W") longitude *= -1;
          if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
          return { latitude, longitude };
        } catch (_error) {
          return null;
        }
      }
      markerOffset = segmentEnd;
    }
    return null;
  }
  function toast(message, duration = 3200) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => elements.toast.classList.remove("show"), duration);
  }
  function withTimeout(promise, timeoutMs, message = "Operation timed out.") {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      })
    ]).finally(() => clearTimeout(timer));
  }
  async function fetchJson(url, { timeoutMs = 6500, ...options } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async function request(path, options = {}) {
    const { timeoutMs = 6500, ...fetchOptions } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "Accept": "application/json", ...(fetchOptions.headers || {}) };
      if (fetchOptions.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      const response = await fetch(API_URL + path, { ...fetchOptions, headers, signal: controller.signal });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || `Database request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("The game service did not respond in time.");
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  function ensureProfileSynced() {
    if (!state.profile?.id || state.profile.serverSynced !== false) return Promise.resolve(true);
    if (state.profileSyncPromise) return state.profileSyncPromise;
    const payload = {
      id: state.profile.id,
      displayName: state.profile.displayName,
      settings: state.profile.settings || { reducedData: false },
      source: "canopyquest"
    };
    state.profileSyncPromise = request("/v1/players", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 5000
    }).then(result => {
      saveProfileLocal({ ...state.profile, ...(result?.player || {}), serverSynced: true });
      return true;
    }).catch(error => {
      if (error.status === 409) {
        saveProfileLocal({ ...state.profile, serverSynced: true });
        return true;
      }
      return false;
    }).finally(() => {
      state.profileSyncPromise = null;
    });
    return state.profileSyncPromise;
  }
  function saveProfileLocal(profile) {
    state.profile = profile;
    try { localStorage.setItem("canopyQuestPlayer", JSON.stringify(profile)); }
    catch (_error) { /* The active session can still continue without profile persistence. */ }
    renderProfile();
  }
  function loadProfileLocal() {
    try {
      const profile = JSON.parse(localStorage.getItem("canopyQuestPlayer") || "null");
      if (profile?.id) state.profile = profile;
    } catch (_error) {
      try { localStorage.removeItem("canopyQuestPlayer"); }
      catch (_storageError) { /* Continue with an in-memory profile. */ }
    }
  }
  function levelProgress(xp = 0) {
    const level = Math.floor(Math.sqrt(Math.max(0, xp) / 250)) + 1;
    const floor = Math.pow(level - 1, 2) * 250;
    const ceiling = Math.pow(level, 2) * 250;
    return { level, floor, ceiling, percent: Math.min(100, ((xp - floor) / Math.max(1, ceiling - floor)) * 100) };
  }
  function renderProfile() {
    const profile = state.profile || state.dashboard?.player || {};
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
      elements.accuracyText.textContent = "PHOTO LOCATION —";
      elements.wardText.textContent = "WARD —";
      elements.coordinatesText.textContent = "NO PHOTO LOCATION";
      elements.priorityText.textContent = state.uploadedImage ? "PHOTO READY · NO LOCATION DATA" : "OPEN CAMERA OR CHOOSE PHOTO";
      drawMap();
      return;
    }
    elements.accuracyText.textContent = location.source === "photo-exif"
      ? "PHOTO LOCATION"
      : `LOCATION ±${Math.round(location.accuracy || 0)} m`;
    elements.wardText.textContent = `WARD ${wardFor(location.latitude, location.longitude)}`;
    elements.coordinatesText.textContent = `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
    const nearest = nearestPriority(location);
    elements.priorityText.textContent = location.source === "photo-exif"
      ? `${nearest.area.label} · PHOTO LOCATION`
      : `${nearest.area.label} · ${Math.round(nearest.distance)} m`;
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
  function mapMeters(longitude, latitude, originLongitude, originLatitude) {
    const metersPerLongitudeDegree = 111320 * Math.cos(radians(originLatitude));
    return {
      east: (longitude - originLongitude) * metersPerLongitudeDegree,
      north: (latitude - originLatitude) * 111132
    };
  }
  function mapScale(width, height) {
    const centerLatitude = (MAP_BOUNDS.south + MAP_BOUNDS.north) / 2;
    const mapWidthMeters = (MAP_BOUNDS.east - MAP_BOUNDS.west) * 111320 * Math.cos(radians(centerLatitude));
    const mapHeightMeters = (MAP_BOUNDS.north - MAP_BOUNDS.south) * 111132;
    return Math.min(width / mapWidthMeters, height / mapHeightMeters) * .94;
  }
  function baseMapPoint(longitude, latitude, width, height) {
    const centerLongitude = (MAP_BOUNDS.west + MAP_BOUNDS.east) / 2;
    const centerLatitude = (MAP_BOUNDS.south + MAP_BOUNDS.north) / 2;
    const projected = mapMeters(longitude, latitude, centerLongitude, centerLatitude);
    const scale = mapScale(width, height);
    return [width / 2 + projected.east * scale, height / 2 - projected.north * scale];
  }
  function mapPoint(longitude, latitude, width, height) {
    const view = state.mapView;
    const activeLocation = view.follow ? state.location : view.frozenLocation;
    if (!view.perspective || !activeLocation) {
      const [x, y] = baseMapPoint(longitude, latitude, width, height);
      return [x * view.zoom + view.panX + width * (1 - view.zoom) / 2, y * view.zoom + view.panY + height * (1 - view.zoom) / 2];
    }
    const projected = mapMeters(
      longitude,
      latitude,
      activeLocation.longitude,
      activeLocation.latitude
    );
    const activeHeading = view.follow ? state.heading : view.frozenHeading;
    const bearing = Number.isFinite(activeHeading) ? radians(activeHeading) : 0;
    const right = projected.east * Math.cos(bearing) - projected.north * Math.sin(bearing);
    const forward = projected.east * Math.sin(bearing) + projected.north * Math.cos(bearing);
    const scale = mapScale(width, height) * view.zoom;
    return [
      width / 2 + right * scale + view.panX,
      height * .66 - forward * scale * view.tilt + view.panY
    ];
  }
  function scheduleMapDraw() {
    if (state.mapDrawPending) return;
    state.mapDrawPending = true;
    const schedule = window.requestAnimationFrame || (callback => setTimeout(callback, 16));
    schedule(() => {
      state.mapDrawPending = false;
      drawMap();
    });
  }
  function normalizeStreetFeatures(data) {
    return (data?.features || []).flatMap(feature => {
      const name = sanitizeName(feature.properties?.NAME || feature.properties?.BASENAME || "");
      const geometry = feature.geometry || {};
      const lines = geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.type === "MultiLineString" ? geometry.coordinates : [];
      return lines
        .filter(line => Array.isArray(line) && line.length > 1)
        .map(line => ({ name, coordinates: line.filter(point => Array.isArray(point) && point.length >= 2) }))
        .filter(street => street.coordinates.length > 1);
    });
  }
  function drawFallbackGrid(context, width, height) {
    context.save();
    context.strokeStyle = "rgba(206, 225, 202, .17)";
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
      context.strokeStyle = index % 2 === 0 ? "rgba(223, 233, 215, .24)" : "rgba(206, 225, 202, .14)";
    });
    context.restore();
  }
  function drawStreets(context, width, height) {
    if (!state.streets.length) {
      drawFallbackGrid(context, width, height);
      return;
    }
    const labelCandidates = [];
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    state.streets.forEach(street => {
      let length = 0;
      let previous = null;
      context.beginPath();
      street.coordinates.forEach(([longitude, latitude], index) => {
        const point = mapPoint(longitude, latitude, width, height);
        if (index === 0) context.moveTo(point[0], point[1]); else context.lineTo(point[0], point[1]);
        if (previous) length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
        previous = point;
      });
      context.strokeStyle = "rgba(218, 230, 214, .27)";
      context.lineWidth = street.name ? 1.15 : .7;
      context.stroke();
      if (street.name && length > 38) {
        const middle = street.coordinates[Math.floor(street.coordinates.length / 2)];
        const point = mapPoint(middle[0], middle[1], width, height);
        if (point[0] >= -20 && point[0] <= width + 20 && point[1] >= -20 && point[1] <= height + 20) {
          labelCandidates.push({ name: street.name, point, length });
        }
      }
    });
    context.restore();
    const seen = new Set();
    const occupied = [];
    context.save();
    context.font = '600 8px "Barlow Condensed", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    labelCandidates.sort((left, right) => right.length - left.length).some(candidate => {
      if (seen.has(candidate.name)) return false;
      const label = candidate.name.toUpperCase();
      const textWidth = Math.min(92, context.measureText(label).width + 8);
      const box = { x: candidate.point[0] - textWidth / 2, y: candidate.point[1] - 7, width: textWidth, height: 14 };
      const overlaps = occupied.some(item => box.x < item.x + item.width && box.x + box.width > item.x && box.y < item.y + item.height && box.y + box.height > item.y);
      if (overlaps || box.x < 2 || box.x + box.width > width - 2 || box.y < 2 || box.y + box.height > height - 2) return false;
      occupied.push(box);
      seen.add(candidate.name);
      context.lineWidth = 3;
      context.strokeStyle = "rgba(5, 27, 22, .82)";
      context.strokeText(label, candidate.point[0], candidate.point[1]);
      context.fillStyle = "rgba(224, 237, 220, .82)";
      context.fillText(label, candidate.point[0], candidate.point[1]);
      return occupied.length >= 12;
    });
    context.restore();
  }
  function drawMap() {
    const canvas = elements.mapCanvas;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    context.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    if (!context.setTransform) context.scale(dpr, dpr);
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#17363a");
    gradient.addColorStop(1, "#173326");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    drawStreets(context, width, height);
    context.beginPath();
    state.boundary.forEach(([longitude, latitude], index) => {
      const [x, y] = mapPoint(longitude, latitude, width, height);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.closePath();
    context.fillStyle = "rgba(48, 101, 57, .16)";
    context.fill();
    context.strokeStyle = "#d5ff85";
    context.lineWidth = 2;
    context.shadowColor = "rgba(201, 255, 104, .45)";
    context.shadowBlur = 6;
    context.stroke();
    context.shadowBlur = 0;
    state.trees.slice(0, 600).forEach(tree => {
      const coordinates = treeLocation(tree);
      if (!coordinates) return;
      const [x, y] = mapPoint(coordinates.longitude, coordinates.latitude, width, height);
      if (x < -5 || x > width + 5 || y < -5 || y > height + 5) return;
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
      if (x < -30 || x > width + 30 || y < -30 || y > height + 30) return;
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
      const heading = state.mapView.perspective ? -Math.PI / 2 : radians(Number(state.heading || 0) - 90);
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
    const viewDescription = state.mapView.perspective && (state.mapView.follow ? state.location : state.mapView.frozenLocation)
      ? "heading-up perspective"
      : "north-up";
    canvas.setAttribute?.("aria-label", `Map of Orange showing ${state.trees.length} trees and ${state.streets.length} street segments in ${viewDescription} view.`);
  }
  async function loadBoundary() {
    try {
      const data = await fetchJson(ORANGE_BOUNDARY_URL, { timeoutMs: 5000 });
      const geometry = data.features?.[0]?.geometry;
      const ring = geometry?.type === "Polygon" ? geometry.coordinates?.[0] : geometry?.coordinates?.[0]?.[0];
      if (Array.isArray(ring) && ring.length > 20) state.boundary = ring;
    } catch (_error) {
      // The reviewed Census-derived fallback remains available offline.
    }
    drawMap();
  }
  async function loadStreets() {
    try {
      const data = await fetchJson(ORANGE_STREETS_URL, { timeoutMs: 6500 });
      const streets = normalizeStreetFeatures(data);
      if (streets.length) {
        state.streets = streets;
      }
    } catch (_error) {
      // Cached streets or the lightweight fallback remain available.
    }
    scheduleMapDraw();
  }
  function setSyncState(label, offline = false) {
    elements.syncLabel.textContent = label;
    elements.syncButton.classList.toggle("offline", offline);
  }
  async function loadSharedData({ fresh = false } = {}) {
    setSyncState(state.trees.length ? "SYNC" : "SYNCING");
    if (state.trees.length) drawMap();
    try {
      const treeResult = await request(`/v1/trees${fresh ? `?refresh=${Date.now()}` : ""}`);
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
      saveProfileLocal({ ...result.player, serverSynced: true });
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
  function waitForVideoFrame(video, timeoutMs = 5000) {
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", ready);
        video.removeEventListener("canplay", ready);
        video.removeEventListener("error", failed);
      };
      const ready = () => {
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("Camera preview could not be read."));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Camera preview timed out."));
      }, timeoutMs);
      video.addEventListener("loadeddata", ready);
      video.addEventListener("canplay", ready);
      video.addEventListener("error", failed);
    });
  }
  async function enableCamera({ preservePhoto = false } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera is not supported by this browser.");
    stopCamera();
    const cameraJob = state.cameraJob;
    let timedOut = false;
    const mediaPromise = navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    }).then(stream => {
      if (timedOut || cameraJob !== state.cameraJob) {
        stream.getTracks?.().forEach(item => item.stop());
        throw new Error(timedOut ? "Camera permission timed out." : "Camera request was cancelled.");
      }
      return stream;
    });
    let stream;
    try {
      stream = await withTimeout(mediaPromise, 10000, "Camera permission timed out.");
    } catch (error) {
      timedOut = error.name === "TimeoutError";
      if (timedOut) mediaPromise.catch(() => null);
      throw error;
    }
    const track = stream.getVideoTracks?.()[0];
    if (!track || track.readyState === "ended") {
      stream.getTracks?.().forEach(item => item.stop());
      throw new Error("The camera did not start.");
    }
    if (!preservePhoto) {
      if (state.uploadedObjectUrl) URL.revokeObjectURL(state.uploadedObjectUrl);
      if (state.location?.source === "photo-exif") state.location = null;
      state.uploadedImage = null;
      state.uploadedObjectUrl = null;
      state.uploadedFileMeta = null;
    }
    elements.photoPreview.hidden = true;
    elements.photoPreview.removeAttribute("src");
    updateLocationHud();
    state.stream = stream;
    elements.camera.srcObject = stream;
    try {
      await withTimeout(elements.camera.play(), 5000, "Camera preview timed out.");
      await waitForVideoFrame(elements.camera, 5000);
    } catch (error) {
      stream.getTracks?.().forEach(item => item.stop());
      state.stream = null;
      elements.camera.srcObject = null;
      throw error;
    }
  }
  function stopCamera() {
    state.cameraJob += 1;
    state.stream?.getTracks?.().forEach(track => track.stop());
    state.stream = null;
    if (elements.camera) elements.camera.srcObject = null;
  }
  async function requestOrientation({ prompt = false } = {}) {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        if (!prompt) return;
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== "granted") return;
      }
      const eventName = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
      window.removeEventListener?.(eventName, onOrientation, true);
      window.addEventListener(eventName, onOrientation, true);
    } catch (_error) {
      // Heading is optional.
    }
  }
  function compassHeading(alpha, beta, gamma) {
    if (![alpha, beta, gamma].every(Number.isFinite)) return null;
    const x = radians(beta);
    const y = radians(gamma);
    const z = radians(alpha);
    const cosineX = Math.cos(x);
    const sineX = Math.sin(x);
    const cosineY = Math.cos(y);
    const sineY = Math.sin(y);
    const cosineZ = Math.cos(z);
    const sineZ = Math.sin(z);
    if (Math.abs(Math.sin(x)) + Math.abs(Math.sin(y)) < .01) return (360 - alpha) % 360;
    const vectorX = -cosineZ * sineY - sineZ * sineX * cosineY;
    const vectorY = -sineZ * sineY + cosineZ * sineX * cosineY;
    return (Math.atan2(vectorX, vectorY) * 180 / Math.PI + 360) % 360;
  }
  function onOrientation(event) {
    const orientationAngle = Number(window.screen?.orientation?.angle || window.orientation || 0);
    const rawHeading = event.webkitCompassHeading
      ?? (event.absolute ? compassHeading(event.alpha, event.beta, event.gamma) : null);
    if (!Number.isFinite(rawHeading)) return;
    const normalized = (rawHeading + orientationAngle + 360) % 360;
    if (Number.isFinite(state.heading)) {
      const delta = ((normalized - state.heading + 540) % 360) - 180;
      if (Math.abs(delta) < 1.5) return;
      state.heading = (state.heading + delta * .18 + 360) % 360;
    } else {
      state.heading = normalized;
    }
    if (Number.isFinite(event.beta)) state.mapView.tilt = Math.max(.68, Math.min(.9, .9 - Math.abs(event.beta - 55) / 180));
    const now = Date.now();
    if (now - state.lastOrientationDraw >= 80) {
      state.lastOrientationDraw = now;
      scheduleMapDraw();
    }
  }
  async function enableFieldMode() {
    elements.enableFieldMode.disabled = true;
    elements.enableFieldMode.textContent = "OPENING CAMERA…";
    try {
      await enableCamera();
      if (elements.permissionDialog.open) elements.permissionDialog.close();
      elements.captureHeadline.textContent = "CAMERA READY";
      elements.captureInstruction.textContent = "Aim at a tree and tap capture";
      elements.captureButton.querySelector(".capture-label").textContent = "CAPTURE";
      requestOrientation().catch(() => null);
    } catch (error) {
      if (elements.permissionDialog.open) elements.permissionDialog.close();
      toast(`${error.message || "Camera unavailable"} Choose an existing photo instead.`, 5200);
    } finally {
      elements.enableFieldMode.disabled = false;
      elements.enableFieldMode.textContent = "USE IN-APP CAMERA";
    }
  }
  function startDemo() {
    state.demo = true;
    state.location = { ...DEMO_LOCATION, source: "demo" };
    updateLocationHud();
    elements.captureHeadline.textContent = "PREVIEW MODE";
    elements.captureInstruction.textContent = "Try the scanner—no record will be submitted";
    elements.captureButton.querySelector(".capture-label").textContent = "SCAN";
    if (elements.permissionDialog.open) elements.permissionDialog.close();
  }
  function loadPhotoPreview(objectUrl, jobId) {
    return new Promise((resolve, reject) => {
      const image = elements.photoPreview;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        callback(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("Photo decoding timed out. Try a JPEG, PNG, or WebP image.")), 10000);
      image.onload = () => {
        if (jobId !== state.photoJob) return finish(reject, new Error("A newer photo was selected."));
        if (!image.naturalWidth || !image.naturalHeight) return finish(reject, new Error("The selected photo has no readable image data."));
        finish(resolve, image);
      };
      image.onerror = () => finish(reject, new Error("This image format is not supported on this device. Try JPEG, PNG, or WebP."));
      image.src = objectUrl;
      if (typeof image.decode === "function") {
        image.decode().then(() => {
          if (image.naturalWidth && image.naturalHeight) finish(resolve, image);
        }).catch(() => {
          // Load/error events provide the cross-browser fallback.
        });
      } else if (image.complete && image.naturalWidth) {
        finish(resolve, image);
      }
    });
  }
  async function readPhotoGps(file) {
    try {
      const exifBytes = await withTimeout(file.slice(0, 1024 * 1024).arrayBuffer(), 3000, "Photo metadata timed out.");
      return parseExifGps(exifBytes);
    } catch (_error) {
      return null;
    }
  }
  function parseImageDimensions(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 24) return null;
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    if (
      view.getUint32(0, false) === 0x89504e47
      && view.getUint32(4, false) === 0x0d0a1a0a
    ) {
      return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
    }
    if (view.getUint16(0, false) === 0xffd8) {
      let offset = 2;
      const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
      while (offset + 9 < view.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        if (sofMarkers.has(marker)) {
          return { width: view.getUint16(offset + 7, false), height: view.getUint16(offset + 5, false) };
        }
        if (marker === 0xda || marker === 0xd9) break;
        const segmentLength = view.getUint16(offset + 2, false);
        if (segmentLength < 2) break;
        offset += segmentLength + 2;
      }
    }
    const ascii = start => String.fromCharCode(...bytes.slice(start, start + 4));
    if (ascii(0) === "RIFF" && ascii(8) === "WEBP") {
      const chunk = ascii(12);
      if (chunk === "VP8X" && view.byteLength >= 30) {
        const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
        const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
        return { width, height };
      }
      if (chunk === "VP8L" && view.byteLength >= 25 && bytes[20] === 0x2f) {
        const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
        const height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
        return { width, height };
      }
      if (chunk === "VP8 " && view.byteLength >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff
        };
      }
    }
    return null;
  }
  async function readPhotoDimensions(file) {
    try {
      const bytes = await withTimeout(file.slice(0, 1024 * 1024).arrayBuffer(), 2500, "Photo header timed out.");
      return parseImageDimensions(bytes);
    } catch (_error) {
      return null;
    }
  }
  async function createBoundedPhotoPreview(file, originalObjectUrl, jobId, dimensions) {
    if (typeof window.createImageBitmap !== "function") {
      if (file.size > 12 * 1024 * 1024) {
        throw new Error("This browser cannot safely resize that large photo. Choose one under 12 MB.");
      }
      return { image: await loadPhotoPreview(originalObjectUrl, jobId), objectUrl: originalObjectUrl };
    }
    let bitmap;
    let boundedObjectUrl;
    try {
      const scale = dimensions
        ? Math.min(1, 1600 / Math.max(dimensions.width, dimensions.height))
        : null;
      const resizeOptions = scale
        ? {
            resizeWidth: Math.max(1, Math.round(dimensions.width * scale)),
            resizeHeight: Math.max(1, Math.round(dimensions.height * scale)),
            resizeQuality: "high"
          }
        : { resizeWidth: 1600, resizeQuality: "high" };
      bitmap = await withTimeout(
        window.createImageBitmap(file, { imageOrientation: "from-image", ...resizeOptions }),
        10000,
        "Photo decoding timed out."
      );
      const canvasScale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * canvasScale));
      canvas.height = Math.max(1, Math.round(bitmap.height * canvasScale));
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await withTimeout(
        new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .82)),
        2500,
        "Photo preview timed out."
      );
      if (!blob) throw new Error("The photo preview could not be created.");
      boundedObjectUrl = URL.createObjectURL(blob);
      const image = await loadPhotoPreview(boundedObjectUrl, jobId);
      URL.revokeObjectURL(originalObjectUrl);
      return { image, objectUrl: boundedObjectUrl };
    } catch (_error) {
      if (boundedObjectUrl) URL.revokeObjectURL(boundedObjectUrl);
      if (file.size > 12 * 1024 * 1024) {
        throw new Error("This browser could not safely resize that large photo. Choose one under 12 MB.");
      }
      return { image: await loadPhotoPreview(originalObjectUrl, jobId), objectUrl: originalObjectUrl };
    } finally {
      bitmap?.close?.();
    }
  }
  async function choosePhoto(event) {
    const fromCamera = false;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (elements.permissionDialog.open) elements.permissionDialog.close();
    stopCamera();
    if (file.type && !String(file.type).startsWith("image/")) {
      toast("Choose an image file.");
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      toast("That photo is too large for a reliable mobile scan. Choose one under 30 MB.", 5200);
      return;
    }
    const jobId = ++state.photoJob;
    const previousObjectUrl = state.uploadedObjectUrl;
    const objectUrl = URL.createObjectURL(file);
    let preparedObjectUrl = objectUrl;
    elements.choosePhotoButton.disabled = true;
    elements.takePhotoButton.disabled = true;
    elements.choosePhotoButton.textContent = "READING PHOTO…";
    elements.takePhotoButton.textContent = "READING PHOTO…";
    elements.captureHeadline.textContent = "OPENING PHOTO";
    elements.captureInstruction.textContent = "Preparing a fast on-device preview…";
    try {
      const gpsPromise = readPhotoGps(file);
      const dimensions = await readPhotoDimensions(file);
      const [gps, preparedPhoto] = await Promise.all([
        gpsPromise,
        createBoundedPhotoPreview(file, objectUrl, jobId, dimensions)
      ]);
      preparedObjectUrl = preparedPhoto.objectUrl;
      if (jobId !== state.photoJob) throw new Error("A newer photo was selected.");
      state.demo = false;
      state.location = null;
      state.uploadedObjectUrl = preparedPhoto.objectUrl;
      state.uploadedImage = preparedPhoto.image;
      state.uploadedFileMeta = {
        type: file.type || "image",
        size: file.size,
        lastModified: file.lastModified || Date.now(),
        gpsReadFromExif: Boolean(gps),
        fromCamera,
        locationConsent: gps ? "photo-exif" : "photo-only"
      };
      elements.photoPreview.hidden = false;
      if (gps) {
        state.location = {
          ...gps,
          accuracy: 15,
          capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
          source: "photo-exif"
        };
      }
      if (previousObjectUrl && previousObjectUrl !== preparedPhoto.objectUrl) URL.revokeObjectURL(previousObjectUrl);
      updateLocationHud();
      elements.captureHeadline.textContent = gps ? "PHOTO READY · LOCATION FOUND" : "PHOTO READY";
      elements.captureInstruction.textContent = gps
        ? "Tap the scanner to identify this tree"
        : "Tap to identify; this photo has no embedded location";
      elements.captureButton.querySelector(".capture-label").textContent = "SCAN PHOTO";
      toast(gps
        ? "Photo location found. Ready to scan."
        : "Photo ready. No embedded location was found.");
    } catch (error) {
      URL.revokeObjectURL(preparedObjectUrl);
      if (preparedObjectUrl !== objectUrl) URL.revokeObjectURL(objectUrl);
      if (jobId === state.photoJob && previousObjectUrl) {
        elements.photoPreview.src = previousObjectUrl;
        elements.photoPreview.hidden = false;
      }
      console.warn("Photo could not be opened", error);
      elements.captureHeadline.textContent = "PHOTO NOT OPENED";
      elements.captureInstruction.textContent = "Try a JPEG, PNG, or WebP photo";
      toast(error.message || "That photo could not be opened. Try a JPEG, PNG, or WebP.", 5200);
    } finally {
      elements.choosePhotoButton.disabled = false;
      elements.takePhotoButton.disabled = false;
      elements.choosePhotoButton.textContent = "CHOOSE EXISTING PHOTO";
      elements.takePhotoButton.textContent = "TAKE A PHOTO";
    }
  }
  function drawImageCover(context, image, width, height) {
    const sourceWidth = image.naturalWidth || image.videoWidth || width;
    const sourceHeight = image.naturalHeight || image.videoHeight || height;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }
  function hasLiveCamera() {
    const track = state.stream?.getVideoTracks?.()[0];
    return Boolean(track && track.readyState === "live" && elements.camera.readyState >= 2 && elements.camera.videoWidth);
  }
  function captureFrame(source = "auto") {
    const canvas = elements.captureCanvas;
    const video = elements.camera;
    const useUploadedImage = source !== "live" && state.uploadedImage;
    const sourceWidth = useUploadedImage?.naturalWidth || video.videoWidth || 640;
    const sourceHeight = useUploadedImage?.naturalHeight || video.videoHeight || 960;
    const scale = Math.min(1, 1024 / Math.max(sourceWidth, sourceHeight));
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (useUploadedImage) {
      drawImageCover(context, useUploadedImage, width, height);
    } else if (hasLiveCamera()) {
      drawImageCover(context, video, width, height);
    } else if (state.demo) {
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
    } else {
      throw new Error("The camera preview stopped. Take a photo or reopen live camera.");
    }
    const sampleSize = Math.min(256, width, height);
    const sampleX = Math.max(0, Math.round((width - sampleSize) / 2));
    const sampleY = Math.max(0, Math.round((height - sampleSize) / 2));
    return { canvas, imageData: context.getImageData(sampleX, sampleY, sampleSize, sampleSize), width, height };
  }
  async function hashImageData(imageData) {
    if (!crypto.subtle) return `fallback-${Date.now()}`;
    const digest = await withTimeout(
      crypto.subtle.digest("SHA-256", imageData.data),
      500,
      "Image hash timed out."
    ).catch(() => null);
    if (!digest) return `fallback-${Date.now()}`;
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  function canvasToJpegBlob(canvas) {
    return withTimeout(
      new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The leaf photo could not be encoded.")), "image/jpeg", 0.88);
      }),
      3000,
      "The leaf photo took too long to encode."
    );
  }
  function setSpeciesResult(identification) {
    const confirmed = Boolean(identification?.confirmed && identification.speciesPrediction !== "Unknown");
    const speciesName = confirmed ? identification.speciesPrediction : "Unknown";
    elements.speciesInput.replaceChildren(new Option(speciesName, speciesName));
    elements.speciesInput.value = speciesName;
    elements.speciesValue.textContent = speciesName.toUpperCase();
    elements.confidenceValue.textContent = confirmed
      ? `${Math.round(identification.speciesConfidence * 100)}%`
      : "—";
    elements.modelLabel.textContent = confirmed
      ? `${identification.model} · leaf-index match`
      : "Species unconfirmed · leaf match required";
  }
  function renderAnalysis(analysis) {
    elements.speciesValue.textContent = "UNKNOWN";
    elements.confidenceValue.textContent = "—";
    elements.heightValue.textContent = `${analysis.estimatedHeight} FT`;
    elements.canopyValue.textContent = `${analysis.estimatedCanopyDiameter} FT`;
    elements.dbhValue.textContent = `~${analysis.estimatedDbh} IN`;
    elements.healthValue.textContent = analysis.estimatedCondition.toUpperCase();
    elements.modelLabel.textContent = `${analysis.model} ${analysis.version} · measurements only`;
  }
  async function beginLeafPhoto() {
    if (!state.analysis || state.scanning) return;
    elements.addLeafPhotoButton.disabled = true;
    elements.addLeafPhotoButton.textContent = "OPENING CAMERA…";
    state.leafPhotoHash = null;
    state.leafIdentification = null;
    elements.confirmSubmitButton.disabled = true;
    setSpeciesResult(null);
    try {
      if (!hasLiveCamera() && !state.demo) await enableCamera({ preservePhoto: true });
      state.awaitingLeafPhoto = true;
      if (elements.confirmDialog.open) elements.confirmDialog.close();
      elements.captureHeadline.textContent = "LEAF CLOSE-UP REQUIRED";
      elements.captureInstruction.textContent = "Fill the frame with one leaf, then tap capture";
      elements.captureButton.querySelector(".capture-label").textContent = "CAPTURE LEAF";
      toast("Hold one leaf close to the camera and tap Capture Leaf.");
    } catch (error) {
      elements.leafPhotoStatus.textContent = "The camera could not open. Try adding the leaf photo again.";
      elements.confirmStatus.dataset.tone = "warning";
      elements.confirmStatus.textContent = "LEAF PHOTO STILL REQUIRED";
      if (!elements.confirmDialog.open) elements.confirmDialog.showModal();
      toast(error.message || "The camera could not open.");
    } finally {
      elements.addLeafPhotoButton.disabled = false;
      if (!state.leafPhotoHash) elements.addLeafPhotoButton.textContent = "ADD LEAF PHOTO";
    }
  }
  async function captureLeafPhoto() {
    if (!state.awaitingLeafPhoto || state.scanning) return;
    state.scanning = true;
    elements.app.classList.add("scanning");
    elements.captureButton.disabled = true;
    elements.captureHeadline.textContent = "CHECKING LEAF PHOTO";
    elements.captureInstruction.textContent = "Attaching the second photo to this finding…";
    try {
      const leafFrame = captureFrame("live");
      const leafBlob = await canvasToJpegBlob(leafFrame.canvas);
      const [leafHash, identification] = await Promise.all([
        hashImageData(leafFrame.imageData),
        withTimeout(
          window.CanopyAI.identifyLeaf({
            imageBlob: leafBlob,
            metadata: {
              latitude: state.location?.latitude,
              longitude: state.location?.longitude,
              capturedAt: new Date().toISOString()
            }
          }),
          15000,
          "Leaf identification timed out."
        ).catch(() => ({
          speciesPrediction: "Unknown",
          speciesConfidence: 0,
          confirmed: false,
          reason: "classifier-unavailable",
          provider: "CanopySpeciesIndex",
          model: "External leaf index"
        }))
      ]);
      state.leafPhotoHash = leafHash;
      state.leafIdentification = identification;
      state.awaitingLeafPhoto = false;
      setSpeciesResult(identification);
      elements.leafPhotoStatus.textContent = identification.confirmed
        ? `${identification.speciesPrediction} matched at ${Math.round(identification.speciesConfidence * 100)}% confidence.`
        : "Leaf analyzed, but the index did not return a confident species match. This tree will remain Unknown.";
      elements.addLeafPhotoButton.textContent = "RETAKE LEAF PHOTO";
      elements.confirmSubmitButton.disabled = false;
      elements.confirmStatus.dataset.tone = identification.confirmed ? "success" : "warning";
      elements.confirmStatus.textContent = identification.confirmed
        ? "LEAF INDEX MATCH READY · CONFIRM THE FINDING"
        : "LEAF ANALYZED · SPECIES REMAINS UNKNOWN";
      elements.captureHeadline.textContent = "LEAF PHOTO ATTACHED";
      elements.captureInstruction.textContent = "Review and confirm the two-photo finding";
      elements.captureButton.querySelector(".capture-label").textContent = "CAPTURE";
      if (!elements.confirmDialog.open) elements.confirmDialog.showModal();
    } catch (error) {
      elements.captureHeadline.textContent = "LEAF PHOTO NOT CAPTURED";
      elements.captureInstruction.textContent = "Hold steady and tap capture to retry";
      toast(error.message || "The leaf photo could not be captured.");
    } finally {
      state.scanning = false;
      elements.app.classList.remove("scanning");
      elements.captureButton.disabled = false;
    }
  }
  async function scanTree() {
    if (state.scanning) return;
    if (state.awaitingLeafPhoto) {
      await captureLeafPhoto();
      return;
    }
    if (!hasLiveCamera() && !state.demo && !state.uploadedImage) {
      elements.permissionDialog.showModal();
      return;
    }
    state.scanning = true;
    elements.app.classList.add("scanning");
    elements.captureHeadline.textContent = "ANALYZING CANOPY";
    elements.captureInstruction.textContent = "Estimating tree dimensions…";
    elements.captureButton.disabled = true;
    try {
      if (hasLiveCamera() && !state.uploadedImage) state.location = null;
      const frame = captureFrame();
      const captureId = uuid();
      state.lastCaptureMode = state.uploadedImage
        ? state.uploadedFileMeta?.fromCamera ? "native" : "gallery"
        : state.demo ? "demo" : "live";
      state.pendingCaptureId = captureId;
      const [analysis, frameHash] = await Promise.all([
        withTimeout(
          window.CanopyAI.analyze({ imageData: frame.imageData, metadata: {
            width: frame.width, height: frame.height, gpsAccuracy: state.location?.accuracy, heading: state.heading
          } }),
          3000,
          "Tree analysis timed out."
        ),
        hashImageData(frame.imageData)
      ]);
      state.analysis = analysis;
      state.lastFrameHash = frameHash;
      state.treeFrameMeta = { width: frame.width, height: frame.height };
      state.leafPhotoHash = null;
      state.leafIdentification = null;
      state.matchedTree = matchNearbyTree(state.location);
      renderAnalysis(analysis);
      elements.captureHeadline.textContent = "TREE IN RANGE";
      elements.captureInstruction.textContent = "Review the estimates before syncing";
      setSpeciesResult(null);
      elements.conditionInput.value = analysis.estimatedCondition;
      elements.heightInput.value = analysis.estimatedHeight;
      elements.canopyInput.value = analysis.estimatedCanopyDiameter;
      elements.dbhInput.value = analysis.estimatedDbh;
      elements.notesInput.value = "";
      elements.leafPhotoStatus.textContent = "Take a close-up of one leaf. Species stays Unknown until the leaf index returns a confident match.";
      elements.addLeafPhotoButton.textContent = "ADD LEAF PHOTO";
      elements.confirmSubmitButton.disabled = true;
      elements.matchNotice.textContent = state.matchedTree
        ? `Possible match: ${state.matchedTree.tree.id} · ${Math.round(state.matchedTree.distance)} m away · ${Math.round(state.matchedTree.confidence * 100)}% match confidence.`
        : state.location
          ? "No existing inventory tree matched within the photo-location capture radius. This will be routed as a possible new tree."
          : "Photo analyzed. No location was present in the camera data, so this finding will stay on this device.";
      elements.confirmStatus.dataset.tone = state.location ? "success" : "warning";
      elements.confirmStatus.textContent = state.location
        ? "LOCATION READY · CONFIRMATION SAVES INSTANTLY ON THIS DEVICE"
        : "NO PHOTO LOCATION · THIS FINDING WILL STAY ON THIS DEVICE";
      if (!elements.confirmDialog.open) elements.confirmDialog.showModal();
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
    const confirmedSpecies = state.leafIdentification?.confirmed
      ? state.leafIdentification.speciesPrediction
      : "Unknown";
    const location = state.location;
    const currentMatch = matchNearbyTree(location);
    return {
      id: state.pendingCaptureId || uuid(), playerId: state.profile.id, treeId: currentMatch?.tree?.id || null,
      latitude: location?.latitude ?? null, longitude: location?.longitude ?? null,
      gpsAccuracy: Number(location?.accuracy || 0),
      heading: Number.isFinite(state.heading) ? state.heading : null,
      capturedAt: location?.capturedAt || new Date(state.uploadedFileMeta?.lastModified || Date.now()).toISOString(),
      imageReference: null, imageHash: state.lastFrameHash,
      imageMetadata: {
        width: state.treeFrameMeta?.width || elements.captureCanvas.width,
        height: state.treeFrameMeta?.height || elements.captureCanvas.height,
        exifRetained: false,
        gpsReadFromExif: Boolean(state.uploadedFileMeta?.gpsReadFromExif),
        locationSource: location?.source || "pending",
        leafPhotoRequired: true,
        leafPhotoHash: state.leafPhotoHash,
        leafIndexSource: state.leafIdentification?.indexSource || null,
        leafIdentificationReason: state.leafIdentification?.reason || "not-analyzed",
        leafScientificName: state.leafIdentification?.scientificName || null,
        leafIdentificationProvider: state.leafIdentification?.provider || null,
        leafIdentificationModel: state.leafIdentification?.model || null,
        leafIdentificationVersion: state.leafIdentification?.version || null,
        measurementModel: analysis.model,
        measurementModelVersion: analysis.version
      },
      aiModel: state.leafIdentification?.model || analysis.model,
      aiModelVersion: state.leafIdentification?.version || analysis.version,
      aiProvider: state.leafIdentification?.provider || analysis.provider,
      speciesPrediction: state.leafIdentification?.speciesPrediction || "Unknown",
      speciesConfidence: Number(state.leafIdentification?.speciesConfidence || 0),
      confirmedSpecies,
      userCorrected: elements.conditionInput.value !== analysis.estimatedCondition,
      estimatedHeight: Number(elements.heightInput.value),
      estimatedCanopyDiameter: Number(elements.canopyInput.value),
      estimatedCanopyArea: Math.round(Math.PI * Math.pow(Number(elements.canopyInput.value) / 2, 2)),
      estimatedDbh: Number(elements.dbhInput.value),
      estimatedCondition: elements.conditionInput.value,
      notes: elements.notesInput.value.trim().slice(0, 500),
      ward: location ? wardFor(location.latitude, location.longitude) : "PENDING",
      nearestAddress: currentMatch?.tree?.street || "Orange, NJ",
      existingTreeMatchConfidence: currentMatch?.confidence || 0,
      verificationStatus: !location
        ? "pending-location"
        : !state.leafIdentification?.confirmed || location.accuracy > 50
          ? "review"
          : "unverified",
      source: "canopyquest",
      metadata: {
        providerOnDevice: Boolean(analysis.onDevice),
        boundarySource: "U.S. Census TIGERweb 2025",
        clientVersion: "3.3.0",
        offlineDraft: !navigator.onLine,
        queuedAt: new Date().toISOString(),
        locationConsent: state.uploadedFileMeta?.locationConsent || "photo-only"
      }
    };
  }
  function readQueueLocal() {
    try {
      const stored = JSON.parse(localStorage.getItem(QUEUE_KEY) || "null");
      if (Array.isArray(stored)) {
        const retained = stored.filter(capture => {
          const queuedAt = new Date(capture.metadata?.queuedAt || capture.capturedAt || 0).getTime();
          const withinRetention = !Number.isFinite(queuedAt) || Date.now() - queuedAt <= QUEUE_RETENTION_MS;
          return withinRetention && !capture.metadata?.syncError;
        });
        if (retained.length !== stored.length) {
          try { localStorage.setItem(QUEUE_KEY, JSON.stringify(retained)); }
          catch (_error) { /* Expiration cleanup can retry on a later visit. */ }
        }
        state.memoryQueue = retained;
        return retained;
      }
    } catch (_error) {
      // Use the in-memory fallback below.
    }
    return state.memoryQueue;
  }
  function persistQueue(storage, items) {
    try {
      const serialized = JSON.stringify(items);
      storage.setItem(QUEUE_KEY, serialized);
      return storage.getItem(QUEUE_KEY) === serialized;
    } catch (_error) {
      return false;
    }
  }
  function mergeLegacyCaptureQueues(currentItems, legacyItems, maximum = MAX_QUEUED_CAPTURES, migratedAt = new Date().toISOString()) {
    const items = Array.isArray(currentItems) ? [...currentItems] : [];
    const knownIds = new Set(items.map(capture => capture?.id).filter(id => id !== undefined && id !== null));
    const migratedIds = new Set();
    const addedIds = [];
    for (const capture of Array.isArray(legacyItems) ? legacyItems : []) {
      const id = capture?.id;
      if (id === undefined || id === null) continue;
      if (knownIds.has(id)) {
        migratedIds.add(id);
        continue;
      }
      if (items.length >= maximum) continue;
      const metadata = capture.metadata && typeof capture.metadata === "object"
        ? { ...capture.metadata }
        : {};
      delete metadata.syncError;
      metadata.queuedAt = migratedAt;
      items.push({ ...capture, metadata });
      knownIds.add(id);
      migratedIds.add(id);
      addedIds.push(id);
    }
    return { items, migratedIds: [...migratedIds], addedIds };
  }
  function openLegacyCaptureDatabase() {
    if (typeof indexedDB === "undefined" || typeof indexedDB.open !== "function") return Promise.resolve(null);
    return new Promise(resolve => {
      let request;
      let settled = false;
      let createdEmptyDatabase = false;
      const finish = database => {
        if (settled) {
          try { database?.close(); } catch (_error) { /* A late open result is safe to close. */ }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(database);
      };
      const timer = setTimeout(() => finish(null), LEGACY_MIGRATION_TIMEOUT_MS);
      try {
        request = indexedDB.open(LEGACY_QUEUE_DB);
        request.onupgradeneeded = event => {
          if (event.oldVersion !== 0) return;
          createdEmptyDatabase = true;
          try { request.transaction?.abort(); } catch (_error) { /* onsuccess also rejects an empty database below. */ }
        };
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
        request.onsuccess = () => {
          const database = request.result;
          if (createdEmptyDatabase || !database.objectStoreNames.contains(LEGACY_QUEUE_STORE)) {
            database.close();
            finish(null);
            return;
          }
          database.onversionchange = () => database.close();
          finish(database);
        };
      } catch (_error) {
        finish(null);
      }
    });
  }
  function readLegacyCaptureBatch(database) {
    return new Promise(resolve => {
      let transaction;
      let settled = false;
      const captures = [];
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { transaction?.abort(); } catch (_error) { /* The connection may already be closed. */ }
        finish(null);
      }, LEGACY_MIGRATION_TIMEOUT_MS);
      try {
        transaction = database.transaction(LEGACY_QUEUE_STORE, "readonly");
        const request = transaction.objectStore(LEGACY_QUEUE_STORE).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || captures.length >= MAX_QUEUED_CAPTURES) return;
          captures.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => {
          try { transaction.abort(); } catch (_error) { /* The transaction will report its result. */ }
          finish(null);
        };
        transaction.oncomplete = () => finish(captures);
        transaction.onerror = () => finish(null);
        transaction.onabort = () => finish(null);
      } catch (_error) {
        finish(null);
      }
    });
  }
  function deleteLegacyCaptures(database, ids) {
    if (!ids.length) return Promise.resolve(true);
    return new Promise(resolve => {
      let transaction;
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { transaction?.abort(); } catch (_error) { /* The connection may already be closed. */ }
        finish(false);
      }, LEGACY_MIGRATION_TIMEOUT_MS);
      try {
        transaction = database.transaction(LEGACY_QUEUE_STORE, "readwrite");
        const store = transaction.objectStore(LEGACY_QUEUE_STORE);
        ids.forEach(id => store.delete(id));
        transaction.oncomplete = () => finish(true);
        transaction.onerror = () => finish(false);
        transaction.onabort = () => finish(false);
      } catch (_error) {
        finish(false);
      }
    });
  }
  async function migrateLegacyCaptureQueue() {
    const database = await openLegacyCaptureDatabase();
    if (!database) return { added: 0, removed: 0 };
    try {
      const legacyItems = await readLegacyCaptureBatch(database);
      if (!legacyItems?.length) return { added: 0, removed: 0 };
      const plan = mergeLegacyCaptureQueues(readQueueLocal(), legacyItems);
      if (!plan.migratedIds.length) return { added: 0, removed: 0 };
      if (!writeQueueLocal(plan.items)) return { added: 0, removed: 0 };
      const verifiedIds = new Set(readQueueLocal().map(capture => capture?.id));
      const safeToDelete = plan.migratedIds.filter(id => verifiedIds.has(id));
      if (!safeToDelete.length) return { added: plan.addedIds.length, removed: 0 };
      const deleted = await deleteLegacyCaptures(database, safeToDelete);
      return { added: plan.addedIds.length, removed: deleted ? safeToDelete.length : 0 };
    } finally {
      database.close();
    }
  }
  function writeQueueLocal(items) {
    if (!persistQueue(localStorage, items)) return false;
    state.memoryQueue = items;
    return true;
  }
  async function queueCapture(capture) {
    if (state.discardedCaptureIds.has(capture.id)) {
      throw new Error("This saved draft was discarded.");
    }
    const items = readQueueLocal();
    const index = items.findIndex(item => item.id === capture.id);
    if (index < 0 && items.length >= MAX_QUEUED_CAPTURES) {
      throw new Error("This device has 100 unsynced findings. Connect and sync or discard a draft before saving another.");
    }
    const nextItems = index >= 0
      ? items.map((item, itemIndex) => itemIndex === index ? capture : item)
      : [...items, capture];
    if (!writeQueueLocal(nextItems)) {
      throw new Error("Device storage is unavailable or full. Free some browser storage, then confirm again.");
    }
    await updateQueueCount();
    return true;
  }
  async function readQueue() {
    return readQueueLocal();
  }
  async function removeQueuedCapture(id) {
    const nextItems = readQueueLocal().filter(item => item.id !== id);
    if (!writeQueueLocal(nextItems)) throw new Error("The saved draft could not be removed from this device.");
    await updateQueueCount();
  }
  async function updateQueueCount() {
    state.queueCount = readQueueLocal().length;
    if (state.queueCount) setSyncState(`${state.queueCount} QUEUED`, true);
  }
  async function sendCapture(capture) {
    return request("/v1/captures", {
      method: "POST", headers: { "Idempotency-Key": capture.id }, body: JSON.stringify(capture), timeoutMs: 6500
    });
  }
  function updateCompletionStatus(captureId, message, tone = "") {
    if (captureId && state.completionCaptureId !== captureId) return;
    elements.completionStatus.textContent = message;
    elements.completionStatus.dataset.tone = tone;
  }
  function updateActiveCompletion(captureId, callback) {
    if (!captureId || state.completionCaptureId !== captureId) return false;
    callback();
    return true;
  }
  async function syncCapture(capture) {
    if (state.discardedCaptureIds.has(capture.id)) return { state: "discarded" };
    if (!Number.isFinite(capture.latitude) || !Number.isFinite(capture.longitude)) return { state: "pending-location" };
    if (!pointInPolygon({ latitude: capture.latitude, longitude: capture.longitude })) {
      await removeQueuedCapture(capture.id);
      return { state: "outside-orange" };
    }
    try {
      const profileReady = await withTimeout(ensureProfileSynced(), 5200, "Player profile sync timed out.");
      if (!profileReady) throw new Error("Player profile is waiting to sync.");
      if (state.discardedCaptureIds.has(capture.id)) return { state: "discarded" };
      const result = await sendCapture(capture);
      await removeQueuedCapture(capture.id);
      if (result.player) saveProfileLocal({ ...result.player, serverSynced: true });
      return { state: "synced", result };
    } catch (error) {
      if (error.status === 409) {
        await removeQueuedCapture(capture.id);
        return { state: "synced-duplicate" };
      }
      if (error.status === 400 || error.status === 422) {
        await removeQueuedCapture(capture.id);
        return { state: "needs-review", error };
      }
      return { state: "queued", error };
    }
  }
  async function finalizeCapture(capture) {
    if (!Number.isFinite(capture.latitude) || !Number.isFinite(capture.longitude)) {
      updateActiveCompletion(capture.id, () => {
        elements.completionLocationButton.hidden = true;
        elements.discardCaptureButton.hidden = false;
      });
      updateCompletionStatus(capture.id, "SAVED ON DEVICE · PHOTO CONTAINED NO LOCATION", "warning");
      return;
    }
    const outcome = await syncCapture(capture);
    if (outcome.state === "synced" || outcome.state === "synced-duplicate") {
      const verification = outcome.result?.capture?.verificationStatus;
      updateCompletionStatus(capture.id, verification === "review"
        ? "SYNCED · SAVED FOR COMMUNITY REVIEW"
        : "SYNCED · ADDED TO THE SHARED MAP", "success");
      updateActiveCompletion(capture.id, () => {
        elements.completionLocationButton.hidden = true;
        elements.discardCaptureButton.hidden = true;
      });
      loadSharedData({ fresh: true }).catch(() => null);
      flushQueue().catch(() => null);
    } else if (outcome.state === "outside-orange") {
      updateActiveCompletion(capture.id, () => {
        elements.discardCaptureButton.hidden = true;
        elements.completionMessage.textContent = "This finding is outside the Orange contribution area and was removed from saved drafts.";
      });
      updateCompletionStatus(capture.id, "NOT SUBMITTED · MOVE INSIDE ORANGE AND TRY AGAIN", "warning");
    } else if (outcome.state === "needs-review") {
      updateActiveCompletion(capture.id, () => {
        elements.discardCaptureButton.hidden = true;
        elements.completionMessage.textContent = "The shared map could not accept this record. The draft was removed so you can rescan cleanly.";
      });
      updateCompletionStatus(capture.id, "NOT SUBMITTED · RESCAN THIS TREE TO TRY AGAIN", "warning");
    } else if (outcome.state === "discarded") {
      // The discard action owns the active receipt while background work stops.
    } else {
      updateActiveCompletion(capture.id, () => {
        elements.discardCaptureButton.hidden = false;
      });
      updateCompletionStatus(capture.id, "SAVED ON DEVICE · WILL SYNC AUTOMATICALLY", "warning");
    }
  }
  async function flushQueue() {
    if (!navigator.onLine || state.syncing) return;
    state.syncing = true;
    try {
      for (const capture of await readQueue()) {
        if (capture.metadata?.syncError || !Number.isFinite(capture.latitude) || !Number.isFinite(capture.longitude)) continue;
        updateActiveCompletion(capture.id, () => {
          elements.discardCaptureButton.disabled = true;
        });
        updateCompletionStatus(capture.id, "SAVED ON DEVICE · RETRYING SHARED MAP SYNC…", "success");
        const outcome = await syncCapture(capture);
        if (outcome.state === "synced" || outcome.state === "synced-duplicate") {
          updateActiveCompletion(capture.id, () => {
            elements.completionLocationButton.hidden = true;
            elements.discardCaptureButton.hidden = true;
            elements.discardCaptureButton.disabled = false;
          });
          updateCompletionStatus(capture.id, "SYNCED · ADDED TO THE SHARED MAP", "success");
        } else if (outcome.state === "outside-orange") {
          updateActiveCompletion(capture.id, () => {
            elements.discardCaptureButton.hidden = true;
            elements.discardCaptureButton.disabled = false;
            elements.completionMessage.textContent = "This finding is outside the Orange contribution area and was removed from saved drafts.";
          });
          updateCompletionStatus(capture.id, "NOT SUBMITTED · MOVE INSIDE ORANGE AND TRY AGAIN", "warning");
        } else if (outcome.state === "needs-review") {
          updateActiveCompletion(capture.id, () => {
            elements.discardCaptureButton.hidden = true;
            elements.discardCaptureButton.disabled = false;
            elements.completionMessage.textContent = "The shared map could not accept this record. Rescan this tree to try again.";
          });
          updateCompletionStatus(capture.id, "NOT SUBMITTED · RESCAN THIS TREE TO TRY AGAIN", "warning");
        } else if (outcome.state === "queued") {
          updateActiveCompletion(capture.id, () => {
            elements.discardCaptureButton.hidden = false;
            elements.discardCaptureButton.disabled = false;
          });
          updateCompletionStatus(capture.id, "SAVED ON DEVICE · WILL SYNC AUTOMATICALLY", "warning");
          break;
        }
      }
      await updateQueueCount();
      if (!state.queueCount) setSyncState("SYNC");
      refreshDashboard().catch(() => null);
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
    elements.shareButton.hidden = false;
  }
  function applyLocalReward(xp = 120) {
    if (!state.profile) return;
    saveProfileLocal({
      ...state.profile,
      xp: Number(state.profile.xp || 0) + xp,
      currentStreak: Math.max(1, Number(state.profile.currentStreak || 0))
    });
  }
  function showCompletion(capture, { xp = 120, preview = false } = {}) {
    state.sessionCaptures += 1;
    state.completionCaptureId = capture.id;
    const species = capture.confirmedSpecies || capture.speciesPrediction || "Tree";
    elements.completionTitle.textContent = preview ? "Preview complete!" : `${species} saved!`;
    elements.completionMessage.textContent = preview
      ? "You completed the capture loop without submitting a record."
      : "Your finding is safely stored on this device. You can move to the next tree now.";
    elements.completionXp.textContent = `+${xp} XP`;
    elements.completionChain.textContent = `FIELD CHAIN ×${state.sessionCaptures}`;
    elements.completionLocationButton.hidden = true;
    elements.completionLocationButton.disabled = false;
    elements.completionLocationButton.textContent = "ADD CURRENT LOCATION + SYNC";
    elements.discardCaptureButton.hidden = true;
    elements.discardCaptureButton.disabled = false;
    elements.nextTreeButton.disabled = false;
    updateCompletionStatus(capture.id, preview ? "PREVIEW ONLY · READY FOR FIELD MODE" : "SAVED ON DEVICE · SYNCING…", preview ? "" : "success");
    reward(xp);
    if (!preview) applyLocalReward(xp);
    if (!elements.completionDialog.open) elements.completionDialog.showModal();
  }
  function resetForNextTree({ openCamera = true } = {}) {
    if (state.resettingCapture) return;
    state.resettingCapture = true;
    const nextMode = state.lastCaptureMode;
    if (elements.completionDialog.open) elements.completionDialog.close();
    state.photoJob += 1;
    if (state.uploadedObjectUrl) URL.revokeObjectURL(state.uploadedObjectUrl);
    state.uploadedImage = null;
    state.uploadedObjectUrl = null;
    state.uploadedFileMeta = null;
    state.analysis = null;
    state.matchedTree = null;
    state.lastFrameHash = null;
    state.leafPhotoHash = null;
    state.leafIdentification = null;
    state.awaitingLeafPhoto = false;
    state.treeFrameMeta = null;
    state.pendingCaptureId = null;
    state.completionCaptureId = null;
    if (state.location?.source === "photo-exif" || state.location?.source === "demo") state.location = null;
    elements.photoPreview.hidden = true;
    elements.photoPreview.removeAttribute("src");
    elements.speciesValue.textContent = "READY TO SCAN";
    elements.confidenceValue.textContent = "—";
    elements.heightValue.textContent = "—";
    elements.canopyValue.textContent = "—";
    elements.dbhValue.textContent = "—";
    elements.healthValue.textContent = "—";
    elements.modelLabel.textContent = "Measurements ready · leaf match required for species";
    elements.captureHeadline.textContent = hasLiveCamera() ? "CAMERA READY" : "NEXT TREE READY";
    elements.captureInstruction.textContent = hasLiveCamera() ? "Aim, hold steady, and tap capture" : "Take the next tree photo to continue your field chain";
    elements.captureButton.querySelector(".capture-label").textContent = hasLiveCamera() ? "CAPTURE" : "START";
    updateLocationHud();
    if (openCamera && !hasLiveCamera()) {
      if (nextMode === "live") {
        elements.captureHeadline.textContent = "REOPENING CAMERA";
        enableCamera().then(() => {
          elements.captureHeadline.textContent = "CAMERA READY";
          elements.captureInstruction.textContent = "Aim at the next tree and tap capture";
          elements.captureButton.querySelector(".capture-label").textContent = "CAPTURE";
        }).catch(error => {
          toast(`${error.message || "Camera unavailable"} Choose an existing photo instead.`, 5200);
          if (!elements.permissionDialog.open) elements.permissionDialog.showModal();
        });
      } else {
        enableCamera().then(() => {
          elements.captureHeadline.textContent = "CAMERA READY";
          elements.captureInstruction.textContent = "Aim at the next tree and tap capture";
          elements.captureButton.querySelector(".capture-label").textContent = "CAPTURE";
        }).catch(() => {
          if (!elements.permissionDialog.open) elements.permissionDialog.showModal();
        });
      }
    }
    setTimeout(() => { state.resettingCapture = false; }, 0);
  }
  async function discardCompletionCapture() {
    const captureId = state.completionCaptureId;
    if (!captureId || !readQueueLocal().some(capture => capture.id === captureId)) {
      updateActiveCompletion(captureId, () => {
        elements.completionLocationButton.hidden = true;
        elements.discardCaptureButton.hidden = true;
      });
      updateCompletionStatus(captureId, "THIS FINDING IS ALREADY OFF THIS DEVICE QUEUE", "success");
      return;
    }
    if (captureId) state.discardedCaptureIds.add(captureId);
    updateActiveCompletion(captureId, () => {
      elements.completionLocationButton.disabled = true;
      elements.discardCaptureButton.disabled = true;
      elements.nextTreeButton.disabled = true;
    });
    if (captureId) {
      try { await removeQueuedCapture(captureId); }
      catch (error) {
        state.discardedCaptureIds.delete(captureId);
        updateActiveCompletion(captureId, () => {
          elements.completionLocationButton.disabled = false;
          elements.discardCaptureButton.disabled = false;
          elements.nextTreeButton.disabled = false;
        });
        updateCompletionStatus(captureId, error.message, "warning");
        return;
      }
    }
    if (state.completionCaptureId === captureId) {
      toast("Saved draft discarded from this device.");
      resetForNextTree({ openCamera: false });
    }
  }
  async function shareFieldCard() {
    const species = state.leafIdentification?.confirmed
      ? state.leafIdentification.speciesPrediction
      : "an unknown street tree";
    const shareData = {
      title: "CanopyQuest",
      text: `I mapped ${species} with CanopyQuest. Help grow Orange’s shared canopy inventory.`,
      url: "https://jameshward3.github.io/CanopyQuest/"
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
        toast("Field card link copied.");
      } else {
        toast("Share CanopyQuest at jameshward3.github.io/CanopyQuest/");
      }
    } catch (error) {
      if (error?.name !== "AbortError") toast("Sharing is not available in this browser.");
    }
  }
  async function confirmCapture(event) {
    event.preventDefault();
    if (state.confirming) return;
    const submitButton = elements.confirmForm.querySelector('button[type="submit"]');
    if (!state.analysis) {
      elements.confirmStatus.dataset.tone = "warning";
      elements.confirmStatus.textContent = "NO ANALYSIS IS READY · RETRY THE SCAN";
      return;
    }
    if (!state.leafPhotoHash) {
      elements.confirmStatus.dataset.tone = "warning";
      elements.confirmStatus.textContent = "SECOND PHOTO REQUIRED · ADD A CLOSE-UP OF A LEAF";
      elements.confirmSubmitButton.disabled = true;
      return;
    }
    if (state.demo) {
      elements.confirmDialog.close();
      showCompletion({
        id: state.pendingCaptureId || uuid(),
        confirmedSpecies: elements.speciesInput.value,
        speciesPrediction: state.analysis.speciesPrediction
      }, { preview: true });
      return;
    }
    if (!state.profile?.id) {
      elements.confirmDialog.close();
      openProfileDialog(true);
      return;
    }
    state.confirming = true;
    submitButton.disabled = true;
    submitButton.textContent = "SAVING…";
    elements.confirmStatus.dataset.tone = "success";
    elements.confirmStatus.textContent = "SAVING SAFELY ON THIS DEVICE…";
    try {
      const capture = buildCapture();
      if (
        Number.isFinite(capture.latitude)
        && Number.isFinite(capture.longitude)
        && !pointInPolygon({ latitude: capture.latitude, longitude: capture.longitude })
      ) {
        elements.confirmStatus.dataset.tone = "warning";
        elements.confirmStatus.textContent = "THIS LOCATION IS OUTSIDE ORANGE · MOVE INSIDE THE MAP AREA OR CHOOSE ANOTHER PHOTO";
        return;
      }
      await queueCapture(capture);
      elements.confirmDialog.close();
      showCompletion(capture);
      navigator.storage?.persist?.().catch(() => false);
      finalizeCapture(capture).catch(error => {
        console.warn("Background sync deferred", error);
        updateCompletionStatus(capture.id, "SAVED ON DEVICE · WILL SYNC AUTOMATICALLY", "warning");
      });
    } catch (error) {
      console.error("Capture save failed", error);
      elements.confirmStatus.dataset.tone = "warning";
      elements.confirmStatus.textContent = error.message || "COULD NOT SAVE YET · YOUR REVIEW IS STILL OPEN · TRY AGAIN";
    } finally {
      state.confirming = false;
      submitButton.disabled = false;
      submitButton.textContent = "CONFIRM FINDING";
    }
  }
  function openProfileDialog(afterCapture = false, firstRun = false) {
    elements.displayNameInput.value = state.profile?.displayName || "";
    elements.communityNotice.checked = Boolean(state.profile);
    elements.profileDialog.dataset.afterCapture = afterCapture ? "true" : "false";
    elements.profileDialog.dataset.firstRun = firstRun ? "true" : "false";
    elements.profileDialog.showModal();
  }
  function saveProfile(event) {
    event.preventDefault();
    const displayName = sanitizeName(elements.displayNameInput.value);
    if (displayName.length < 2) {
      elements.displayNameInput.setCustomValidity("Use at least two characters for your trail name.");
      elements.displayNameInput.reportValidity();
      return;
    }
    elements.displayNameInput.setCustomValidity("");
    const existing = state.profile || {};
    const profile = {
      id: existing.id || uuid(),
      displayName,
      settings: existing.settings || { reducedData: false },
      source: "canopyquest",
      serverSynced: existing.id ? existing.serverSynced !== false : false
    };
    const submitButton = elements.profileForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = "SAVED";
    saveProfileLocal({ ...existing, ...profile, xp: existing.xp || 0, currentStreak: existing.currentStreak || 0 });
    const resume = elements.profileDialog.dataset.afterCapture === "true";
    const firstRun = elements.profileDialog.dataset.firstRun === "true";
    elements.profileDialog.close();
    if (resume && state.analysis) elements.confirmDialog.showModal();
    else if (firstRun && !state.stream && !state.demo) {
      setTimeout(() => elements.permissionDialog.showModal(), 120);
    }
    ensureProfileSynced().then(synced => {
      toast(synced ? "Profile synced." : "Profile saved on this device.");
      if (synced) flushQueue().catch(() => null);
    });
    setTimeout(() => {
      submitButton.disabled = false;
      submitButton.textContent = "SAVE PROFILE";
    }, 250);
  }
  function renderMapControls() {
    elements.mapPerspectiveButton.setAttribute?.("aria-pressed", state.mapView.perspective ? "true" : "false");
    elements.mapPerspectiveButton.textContent = state.mapView.perspective ? "↗ HEADING" : "↑ NORTH";
    elements.mapPerspectiveButton.setAttribute?.(
      "aria-label",
      state.mapView.perspective ? "Heading-up map active; switch to north-up" : "North-up map active; switch to heading-up"
    );
    elements.mapRecenterButton.hidden = state.mapView.follow && state.mapView.panX === 0 && state.mapView.panY === 0;
  }
  function recenterMap() {
    state.mapView.follow = true;
    state.mapView.panX = 0;
    state.mapView.panY = 0;
    state.mapView.zoom = state.mapView.perspective ? 1.08 : 1;
    state.mapView.frozenHeading = null;
    state.mapView.frozenLocation = null;
    renderMapControls();
    scheduleMapDraw();
  }
  function detachMapFollow() {
    if (!state.mapView.follow) return;
    state.mapView.follow = false;
    state.mapView.frozenHeading = state.heading;
    state.mapView.frozenLocation = state.location ? { ...state.location } : null;
  }
  function clampMapPan() {
    const rect = elements.mapCanvas.getBoundingClientRect();
    const limitX = Math.max(120, rect.width * .85);
    const limitY = Math.max(100, rect.height * .85);
    state.mapView.panX = Math.max(-limitX, Math.min(limitX, state.mapView.panX));
    state.mapView.panY = Math.max(-limitY, Math.min(limitY, state.mapView.panY));
  }
  function toggleMapPerspective() {
    state.mapView.perspective = !state.mapView.perspective;
    recenterMap();
    if (state.mapView.perspective) {
      requestOrientation({ prompt: true }).catch(() => null);
    }
  }
  function mapPointerDown(event) {
    elements.mapCanvas.setPointerCapture?.(event.pointerId);
    state.mapGesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.mapGesture.pointers.size === 2) {
      const [first, second] = [...state.mapGesture.pointers.values()];
      state.mapGesture.lastDistance = Math.hypot(first.x - second.x, first.y - second.y);
    }
  }
  function mapPointerMove(event) {
    const previous = state.mapGesture.pointers.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    state.mapGesture.pointers.set(event.pointerId, next);
    if (state.mapGesture.pointers.size === 1) {
      state.mapView.panX += next.x - previous.x;
      state.mapView.panY += next.y - previous.y;
    } else if (state.mapGesture.pointers.size === 2) {
      const [first, second] = [...state.mapGesture.pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (state.mapGesture.lastDistance > 0) {
        state.mapView.zoom = Math.max(.8, Math.min(3.2, state.mapView.zoom * distance / state.mapGesture.lastDistance));
      }
      state.mapGesture.lastDistance = distance;
    }
    detachMapFollow();
    clampMapPan();
    renderMapControls();
    scheduleMapDraw();
  }
  function mapPointerUp(event) {
    state.mapGesture.pointers.delete(event.pointerId);
    if (state.mapGesture.pointers.size < 2) state.mapGesture.lastDistance = 0;
  }
  function clearMapGesture() {
    state.mapGesture.pointers.clear();
    state.mapGesture.lastDistance = 0;
  }
  function mapWheel(event) {
    event.preventDefault();
    const factor = event.deltaY > 0 ? .9 : 1.1;
    state.mapView.zoom = Math.max(.8, Math.min(3.2, state.mapView.zoom * factor));
    detachMapFollow();
    renderMapControls();
    scheduleMapDraw();
  }
  function mapKeydown(event) {
    const step = event.shiftKey ? 32 : 16;
    if (event.key === "ArrowLeft") state.mapView.panX += step;
    else if (event.key === "ArrowRight") state.mapView.panX -= step;
    else if (event.key === "ArrowUp") state.mapView.panY += step;
    else if (event.key === "ArrowDown") state.mapView.panY -= step;
    else if (event.key === "+" || event.key === "=") state.mapView.zoom = Math.min(3.2, state.mapView.zoom * 1.12);
    else if (event.key === "-" || event.key === "_") state.mapView.zoom = Math.max(.8, state.mapView.zoom / 1.12);
    else if (event.key.toLowerCase() === "r") {
      recenterMap();
      return;
    } else {
      return;
    }
    event.preventDefault();
    detachMapFollow();
    clampMapPan();
    renderMapControls();
    scheduleMapDraw();
  }
  function registerEvents() {
    elements.enableFieldMode.addEventListener("click", enableFieldMode);
    elements.takePhotoButton.addEventListener("click", enableFieldMode);
    elements.choosePhotoButton.addEventListener("click", () => elements.photoInput.click());
    elements.photoInput.addEventListener("change", choosePhoto);
    elements.demoModeButton.addEventListener("click", startDemo);
    elements.captureButton.addEventListener("click", scanTree);
    elements.profileButton.addEventListener("click", () => openProfileDialog(false));
    elements.aboutButton.addEventListener("click", () => elements.aboutDialog.showModal());
    elements.questsButton.addEventListener("click", () => elements.questsDialog.showModal());
    elements.leadersButton.addEventListener("click", () => { elements.leadersDialog.showModal(); renderLeaders("weekly"); });
    elements.syncButton.addEventListener("click", async () => {
      await Promise.all([loadSharedData({ fresh: true }), flushQueue()]);
      toast(state.queueCount ? `${state.queueCount} capture${state.queueCount === 1 ? "" : "s"} waiting for connection.` : "Shared inventory is up to date.");
    });
    elements.shareButton.addEventListener("click", shareFieldCard);
    elements.completionShareButton.addEventListener("click", shareFieldCard);
    elements.nextTreeButton.addEventListener("click", () => resetForNextTree({ openCamera: true }));
    elements.discardCaptureButton.addEventListener("click", discardCompletionCapture);
    elements.completionDialog.addEventListener("close", () => {
      if (!state.resettingCapture && state.analysis) resetForNextTree({ openCamera: false });
    });
    elements.mapPerspectiveButton.addEventListener("click", toggleMapPerspective);
    elements.mapRecenterButton.addEventListener("click", recenterMap);
    elements.mapCanvas.addEventListener("pointerdown", mapPointerDown);
    elements.mapCanvas.addEventListener("pointermove", mapPointerMove);
    elements.mapCanvas.addEventListener("pointerup", mapPointerUp);
    elements.mapCanvas.addEventListener("pointercancel", mapPointerUp);
    elements.mapCanvas.addEventListener("lostpointercapture", mapPointerUp);
    elements.mapCanvas.addEventListener("wheel", mapWheel, { passive: false });
    elements.mapCanvas.addEventListener("keydown", mapKeydown);
    elements.displayNameInput.addEventListener("input", () => elements.displayNameInput.setCustomValidity(""));
    elements.profileForm.addEventListener("submit", saveProfile);
    elements.confirmForm.addEventListener("submit", confirmCapture);
    elements.addLeafPhotoButton.addEventListener("click", beginLeafPhoto);
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
    window.addEventListener("resize", scheduleMapDraw);
    window.addEventListener("blur", clearMapGesture);
    window.addEventListener("pagehide", stopCamera);
    window.addEventListener("online", () => { setSyncState("SYNCING"); flushQueue(); });
    window.addEventListener("offline", () => setSyncState("OFFLINE", true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        clearMapGesture();
        stopCamera();
      } else if (!elements.choosePhotoButton.disabled && !state.scanning && !state.confirming) {
        if (!state.uploadedImage && !state.demo && !hasLiveCamera()) {
          enableCamera().then(() => {
            elements.captureHeadline.textContent = "CAMERA READY";
            elements.captureInstruction.textContent = "Aim at a tree and tap capture";
            elements.captureButton.querySelector(".capture-label").textContent = "CAPTURE";
          }).catch(() => null);
        }
        flushQueue();
      }
    });
  }
  async function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      try {
        const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
        registration.update().catch(() => null);
      }
      catch (error) { console.warn("Service worker unavailable", error); }
    }
  }
  function clearLegacyMapStorage() {
    try {
      localStorage.removeItem("canopyQuestStreetsV1");
      localStorage.removeItem("canopyQuestTreesV1");
    } catch (_error) {
      // Cache Storage now owns public map data.
    }
  }
  async function init() {
    clearLegacyMapStorage();
    loadProfileLocal();
    renderProfile();
    renderQuests(DEFAULT_QUESTS);
    registerEvents();
    renderMapControls();
    updateLocationHud();
    drawMap();
    setTimeout(() => {
      if (!state.profile) openProfileDialog(false, true);
      else if (!state.stream && !state.demo && !elements.permissionDialog.open) elements.permissionDialog.showModal();
    }, 180);
    updateQueueCount();
    const queueReady = migrateLegacyCaptureQueue()
      .catch(error => console.warn("Legacy capture migration deferred", error))
      .then(updateQueueCount);
    Promise.allSettled([loadBoundary(), loadStreets(), loadSharedData(), registerServiceWorker(), queueReady.then(flushQueue)]);
  }

  window.CanopyQuest = Object.freeze({
    distanceMeters, pointInPolygon, sanitizeName, levelProgress, matchNearbyTree, parseExifGps,
    parseImageDimensions, normalizeStreetFeatures, baseMapPoint, compassHeading, waitForVideoFrame,
    withTimeout, persistQueue, mergeLegacyCaptureQueues
  });
  init();
})();
