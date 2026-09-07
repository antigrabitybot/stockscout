import test from "node:test";
import assert from "node:assert/strict";
import { advanceForwardTestDay, summarizeForwardTests, updateForwardTests } from "./forward-test.mjs";

const strategy = {
  id: "always", name: "Always", cat: "value", horizon: "swing", markets: ["JP"],
  score: () => 1,
};

function stock(days = 262) {
  const history = [];
  const start = new Date("2025-01-01T00:00:00Z");
  for (let i = 0; i < days; i++) {
    const date = new Date(start.getTime() + i * 86400_000).toISOString().slice(0, 10);
    history.push({ date, o: 100, h: 101, l: 99, c: 100, v: 1000 });
  }
  return { code: "TEST", name: "Test", market: "JP", price: 100, atr: 1, history };
}

test("signal is entered next day and a closed trade updates metrics", () => {
  const s = stock();
  const state = { version: 1, startedAt: null, markets: {} };
  const signalDate = s.history[260].date;
  const entryDate = s.history[261].date;

  advanceForwardTestDay(state, "JP", signalDate, [s], [strategy]);
  assert.equal(state.markets.JP.strategies.always.pending.length, 1);
  assert.equal(state.markets.JP.strategies.always.open.length, 0);

  s.history[261] = { ...s.history[261], h: 110, l: 99 };
  advanceForwardTestDay(state, "JP", entryDate, [s], [strategy]);
  const result = summarizeForwardTests(state).markets.JP.strategies.always;
  assert.equal(result.closedCount, 1);
  assert.equal(result.winRate, 1);
  assert.ok(result.avgR > 0);
});

test("running the updater twice for the same latest date is idempotent", () => {
  const s = stock(261);
  const store = {};
  updateForwardTests(store, [s]);
  const once = JSON.stringify(store.forwardTest);
  updateForwardTests(store, [s]);
  assert.equal(JSON.stringify(store.forwardTest), once);
});

