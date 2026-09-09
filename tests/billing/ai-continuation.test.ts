import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_CONTINUATION_OPERATIONS,
  canonicalAiRequestHash,
  conceptContinuationPolicy,
  pptSectionContinuationPolicy,
  translationContinuationPolicy,
} from "../../lib/billing/ai-continuation";

test("canonical request hashes are key-order independent but payload sensitive", () => {
  const first = canonicalAiRequestHash({
    concept: "robotics",
    nested: { z: 2, a: 1 },
    papers: [{ year: 2025, title: "A" }],
  });
  const reordered = canonicalAiRequestHash({
    papers: [{ title: "A", year: 2025 }],
    nested: { a: 1, z: 2 },
    concept: "robotics",
  });
  const changed = canonicalAiRequestHash({
    papers: [{ title: "B", year: 2025 }],
    nested: { a: 1, z: 2 },
    concept: "robotics",
  });

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test("concept roots provision exactly blocks 2 through 4 and bind later payloads", () => {
  const root = conceptContinuationPolicy({
    block: 1,
    concept: "robotics",
    papers: [],
    originText: "",
    conceptsText: "",
  });
  assert.equal(root.operationKey, AI_CONTINUATION_OPERATIONS.concept);
  assert.equal(root.continuation, undefined);
  assert.deepEqual(root.continuationStages, [
    { stageKey: "block:2" },
    { stageKey: "block:3" },
    { stageKey: "block:4" },
  ]);

  const stage = conceptContinuationPolicy({
    block: 3,
    concept: "robotics",
    papers: [{ title: "paper" }],
    originText: "origin",
    conceptsText: "concepts",
  });
  assert.deepEqual(stage.continuation, {
    stageKey: "block:3",
    requestHash: canonicalAiRequestHash({
      block: 3,
      concept: "robotics",
      papers: [{ title: "paper" }],
      originText: "origin",
      conceptsText: "concepts",
    }),
  });
  assert.equal(stage.continuationStages, undefined);

  assert.throws(
    () =>
      conceptContinuationPolicy({
        block: 5,
        concept: "robotics",
        papers: [],
        originText: "",
        conceptsText: "",
      }),
    /invalid concept continuation stage/i,
  );
});

test("translation pages are finite continuations bound to one document manifest", () => {
  const manifest = [
    { pageNum: 1, textHash: "a".repeat(64) },
    { pageNum: 3, textHash: "b".repeat(64) },
  ];
  const root = translationContinuationPolicy({
    pageNum: 1,
    textHash: manifest[0].textHash,
    manifest,
  });
  assert.equal(root.continuation, undefined);
  assert.deepEqual(root.continuationStages, [{
    stageKey: "page:3",
    requestHash: canonicalAiRequestHash(manifest[1]),
  }]);

  const continuation = translationContinuationPolicy({
    pageNum: 3,
    textHash: manifest[1].textHash,
    manifest,
  });
  assert.deepEqual(continuation.continuation, root.continuationStages?.[0]);
  assert.throws(
    () => translationContinuationPolicy({
      pageNum: 3,
      textHash: "c".repeat(64),
      manifest,
    }),
    /manifest/i,
  );
});

const outline = Array.from({ length: 9 }, (_, index) => ({
  type: "content",
  title: `Slide ${index + 1}`,
  note: index === 4 ? "focus on evidence" : "",
}));

test("PPT batch zero derives a finite prebound plan from the actual outline", () => {
  const root = pptSectionContinuationPolicy({
    paperContent: "paper",
    outlineSlides: outline.slice(0, 4),
    allOutline: outline,
    scene: "defense",
    batchIndex: 0,
  });

  assert.equal(root.operationKey, AI_CONTINUATION_OPERATIONS.pptSections);
  assert.equal(root.totalBatches, 3);
  assert.equal(root.continuation, undefined);
  assert.deepEqual(
    root.continuationStages.map(({ stageKey }) => stageKey),
    ["batch:1", "batch:2"],
  );
  assert.match(root.continuationStages[0]?.requestHash ?? "", /^[0-9a-f]{64}$/);

  const second = pptSectionContinuationPolicy({
    paperContent: "paper",
    outlineSlides: outline.slice(4, 8),
    allOutline: outline,
    scene: "defense",
    batchIndex: 1,
  });
  assert.deepEqual(second.continuation, root.continuationStages[0]);
  assert.equal(second.userNotes, "《Slide 5》：focus on evidence");
});

test("PPT stage authorization rejects client-selected slices, unbounded indexes, and oversized outlines", () => {
  assert.throws(
    () =>
      pptSectionContinuationPolicy({
        paperContent: "paper",
        outlineSlides: outline.slice(0, 4),
        allOutline: outline,
        scene: "defense",
        batchIndex: 1,
      }),
    /does not match the server-derived batch/i,
  );
  assert.throws(
    () =>
      pptSectionContinuationPolicy({
        paperContent: "paper",
        outlineSlides: outline.slice(0, 4),
        allOutline: outline,
        scene: "defense",
        batchIndex: 99,
      }),
    /invalid ppt batch index/i,
  );
  assert.throws(
    () =>
      pptSectionContinuationPolicy({
        paperContent: "paper",
        outlineSlides: Array.from({ length: 4 }, (_, index) => ({ index })),
        allOutline: Array.from({ length: 81 }, (_, index) => ({ index })),
        scene: "defense",
        batchIndex: 0,
      }),
    /too many ppt outline slides/i,
  );
});
