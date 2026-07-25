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
