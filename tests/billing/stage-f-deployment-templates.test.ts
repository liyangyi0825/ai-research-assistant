import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const templateDirectory = join(process.cwd(), "deploy", "staging");

test("Stage F PM2 template binds only the staging process to loopback port 3001", () => {
  const require = createRequire(import.meta.url);
  const config = require(join(templateDirectory, "ecosystem.config.cjs")) as {
    apps: Array<Record<string, unknown>>;
  };

  assert.equal(config.apps.length, 1);
  assert.deepEqual(config.apps[0], {
    name: "ai-research-staging",
    cwd: "/var/www/ai-research-assistant-staging",
    script: "node_modules/next/dist/bin/next",
    args: "start --hostname 127.0.0.1 --port 3001",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_memory_restart: "1G",
    env: {
      NODE_ENV: "production",
      PORT: "3001",
      HOSTNAME: "127.0.0.1",
    },
  });
});

test("Stage F deploy template refuses main and never manages Nginx, DNS, SSL, or production PM2", async () => {
  const script = await readFile(join(templateDirectory, "deploy.sh"), "utf8");

  assert.match(script, /EXPECTED_BRANCH="codex\/billing-mvp"/);
  assert.match(script, /EXPECTED_PROCESS="ai-research-staging"/);
  assert.match(script, /STAGING_DIR="\/var\/www\/ai-research-assistant-staging"/);
  assert.match(script, /node --env-file="\.env\.local" --import tsx scripts\/billing-stage-f-preflight\.ts/);
  assert.match(script, /npm ci/);
  assert.match(script, /npm run build/);
  assert.match(script, /pm2 startOrReload deploy\/staging\/ecosystem\.config\.cjs --only "\$EXPECTED_PROCESS" --update-env/);
  assert.doesNotMatch(script, /origin\/main|fetch\s+origin\s+main|reset\s+--hard/i);
  assert.doesNotMatch(script, /nginx|certbot|cloudflare|dnspod|ai-research(?:\s|["'])/i);
});

test("Stage F Nginx template is inactive-by-default and proxies only to loopback", async () => {
  const config = await readFile(
    join(templateDirectory, "nginx-staging.conf.example"),
    "utf8",
  );

  assert.match(config, /server_name staging\.iyanhub\.com;/);
  assert.match(config, /allow 127\.0\.0\.1;/);
  assert.match(config, /allow ::1;/);
  assert.match(config, /deny all;/);
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);
  assert.doesNotMatch(config, /ssl_certificate|listen\s+443|certbot/i);
});

test("Stage F environment template keeps real keys empty and fixes the approved refs", async () => {
  const environment = await readFile(
    join(templateDirectory, "environment.example"),
    "utf8",
  );

  assert.match(environment, /^BILLING_STAGE_F_PROJECT_REF=fqnpzsecalhrsqhpdaxs$/m);
  assert.match(environment, /^BILLING_PRODUCTION_PROJECT_REFS=peuvsaxpnmqpuzyekwuj$/m);
  assert.match(environment, /^BILLING_TEST_USER_IDS=2b630ee1-9743-4efa-bbab-83dfe657050c$/m);
  assert.match(environment, /^BILLING_FEATURE_ENABLED=false$/m);
  assert.match(environment, /^PAYMENT_MODE=mock$/m);
  assert.match(environment, /^BILLING_REAL_PAYMENT_PUBLIC_ENABLED=false$/m);
  for (const key of [
    "WECHAT_PAY_MCH_ID",
    "WECHAT_PAY_API_V3_KEY",
    "WECHAT_PAY_PRIVATE_KEY",
    "ALIPAY_APP_ID",
    "ALIPAY_PRIVATE_KEY",
  ]) {
    assert.match(environment, new RegExp(`^${key}=$`, "m"), key);
  }
  assert.doesNotMatch(environment, /SUPABASE_SERVICE_ROLE_KEY=\S+/);
});
