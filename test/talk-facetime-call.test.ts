import assert from "node:assert/strict";
import test from "node:test";
import { faceTimeCallMedia, parseFaceTimeCallArguments } from "../extensions/talk/facetime-call.ts";

test("FaceTime media defaults only on omission, never on an invalid value", () => {
  assert.equal(faceTimeCallMedia(undefined), "audio");
  for (const media of ["audio", "video"] as const) assert.equal(faceTimeCallMedia(media), media);
  for (const media of [null, "", "VIDEO", "automatic", "screen", true, 0, {}, []]) {
    assert.throws(() => faceTimeCallMedia(media), /media must be audio or video/);
  }
});

test("FaceTime CLI preserves default audio and reason, and accepts explicit media before reason", () => {
  assert.deepEqual(parseFaceTimeCallArguments(""), { media: "audio" });
  assert.deepEqual(parseFaceTimeCallArguments(" --audio "), { media: "audio" });
  assert.deepEqual(parseFaceTimeCallArguments("--video"), { media: "video" });
  assert.deepEqual(parseFaceTimeCallArguments("--reason Known result."), { media: "audio", purpose: "Known result." });
  assert.deepEqual(parseFaceTimeCallArguments("--VIDEO --reason Known  result."), { media: "video", purpose: "Known result." });
  assert.deepEqual(parseFaceTimeCallArguments("--audio --reason Known result."), { media: "audio", purpose: "Known result." });
});

test("FaceTime CLI rejects recipients, conflicting/duplicate/unknown flags, misplaced media and unsafe or oversized reasons", () => {
  for (const args of [
    "owner@example.invalid", "--media video", "--video=yes", "--unknown", "--video extra",
    "--video --audio", "--audio --video", "--video --video", "--reason", "--video --reason",
    "--reason Topic --video", "--reason Topic --reason Other", "--reason Topic --unknown",
    "--reason bad\x1btext", "--reason bad\u202etext", `--reason ${"x".repeat(301)}`,
    `--video --reason ${"😀".repeat(76)}`, "x".repeat(1025),
  ]) assert.throws(() => parseFaceTimeCallArguments(args), /Usage:|call purpose/);
});
