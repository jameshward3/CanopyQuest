import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadUtilities() {
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
    setTimeout: () => 0,
    clearTimeout() {},
    indexedDB: {},
    navigator: { onLine: false },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
