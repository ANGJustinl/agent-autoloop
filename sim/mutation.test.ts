// Failure modes: the safety tests pass after an authorization, deduplication, queue, receipt, deadline, replay or transaction
// guard is removed; mutation reporting counts syntax errors as detections or silently omits surviving mutations; a change
// elsewhere leaves a mutation breaking nothing that matters, and a share below 100 percent lets that go unseen.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mutate } from "./mutate.ts";
test("every executable kernel mutation is detected", () => {
  const result = mutate();
  console.log(JSON.stringify(result));
  assert.equal(result.invalid.length, 0);
  assert.deepEqual(result.survived, []);
});
