import { createHash } from "node:crypto";

import { BillingError } from "./errors";
import type {
  ContinuationStageProvision,
} from "./usage-quota";

export const AI_CONTINUATION_OPERATIONS = {
  concept: "concept_explorer",
  pptContent: "ppt_generate_content",
  pptSections: "ppt_generate_sections",
} as const;

const PPT_BATCH_SIZE = 4;
const MAX_PPT_BATCHES = 20;
const MAX_PPT_OUTLINE_SLIDES = PPT_BATCH_SIZE * MAX_PPT_BATCHES;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BillingError(
        "INVALID_CONTINUATION_PAYLOAD",
        "Continuation payload numbers must be finite.",
        400,
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) =>
        entry === undefined ? "null" : canonicalJson(entry),
      )
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${properties.join(",")}}`;
  }
  throw new BillingError(
    "INVALID_CONTINUATION_PAYLOAD",
    "Continuation payload contains an unsupported value.",
    400,
  );
}

export function canonicalAiRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

type ContinuationPolicy = {
  operationKey: string;
  continuation?: {
    stageKey: string;
    requestHash: string;
  };
  continuationStages?: ContinuationStageProvision[];
};

export function conceptContinuationPolicy(input: {
  block: number;
  concept: string;
  papers: unknown[];
  originText: string;
  conceptsText: string;
}): ContinuationPolicy {
  if (!Number.isInteger(input.block) || input.block < 1 || input.block > 4) {
    throw new BillingError(
      "INVALID_CONTINUATION_STAGE",
      "Invalid concept continuation stage.",
      400,
    );
  }

  if (input.block === 1) {
    return {
      operationKey: AI_CONTINUATION_OPERATIONS.concept,
      continuationStages: [2, 3, 4].map((block) => ({
        stageKey: `block:${block}`,
      })),
    };
  }

  return {
    operationKey: AI_CONTINUATION_OPERATIONS.concept,
    continuation: {
      stageKey: `block:${input.block}`,
      requestHash: canonicalAiRequestHash(input),
    },
  };
}

function pptPolicyError(message: string): never {
  throw new BillingError("INVALID_CONTINUATION_STAGE", message, 400);
}

function outlineNotes(outlineSlides: readonly unknown[]): string {
  return outlineSlides
    .flatMap((slide) => {
      if (!slide || typeof slide !== "object" || Array.isArray(slide)) {
        return [];
      }
      const record = slide as Record<string, unknown>;
      const note = typeof record.note === "string" ? record.note.trim() : "";
      if (!note) return [];
      const title =
        typeof record.title === "string" && record.title.trim()
          ? record.title.trim()
          : "未命名页面";
      return [`《${title}》：${note}`];
    })
    .join("；");
}

type PptSectionPolicyInput = {
  paperContent: string;
  outlineSlides: readonly unknown[];
  allOutline: readonly unknown[];
  scene: string;
  batchIndex?: number;
};

type PptSectionPolicy = ContinuationPolicy & {
  batchIndex: number;
  totalBatches: number;
  userNotes: string;
  continuationStages: ContinuationStageProvision[];
};

export function pptSectionContinuationPolicy(
  input: PptSectionPolicyInput,
): PptSectionPolicy {
  if (!Array.isArray(input.allOutline) || input.allOutline.length === 0) {
    return pptPolicyError("The PPT outline is empty.");
  }
  if (input.allOutline.length > MAX_PPT_OUTLINE_SLIDES) {
    return pptPolicyError("Too many PPT outline slides.");
  }
  if (!Array.isArray(input.outlineSlides) || input.outlineSlides.length === 0) {
    return pptPolicyError("The PPT batch is empty.");
  }
  if (input.scene !== "defense" && input.scene !== "meeting") {
    return pptPolicyError("Invalid PPT scene.");
  }

  const batchIndex = input.batchIndex ?? 0;
  const totalBatches = Math.ceil(input.allOutline.length / PPT_BATCH_SIZE);
  if (
    !Number.isSafeInteger(batchIndex) ||
    batchIndex < 0 ||
    batchIndex >= totalBatches
  ) {
    return pptPolicyError("Invalid PPT batch index.");
  }

  const batch = (index: number) =>
    input.allOutline.slice(
      index * PPT_BATCH_SIZE,
      (index + 1) * PPT_BATCH_SIZE,
    );
  const expectedSlides = batch(batchIndex);
  if (canonicalJson(input.outlineSlides) !== canonicalJson(expectedSlides)) {
    return pptPolicyError(
      "The submitted outline does not match the server-derived batch.",
    );
  }

  const requestHashFor = (index: number) => {
    const slides = batch(index);
    return canonicalAiRequestHash({
      paperContent: input.paperContent,
      outlineSlides: slides,
      allOutline: input.allOutline,
      scene: input.scene,
      batchIndex: index,
      userNotes: outlineNotes(slides),
    });
  };
  const continuationStages = Array.from(
    { length: Math.max(0, totalBatches - 1) },
    (_, offset) => {
      const index = offset + 1;
      return {
        stageKey: `batch:${index}`,
        requestHash: requestHashFor(index),
      };
    },
  );

  return {
    operationKey: AI_CONTINUATION_OPERATIONS.pptSections,
    batchIndex,
    totalBatches,
    userNotes: outlineNotes(expectedSlides),
    ...(batchIndex === 0
      ? {}
      : {
          continuation: {
            stageKey: `batch:${batchIndex}`,
            requestHash: requestHashFor(batchIndex),
          },
        }),
    continuationStages,
  };
}
