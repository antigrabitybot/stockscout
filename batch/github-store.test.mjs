import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "./github-store.mjs";

test("safe GitHub requests retry a transient EPIPE", async () => {
  let calls = 0;
  const response = { status: 200 };
  const result = await fetchWithRetry("https://example.invalid", {}, {
    attempts: 3,
    delayMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        const error = new Error("write EPIPE");
        error.code = "EPIPE";
        throw error;
      }
      return response;
    },
  });
  assert.equal(result, response);
  assert.equal(calls, 2);
});

test("non-retryable 4xx responses are returned immediately", async () => {
  let calls = 0;
  const response = { status: 404 };
  const result = await fetchWithRetry("https://example.invalid", {}, {
    attempts: 3,
    delayMs: 0,
    fetchImpl: async () => { calls++; return response; },
  });
  assert.equal(result, response);
  assert.equal(calls, 1);
});
