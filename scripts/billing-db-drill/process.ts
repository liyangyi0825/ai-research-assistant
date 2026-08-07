import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  secretValues?: readonly string[];
  maxOutputBytes?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function boundedBuffer(chunks: Buffer[], maxBytes: number): { append(chunk: Buffer): void; value(): Buffer } {
  let totalBytes = 0;
  return {
    append(chunk) {
      if (totalBytes >= maxBytes) {
        return;
      }
      const remainingBytes = maxBytes - totalBytes;
      const boundedChunk = chunk.subarray(0, remainingBytes);
      chunks.push(boundedChunk);
      totalBytes += boundedChunk.length;
    },
    value() {
      return Buffer.concat(chunks, totalBytes);
    },
  };
}

export function redactText(input: string, secretValues: readonly string[] = []): string {
  let redacted = input.replace(/\bpostgres(?:ql)?:\/\/[^\s'"`<>]+/gi, "[REDACTED_DATABASE_URL]");
  for (const secret of [...secretValues].filter((value) => value.length > 0).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("[REDACTED_SECRET]");
  }
  return redacted;
}

export function runRedacted(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    fail("PROCESS_OUTPUT_LIMIT_INVALID");
  }

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdout = boundedBuffer(stdoutChunks, maxOutputBytes);
    const stderr = boundedBuffer(stderrChunks, maxOutputBytes);
    let settled = false;
    const settle = (callback: () => void) => {
      if (!settled) {
        settled = true;
        callback();
      }
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => stdout.append(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(Buffer.from(chunk)));
    child.once("error", () => settle(() => reject(new Error("PROCESS_SPAWN_FAILED"))));
    child.once("close", (code) => settle(() => {
      const result = {
        stdout: redactText(stdout.value().toString("utf8"), options.secretValues),
        stderr: redactText(stderr.value().toString("utf8"), options.secretValues),
      };
      if (code !== 0) {
        const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n");
        reject(new Error(diagnostics ? `PROCESS_EXIT_NONZERO: ${diagnostics}` : "PROCESS_EXIT_NONZERO"));
        return;
      }
      resolve(result);
    }));
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
