import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const nextConfigPath = fileURLToPath(
  new URL("../../next.config.ts", import.meta.url),
);

test("next.config leaves .env parsing to the Next.js environment loader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "next-config-env-"));

  try {
    await writeFile(
      join(directory, ".env.local"),
      [
        'WECHAT_PAY_PLATFORM_CERT=""',
        'WECHAT_PAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
        "private-key-body",
        '-----END PRIVATE KEY-----"',
        'WECHAT_PAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----',
        "public-key-body",
        '-----END PUBLIC KEY-----"',
      ].join("\n"),
      "utf8",
    );

    const script = `
      const { pathToFileURL } = await import("node:url");
      const [configPath, directory] = process.argv.slice(1);
      process.chdir(directory);
      for (const name of [
        "WECHAT_PAY_PLATFORM_CERT",
        "WECHAT_PAY_PRIVATE_KEY",
        "WECHAT_PAY_PUBLIC_KEY",
      ]) delete process.env[name];
      await import(pathToFileURL(configPath).href);
      console.log(JSON.stringify({
        platformCertificate: process.env.WECHAT_PAY_PLATFORM_CERT,
        privateKey: process.env.WECHAT_PAY_PRIVATE_KEY,
        publicKey: process.env.WECHAT_PAY_PUBLIC_KEY,
      }));
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script, nextConfigPath, directory],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
