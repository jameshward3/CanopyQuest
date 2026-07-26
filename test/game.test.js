import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadUtilities(
  storage = { getItem: () => null, setItem() {}, removeItem() {} },
  { realTimers = false, indexedDb = {} } = {}
) {
  let initialized = false;
  const noopElement = () => ({
    textContent: "",
    style: {},
    hidden: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector() { return noopElement(); },
    getBoundingClientRect() { return { width: 390, height: 300 }; },
    getContext() {
      return {
        scale() {}, fillRect() {}, createLinearGradient() { return { addColorStop() {} }; },
        beginPath() {}, moveTo() {}, bezierCurveTo() {}, stroke() {}, save() {}, restore() {},
        lineTo() {}, closePath() {}, fill() {}, arc() {}
      };
    }
  });
  const context = {
    console: { ...console, warn() {} },
    crypto: { randomUUID: () => "test-player" },
    fetch: async () => { throw new Error("offline test"); },
    setTimeout: (...args) => initialized && realTimers ? globalThis.setTimeout(...args) : 0,
    clearTimeout: timer => { if (initialized && realTimers) globalThis.clearTimeout(timer); },
    indexedDB: indexedDb,
    navigator: { onLine: false },
    localStorage: storage,
    window: {
      ORANGE_TREE_DATABASE_URL: "https://example.test",
      addEventListener() {},
      devicePixelRatio: 1
    },
    document: {
      getElementById: () => noopElement(),
      querySelectorAll: () => [],
      addEventListener() {},
      visibilityState: "visible"
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../app.js", import.meta.url), "utf8"), context);
  initialized = true;
  return context.window.CanopyQuest;
}

const utilities = loadUtilities();

function jpegWithGps() {
  const tiffLength = 128;
  const payloadLength = 6 + tiffLength;
  const bytes = new Uint8Array(2 + 4 + payloadLength + 2);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe1], 0);
  view.setUint16(4, payloadLength + 2, false);
  bytes.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  const tiff = 12;
  bytes.set([0x49, 0x49], tiff);
  view.setUint16(tiff + 2, 42, true);
  view.setUint32(tiff + 4, 8, true);
  view.setUint16(tiff + 8, 1, true);
  view.setUint16(tiff + 10, 0x8825, true);
  view.setUint16(tiff + 12, 4, true);
  view.setUint32(tiff + 14, 1, true);
  view.setUint32(tiff + 18, 26, true);
  view.setUint32(tiff + 22, 0, true);

  const gps = tiff + 26;
  view.setUint16(gps, 4, true);
  const writeEntry = (index, tag, type, count, value) => {
    const entry = gps + 2 + index * 12;
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, count, true);
    if (typeof value === "string") {
      bytes[entry + 8] = value.charCodeAt(0);
      bytes[entry + 9] = 0;
    } else {
      view.setUint32(entry + 8, value, true);
    }
  };
  writeEntry(0, 1, 2, 2, "N");
  writeEntry(1, 2, 5, 3, 80);
  writeEntry(2, 3, 2, 2, "W");
  writeEntry(3, 4, 5, 3, 104);
  view.setUint32(gps + 50, 0, true);

  const writeRationals = (offset, values) => {
    values.forEach(([numerator, denominator], index) => {
      view.setUint32(tiff + offset + index * 8, numerator, true);
      view.setUint32(tiff + offset + index * 8 + 4, denominator, true);
    });
  };
  writeRationals(80, [[40, 1], [46, 1], [3, 1]]);
  writeRationals(104, [[74, 1], [14, 1], [21, 1]]);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes.buffer;
}

function imageHeader(bytes) {
  return Uint8Array.from(bytes).buffer;
}

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes.buffer;
}

function jpegHeader(width, height) {
  const bytes = new Uint8Array(28);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  view.setUint16(4, 4, false);
  bytes.set([0xff, 0xc0], 8);
  view.setUint16(10, 17, false);
  bytes[12] = 8;
  view.setUint16(13, height, false);
  view.setUint16(15, width, false);
  return bytes.buffer;
}

function webpExtendedHeader(width, height) {
  const bytes = new Uint8Array(30);
  bytes.set([...Buffer.from("RIFF"), 22, 0, 0, 0, ...Buffer.from("WEBPVP8X")]);
  const storedWidth = width - 1;
  const storedHeight = height - 1;
  bytes.set([
    storedWidth & 0xff, (storedWidth >> 8) & 0xff, (storedWidth >> 16) & 0xff,
    storedHeight & 0xff, (storedHeight >> 8) & 0xff, (storedHeight >> 16) & 0xff
  ], 24);
  return bytes.buffer;
}

test("sanitizes public display names", () => {
  assert.equal(utilities.sanitizeName("  <Jay>   Explorer  "), "Jay Explorer");
  assert.equal(utilities.sanitizeName("a".repeat(50)).length, 32);
});

test("accepts the Orange center and rejects outside coordinates", () => {
  assert.equal(utilities.pointInPolygon({ latitude: 40.7673, longitude: -74.2391 }), true);
  assert.equal(utilities.pointInPolygon({ latitude: 40.735, longitude: -74.300 }), false);
});

test("uses increasing XP thresholds", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(utilities.levelProgress(0))), {
    level: 1, floor: 0, ceiling: 250, percent: 0
  });
  assert.equal(utilities.levelProgress(1000).level, 3);
});

test("calculates nearby distances in meters", () => {
  const distance = utilities.distanceMeters(
    { latitude: 40.7673, longitude: -74.2391 },
    { latitude: 40.7674, longitude: -74.2391 }
  );
  assert.ok(distance > 10 && distance < 12);
});

test("reads latitude and longitude from JPEG EXIF metadata", () => {
  const gps = utilities.parseExifGps(jpegWithGps());
  assert.ok(gps);
  assert.ok(Math.abs(gps.latitude - 40.7675) < 0.000001);
  assert.ok(Math.abs(gps.longitude - (-74.2391666667)) < 0.000001);
});

test("ignores images without EXIF GPS metadata", () => {
  assert.equal(utilities.parseExifGps(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer), null);
});

test("reads dimensions from PNG, JPEG, and extended WebP headers", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(utilities.parseImageDimensions(pngHeader(4032, 3024)))),
    { width: 4032, height: 3024 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(utilities.parseImageDimensions(jpegHeader(1920, 1080)))),
    { width: 1920, height: 1080 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(utilities.parseImageDimensions(webpExtendedHeader(1600, 1200)))),
    { width: 1600, height: 1200 }
  );
});

test("rejects truncated and malformed image headers without throwing", () => {
  const malformedJpeg = imageHeader([
    0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xe1,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0
  ]);
  assert.equal(utilities.parseImageDimensions(new ArrayBuffer(0)), null);
  assert.equal(utilities.parseImageDimensions(imageHeader([0x89, 0x50, 0x4e, 0x47])), null);
  assert.doesNotThrow(() => utilities.parseImageDimensions(malformedJpeg));
  assert.equal(utilities.parseImageDimensions(malformedJpeg), null);
  assert.equal(utilities.parseImageDimensions(imageHeader(new Array(24).fill(0))), null);
});

test("waits for a readable camera frame instead of accepting an empty preview", async () => {
  const timedUtilities = loadUtilities(undefined, { realTimers: true });
  const listeners = new Map();
  const removed = [];
  const video = {
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name);
      removed.push(name);
    }
  };
  const frameReady = timedUtilities.waitForVideoFrame(video, 100);
  video.readyState = 2;
  video.videoWidth = 1280;
  video.videoHeight = 960;
  listeners.get("loadeddata")();
  await frameReady;
  assert.deepEqual(removed.sort(), ["canplay", "error", "loadeddata"]);
});

test("camera frame wait rejects on media errors and has a bounded timeout", async () => {
  const timedUtilities = loadUtilities(undefined, { realTimers: true });
  const createVideo = () => {
    const listeners = new Map();
    return {
      video: {
        readyState: 0,
        videoWidth: 0,
        videoHeight: 0,
        addEventListener: (name, listener) => listeners.set(name, listener),
        removeEventListener: (name, listener) => {
          if (listeners.get(name) === listener) listeners.delete(name);
        }
      },
      listeners
    };
  };
  const failed = createVideo();
  const mediaError = timedUtilities.waitForVideoFrame(failed.video, 100);
  failed.listeners.get("error")();
  await assert.rejects(mediaError, /Camera preview could not be read/);

  const stalled = createVideo();
  await assert.rejects(
    timedUtilities.waitForVideoFrame(stalled.video, 5),
    /Camera preview timed out/
  );
});

test("verifies durable queue writes before reporting success", () => {
  const records = new Map();
  const workingStorage = {
    setItem: (key, value) => records.set(key, value),
    getItem: key => records.get(key) ?? null
  };
  assert.equal(utilities.persistQueue(workingStorage, [{ id: "capture-1" }]), true);
  assert.equal(utilities.persistQueue({ setItem() {}, getItem: () => null }, [{ id: "capture-2" }]), false);
  assert.equal(utilities.persistQueue({
    setItem() {},
    getItem: () => JSON.stringify([{ id: "different-capture" }])
  }, [{ id: "capture-3" }]), false);
  assert.equal(utilities.persistQueue({ setItem() { throw new Error("quota"); }, getItem: () => null }, []), false);
});

test("merges a bounded legacy queue without overwriting current captures", () => {
  const migratedAt = "2026-07-26T12:00:00.000Z";
  const current = [{ id: "same", confirmedSpecies: "Red Maple" }];
  const legacy = [
    { id: "same", confirmedSpecies: "Pin Oak" },
    { id: "legacy-1", metadata: { queuedAt: "2025-01-01T00:00:00.000Z", syncError: "retry" } },
    { id: "legacy-2" }
  ];
  const result = utilities.mergeLegacyCaptureQueues(current, legacy, 2, migratedAt);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [
    { id: "same", confirmedSpecies: "Red Maple" },
    { id: "legacy-1", metadata: { queuedAt: migratedAt } }
  ]);
  assert.deepEqual(Array.from(result.migratedIds), ["same", "legacy-1"]);
  assert.deepEqual(Array.from(result.addedIds), ["legacy-1"]);
});

test("does not create an empty legacy database on a first visit", async () => {
  let aborted = false;
  const request = {
    transaction: { abort: () => { aborted = true; } }
  };
  const indexedDb = {
    open() {
      queueMicrotask(() => {
        request.onupgradeneeded({ oldVersion: 0 });
        request.onerror();
      });
      return request;
    }
  };
  loadUtilities(undefined, { indexedDb });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true);
});

test("boots when browser storage is disabled", () => {
  const disabledStorage = {
    getItem() { throw new Error("disabled"); },
    setItem() { throw new Error("disabled"); },
    removeItem() { throw new Error("disabled"); }
  };
  assert.doesNotThrow(() => loadUtilities(disabledStorage));
});

test("normalizes Census street lines for the canvas map", () => {
  const streets = utilities.normalizeStreetFeatures({
    features: [{
      properties: { NAME: "Main St" },
      geometry: { type: "LineString", coordinates: [[-74.24, 40.77], [-74.23, 40.77]] }
    }, {
      properties: { BASENAME: "Park" },
      geometry: { type: "MultiLineString", coordinates: [
        [[-74.25, 40.78], [-74.24, 40.78]],
        [[-74.24, 40.78], [-74.23, 40.78]]
      ] }
    }]
  });
  assert.equal(streets.length, 3);
  assert.equal(streets[0].name, "Main St");
  assert.equal(streets[2].coordinates.length, 2);
});

test("projects the map with one uniform geographic scale", () => {
  const centerLongitude = (-74.2605 + -74.2125) / 2;
  const centerLatitude = (40.748 + 40.792) / 2;
  const center = utilities.baseMapPoint(centerLongitude, centerLatitude, 400, 300);
  const east100m = utilities.baseMapPoint(
    centerLongitude + 100 / (111320 * Math.cos(centerLatitude * Math.PI / 180)),
    centerLatitude,
    400,
    300
  );
  const north100m = utilities.baseMapPoint(
    centerLongitude,
    centerLatitude + 100 / 111132,
    400,
    300
  );
  assert.ok(Math.abs(center[0] - 200) < 0.001);
  assert.ok(Math.abs(center[1] - 150) < 0.001);
  assert.ok(Math.abs((east100m[0] - center[0]) - (center[1] - north100m[1])) < 0.001);
});

test("derives stable compass headings for flat and upright devices", () => {
  assert.ok(Math.abs(utilities.compassHeading(350, 0, 0) - 10) < 0.001);
  assert.ok(Math.abs(utilities.compassHeading(90, 90, 0) - 270) < 0.001);
});

test("service worker caches a fast shell and public map data", () => {
  const serviceWorker = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(serviceWorker, /canopyquest-shell-v11/);
  assert.match(serviceWorker, /canopyquest-data-v3/);
  assert.match(serviceWorker, /staleWhileRevalidate/);
  assert.match(serviceWorker, /tigerweb\.geo\.census\.gov/);
  assert.match(serviceWorker, /\/v1\/trees/);
  const shell = serviceWorker.match(/const APP_SHELL = \[[\s\S]*?\];/)?.[0] || "";
  assert.match(shell, /scanner-bg\.jpg/);
  assert.doesNotMatch(shell, /og\.png|icon-512/);
});

test("capture interface keeps capture in-app and supports photo metadata", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /capture="environment"/);
  assert.match(html, /OPEN IN-APP CAMERA/);
  assert.doesNotMatch(script, /navigator\.geolocation|getCurrentPosition/);
  assert.match(html, /id="addLeafPhotoButton"/);
  assert.match(html, /id="confirmSubmitButton"[^>]*disabled/);
  assert.match(script, /leafPhotoRequired:\s*true/);
  assert.match(script, /if \(!state\.leafPhotoHash\)/);
  assert.match(html, /id="confirmStatus"/);
  assert.match(html, /id="completionDialog"/);
  assert.match(html, /id="completionLocationButton"/);
  assert.match(html, /id="discardCaptureButton"/);
  assert.match(html, /MAP THE NEXT TREE/);
  assert.match(html, /id="heightInput"[^>]*required/);
});
