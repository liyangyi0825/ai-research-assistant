import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as rsaSign,
  verify as rsaVerify,
} from "node:crypto";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import type { WechatPayConfig } from "../../lib/billing/payments/wechat-config";
import * as wechatTransport from "../../lib/billing/payments/wechat-transport";
import {
  WechatHttpClient,
  type WechatFetch,
} from "../../lib/billing/payments/wechat-transport";

const NOW = new Date("2026-08-20T00:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1_000));
const RESPONSE_NONCE = "response-nonce";
const VERIFIER_ID = "PUB_KEY_ID_1";
const MAX_RESPONSE_BYTES = 256 * 1_024;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
});
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

type FetchCall = {
  input: string;
  init: RequestInit;
};

function config(): WechatPayConfig {
  return {
    mchId: "1900000001",
    appId: "wx-test",
    apiV3Key: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
    merchantPrivateKeyPem: privateKeyPem,
    merchantCertificateSerialNumber: "MERCHANT_SERIAL",
    notifyUrl: "https://merchant.example.test/wechat/notify",
    verifier: {
      mode: "PUBLIC_KEY",
      keyId: VERIFIER_ID,
      publicKeyPem,
    },
  };
}

function responseSignature(body: string, overrides: {
  timestamp?: string;
  nonce?: string;
} = {}): string {
  const timestamp = overrides.timestamp ?? TIMESTAMP;
  const nonce = overrides.nonce ?? RESPONSE_NONCE;
  return rsaSign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, "utf8"),
    privateKey,
  ).toString("base64");
}

function signedResponse(input: {
  status: number;
  body: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  verifierId?: string;
  headers?: HeadersInit;
}): Response {
  const timestamp = input.timestamp ?? TIMESTAMP;
  const nonce = input.nonce ?? RESPONSE_NONCE;
  return new Response(input.body, {
    status: input.status,
    headers: {
      "Content-Type": "application/json",
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Signature":
        input.signature ?? responseSignature(input.body, { timestamp, nonce }),
      "Wechatpay-Serial": input.verifierId ?? VERIFIER_ID,
      ...input.headers,
    },
  });
}

function recordingFetch(
  calls: FetchCall[],
  response: () => Response | Promise<Response>,
): WechatFetch {
  return async (input, init) => {
    calls.push({ input, init });
    return response();
  };
}

function client(fetchImpl: WechatFetch, overrides: {
  timeoutMs?: number;
  maxResponseBytes?: number;
} = {}): WechatHttpClient {
  return new WechatHttpClient({
    config: config(),
    fetchImpl,
    now: () => new Date(NOW),
    nonce: () => "request-nonce",
    ...overrides,
  });
}

function expectFixedError(
  error: unknown,
  expected: { code: string; status: number; message: string },
  sensitiveValues: readonly string[] = [],
): boolean {
  assert.equal(error instanceof BillingError, true);
  if (!(error instanceof BillingError)) return false;
  assert.equal(error.code === expected.code, true);
  assert.equal(error.status, expected.status);
  assert.equal(error.message === expected.message, true);
  const serialized = `${error.name} ${error.code} ${error.status} ${error.message}`;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) {
      assert.equal(serialized.includes(sensitiveValue), false);
    }
  }
  return true;
}

test("request sends the once-serialized body to the fixed WeChat HTTPS origin and signs those exact bytes", async () => {
  const calls: FetchCall[] = [];
  const responseBody = JSON.stringify({ code_url: "weixin://wxpay/test-only" });
  const requestBody = {
    appid: "wx-test",
    mchid: "1900000001",
    amount: { total: 7_900 },
  };
  const expectedBody = JSON.stringify(requestBody);
  const result = await client(
    recordingFetch(calls, () =>
      signedResponse({ status: 200, body: responseBody }),
    ),
  ).request<{ code_url: string }>({
    method: "POST",
    pathWithQuery: "/v3/pay/transactions/native?source=web",
    body: requestBody,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.code_url === "weixin://wxpay/test-only", true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(
    call.input,
    "https://api.mch.weixin.qq.com/v3/pay/transactions/native?source=web",
  );
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body === expectedBody, true);
  assert.equal(call.init.redirect, "manual");
  assert.equal(call.init.signal instanceof AbortSignal, true);

  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.has("User-Agent"), false);
  const authorization = headers.get("Authorization");
  assert.ok(authorization);
  const fields = authorization.match(
    /^WECHATPAY2-SHA256-RSA2048 mchid="1900000001",nonce_str="request-nonce",timestamp="(\d+)",serial_no="MERCHANT_SERIAL",signature="([A-Za-z0-9+/]+={0,2})"$/,
  );
  assert.ok(fields);
  assert.equal(fields[1], TIMESTAMP);
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(
        `POST\n/v3/pay/transactions/native?source=web\n${TIMESTAMP}\nrequest-nonce\n${expectedBody}\n`,
        "utf8",
      ),
      publicKey,
      Buffer.from(fields[2], "base64"),
    ),
    true,
  );
});

test("GET signs and sends an empty body without a content type", async () => {
  const calls: FetchCall[] = [];
  await client(
    recordingFetch(calls, () =>
      signedResponse({ status: 200, body: JSON.stringify({ state: "SUCCESS" }) }),
    ),
  ).request<{ state: string }>({
    method: "GET",
    pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1?mchid=1900000001",
  });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.init.body, undefined);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.has("Content-Type"), false);
  const authorization = headers.get("Authorization");
  assert.ok(authorization);
  const signatureBase64 = authorization.match(/signature="([^"]+)"$/)?.[1];
  assert.ok(signatureBase64);
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(
        `GET\n/v3/pay/transactions/out-trade-no/order-1?mchid=1900000001\n${TIMESTAMP}\nrequest-nonce\n\n`,
        "utf8",
      ),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    ),
    true,
  );
});

test("request rejects non-v3, authority, fragment, backslash, dot-segment, and control-character path escapes before fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl: WechatFetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  const invalidPaths = [
    "https://evil.example/v3/pay",
    "//evil.example/v3/pay",
    "/v2/pay/transactions/native",
    "/v3/pay/transactions/native#fragment",
    "/v3/\\evil.example/pay",
    "/v3/../merchant-secrets",
    "/v3/%2e%2e/merchant-secrets",
    "/v3/pay\r\nX-Evil: 1",
  ];

  for (const pathWithQuery of invalidPaths) {
    await assert.rejects(
      client(fetchImpl).request({ method: "GET", pathWithQuery }),
      (error: unknown) =>
        expectFixedError(error, {
          code: "PAYMENT_PROVIDER_REQUEST_INVALID",
          status: 400,
          message: "The WeChat Pay request is invalid.",
        }),
    );
  }
  assert.equal(fetchCalls, 0);
});

test("verified 4xx provider codes map through a fixed local allowlist", async () => {
  const cases = [
    {
      providerCode: "PARAM_ERROR",
      localCode: "PAYMENT_PROVIDER_REQUEST_INVALID",
      status: 400,
      message: "The WeChat Pay request is invalid.",
    },
    {
      providerCode: "ORDERPAID",
      localCode: "PAYMENT_PROVIDER_STATE_CONFLICT",
      status: 409,
      message: "The WeChat Pay request conflicts with payment state.",
    },
    {
      providerCode: "NO_AUTH",
      localCode: "PAYMENT_PROVIDER_REQUEST_REJECTED",
      status: 400,
      message: "WeChat Pay rejected the request.",
    },
    {
      providerCode: "UNRECOGNIZED_SECRET_CODE",
      localCode: "PAYMENT_PROVIDER_REQUEST_REJECTED",
      status: 400,
      message: "WeChat Pay rejected the request.",
    },
  ] as const;

  for (const entry of cases) {
    const providerMessage = `provider-secret-message-${entry.providerCode}`;
    const codeUrl = `weixin://sensitive/${entry.providerCode}`;
    const body = JSON.stringify({
      code: entry.providerCode,
      message: providerMessage,
      code_url: codeUrl,
    });
    await assert.rejects(
      client(async () => signedResponse({ status: 400, body })).request({
        method: "POST",
        pathWithQuery: "/v3/pay/transactions/native",
        body: { out_trade_no: "order-1" },
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: entry.localCode,
            status: entry.status,
            message: entry.message,
          },
          [entry.providerCode, providerMessage, codeUrl, body],
        ),
    );
  }
});

test("unsigned responses are rejected before status bodies are trusted or parsed", async () => {
  const secret = "unsigned-provider-secret";
  for (const status of [200, 400, 503]) {
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(
              Buffer.from(`{\"code\":\"${secret}\",\"message\":`, "utf8"),
            );
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      {
        status,
        headers: { "Wechatpay-Timestamp": TIMESTAMP },
      },
    );
    await assert.rejects(
      client(async () => response).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
            status: 502,
            message: "WeChat Pay returned an invalid response.",
          },
          [secret],
        ),
    );
    assert.equal(pulls, 0);
  }
});

test("tampered signed 3xx, 4xx, and 5xx responses never use status or body classification", async () => {
  const signedBody = JSON.stringify({ code: "PARAM_ERROR" });
  const tamperedBody = JSON.stringify({
    code: "ORDERPAID",
    message: "tampered-provider-message",
    code_url: "weixin://tampered/secret",
  });
  const signature = responseSignature(signedBody);

  for (const status of [302, 400, 500]) {
    await assert.rejects(
      client(async () =>
        signedResponse({ status, body: tamperedBody, signature }),
      ).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) => {
        assert.equal(error instanceof BillingError, true);
        if (!(error instanceof BillingError)) return false;
        assert.equal(error.code === "WECHAT_SIGNATURE_INVALID", true);
        assert.equal(error.status, 400);
        const serialized = `${error.code} ${error.message}`;
        assert.equal(serialized.includes("ORDERPAID"), false);
        assert.equal(serialized.includes("tampered-provider-message"), false);
        assert.equal(serialized.includes("weixin://tampered/secret"), false);
        assert.equal(serialized.includes(signature), false);
        return true;
      },
    );
  }
});

test("response timestamps use the injected server clock and a fixed replay window", async () => {
  const staleTimestamp = String(Number(TIMESTAMP) - 301);
  const body = JSON.stringify({ state: "SUCCESS" });

  await assert.rejects(
    client(async () =>
      signedResponse({ status: 200, body, timestamp: staleTimestamp }),
    ).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) => {
      assert.equal(error instanceof BillingError, true);
      if (!(error instanceof BillingError)) return false;
      assert.equal(error.code === "WECHAT_TIMESTAMP_INVALID", true);
      assert.equal(error.status, 400);
      assert.equal(error.message.includes(staleTimestamp), false);
      return true;
    },
  );
});

test("only a verified 5xx response is classified as retryable", async () => {
  const providerCode = "SYSTEM_ERROR_SECRET";
  const providerMessage = "backend-secret-detail";
  const body = JSON.stringify({ code: providerCode, message: providerMessage });

  await assert.rejects(
    client(async () => signedResponse({ status: 503, body })).request({
      method: "POST",
      pathWithQuery: "/v3/pay/transactions/native",
      body: { out_trade_no: "order-1" },
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_UNAVAILABLE",
          status: 503,
          message: "WeChat Pay is temporarily unavailable.",
        },
        [providerCode, providerMessage, body],
      ),
  );
});

test("timeout aborts the injected fetch and becomes a fixed retryable error", async () => {
  let observedSignal: AbortSignal | undefined;
  const fetchImpl: WechatFetch = async (_input, init) => {
    observedSignal = init.signal ?? undefined;
    assert.ok(observedSignal);
    return new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener(
        "abort",
        () => reject(new DOMException("secret-abort-reason", "AbortError")),
        { once: true },
      );
    });
  };

  await assert.rejects(
    client(fetchImpl, { timeoutMs: 0 }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_UNAVAILABLE",
          status: 503,
          message: "WeChat Pay is temporarily unavailable.",
        },
        ["secret-abort-reason"],
      ),
  );
  assert.equal(observedSignal?.aborted, true);
});

test("stream reading cancels immediately after crossing the 256 KiB response limit", async () => {
  let pulls = 0;
  let canceled = false;
  const firstChunk = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20);
  const neverReadSecret = "stream-secret-code_url";
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(firstChunk);
          return;
        }
        controller.enqueue(Buffer.from(neverReadSecret, "utf8"));
        controller.close();
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const oversizedBody = firstChunk.toString("utf8") + neverReadSecret;
  const response = new Response(stream, {
    status: 200,
    headers: {
      "Content-Length": "0",
      "Wechatpay-Timestamp": TIMESTAMP,
      "Wechatpay-Nonce": RESPONSE_NONCE,
      "Wechatpay-Signature": responseSignature(oversizedBody),
      "Wechatpay-Serial": VERIFIER_ID,
    },
  });

  await assert.rejects(
    client(async () => response).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
          status: 502,
          message: "WeChat Pay returned an invalid response.",
        },
        [neverReadSecret],
      ),
  );
  assert.equal(canceled, true);
  assert.equal(pulls, 1);
  assert.equal(response.body?.locked, false);
});

test("a verified non-JSON success is a fixed permanent invalid-response failure", async () => {
  const body = "non-json-provider-secret-code_url";
  await assert.rejects(
    client(async () => signedResponse({ status: 200, body })).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
          status: 502,
          message: "WeChat Pay returned an invalid response.",
        },
        [body],
      ),
  );
});

test("path validation rejects decoded segment escapes and repeated slashes before fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl: WechatFetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  const invalidPaths = [
    "/v3/pay//transactions/native",
    "/v3/pay/%2Ftransactions/native",
    "/v3/pay/%2ftransactions/native",
    "/v3/pay/%5Ctransactions/native",
    "/v3/pay/%5ctransactions/native",
    "/v3/%2E/pay",
    "/v3/%2e%2E/pay",
    "/v3/%2e%2e%2fmerchant-secrets",
    "/v3/%2E%2E%5Cmerchant-secrets",
    "/v3/pay/%0Aheader",
    "/v3/pay/%",
    "/v3/pay/%GG",
  ];

  for (const pathWithQuery of invalidPaths) {
    await assert.rejects(
      client(fetchImpl).request({ method: "GET", pathWithQuery }),
      (error: unknown) =>
        expectFixedError(error, {
          code: "PAYMENT_PROVIDER_REQUEST_INVALID",
          status: 400,
          message: "The WeChat Pay request is invalid.",
        }),
    );
  }
  assert.equal(fetchCalls, 0);
});

test("response bytes must be fatal UTF-8 before signature verification", async () => {
  const signedText = JSON.stringify({ value: "\uFFFD" });
  const invalidWireBytes = Buffer.concat([
    Buffer.from('{"value":"', "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}', "utf8"),
  ]);
  const response = new Response(invalidWireBytes, {
    status: 200,
    headers: {
      "Wechatpay-Timestamp": TIMESTAMP,
      "Wechatpay-Nonce": RESPONSE_NONCE,
      "Wechatpay-Signature": responseSignature(signedText),
      "Wechatpay-Serial": VERIFIER_ID,
    },
  });

  await assert.rejects(
    client(async () => response).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(error, {
        code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
        status: 502,
        message: "WeChat Pay returned an invalid response.",
      }),
  );
});

test("manual redirect mode verifies then permanently rejects signed 3xx responses", async () => {
  const calls: FetchCall[] = [];
  const providerSecret = "redirect-provider-secret";
  const locationSecret = "https://redirect.example/secret";
  const body = JSON.stringify({ message: providerSecret });

  await assert.rejects(
    client(
      recordingFetch(calls, () =>
        signedResponse({
          status: 302,
          body,
          headers: { Location: locationSecret },
        }),
      ),
    ).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
          status: 502,
          message: "WeChat Pay returned an invalid response.",
        },
        [providerSecret, locationSecret, body],
      ),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.redirect === "manual", true);
});

test("unbranded fetch exceptions are fixed permanent transport failures", async () => {
  const secret = "untrusted-fetch-secret";
  const failures: unknown[] = [
    new Error(secret),
    new SyntaxError(secret),
    new BillingError("EXTERNAL_SECRET_CODE", secret, 503),
    new DOMException(secret, "AbortError"),
  ];

  for (const failure of failures) {
    await assert.rejects(
      client(async () => {
        throw failure;
      }).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_TRANSPORT_FAILED",
            status: 502,
            message: "WeChat Pay transport failed.",
          },
          [secret, "EXTERNAL_SECRET_CODE"],
        ),
    );
  }
});

test("explicitly injected fetch TypeErrors are permanent", async () => {
  const secret = "explicit-connection-secret";
  await assert.rejects(
    client(async () => {
      throw new TypeError(secret);
    }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_TRANSPORT_FAILED",
          status: 502,
          message: "WeChat Pay transport failed.",
        },
        [secret],
      ),
  );
});

test("GET requests reject a body before signing or fetch", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    client(async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      body: { hidden: "request-body-secret" },
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_REQUEST_INVALID",
          status: 400,
          message: "The WeChat Pay request is invalid.",
        },
        ["request-body-secret"],
      ),
  );
  assert.equal(fetchCalls, 0);
});

test("verified 5xx responses are retryable before JSON parsing", async () => {
  const cases = [
    { status: 500, body: "signed-text-provider-secret" },
    { status: 502, body: "" },
    { status: 599, body: "{" },
  ];

  for (const entry of cases) {
    await assert.rejects(
      client(async () =>
        signedResponse({ status: entry.status, body: entry.body }),
      ).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_UNAVAILABLE",
            status: 503,
            message: "WeChat Pay is temporarily unavailable.",
          },
          [entry.body],
        ),
    );
  }
});

test("missing or empty signature headers cancel an unread body without pulling or locking", async () => {
  const headerCases: HeadersInit[] = [
    { "Wechatpay-Timestamp": TIMESTAMP },
    {
      "Wechatpay-Timestamp": "",
      "Wechatpay-Nonce": "",
      "Wechatpay-Signature": "",
      "Wechatpay-Serial": "",
    },
  ];

  for (const headers of headerCases) {
    let pulls = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls += 1;
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, { status: 200, headers });

    await assert.rejects(
      client(async () => response).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(error, {
          code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
          status: 502,
          message: "WeChat Pay returned an invalid response.",
        }),
    );
    assert.equal(canceled, true);
    assert.equal(pulls, 0);
    assert.equal(response.body?.locked, false);
  }
});

test("response body reader releases its lock after successful consumption", async () => {
  const body = JSON.stringify({ state: "SUCCESS" });
  const response = signedResponse({ status: 200, body });

  await client(async () => response).request({
    method: "GET",
    pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
  });

  assert.equal(response.body?.locked, false);
});

test("response stream read errors are canceled when possible and always unlocked", async () => {
  const streamSecret = "stream-read-secret";
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.error(new Error(streamSecret));
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream, {
    status: 200,
    headers: {
      "Wechatpay-Timestamp": TIMESTAMP,
      "Wechatpay-Nonce": RESPONSE_NONCE,
      "Wechatpay-Signature": responseSignature("{}"),
      "Wechatpay-Serial": VERIFIER_ID,
    },
  });

  await assert.rejects(
    client(async () => response).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_TRANSPORT_FAILED",
          status: 502,
          message: "WeChat Pay transport failed.",
        },
        [streamSecret],
      ),
  );
  assert.equal(response.body?.locked, false);
});

test("response timestamp verification samples the clock after body consumption", async () => {
  const responseNow = new Date(NOW.getTime() + 301_000);
  const responseTimestamp = String(Math.floor(responseNow.getTime() / 1_000));
  const body = JSON.stringify({ state: "SUCCESS" });
  let clockCalls = 0;
  const httpClient = new WechatHttpClient({
    config: config(),
    fetchImpl: async () =>
      signedResponse({
        status: 200,
        body,
        timestamp: responseTimestamp,
      }),
    now: () => {
      clockCalls += 1;
      return clockCalls === 1 ? new Date(NOW) : new Date(responseNow);
    },
    nonce: () => "request-nonce",
  });

  const result = await httpClient.request<{ state: string }>({
    method: "GET",
    pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.state === "SUCCESS", true);
  assert.equal(clockCalls, 2);
});

test("comma-joined WeChat signature headers are permanently rejected", async () => {
  const body = JSON.stringify({ state: "SUCCESS" });
  const headerNames = [
    "Wechatpay-Timestamp",
    "Wechatpay-Nonce",
    "Wechatpay-Signature",
    "Wechatpay-Serial",
  ] as const;

  for (const duplicatedHeader of headerNames) {
    const headers = new Headers({
      "Wechatpay-Timestamp": TIMESTAMP,
      "Wechatpay-Nonce": RESPONSE_NONCE,
      "Wechatpay-Signature": responseSignature(body),
      "Wechatpay-Serial": VERIFIER_ID,
    });
    headers.append(duplicatedHeader, "duplicate-secret-value");
    if (duplicatedHeader === "Wechatpay-Nonce") {
      const combinedNonce = headers.get("Wechatpay-Nonce");
      assert.ok(combinedNonce);
      headers.set(
        "Wechatpay-Signature",
        responseSignature(body, { nonce: combinedNonce }),
      );
    }
    const response = new Response(body, { status: 200, headers });

    await assert.rejects(
      client(async () => response).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
            status: 502,
            message: "WeChat Pay returned an invalid response.",
          },
          ["duplicate-secret-value"],
        ),
    );
  }
});

test("timeout during response body consumption settles only after unlocking the stream", async () => {
  let response: Response | undefined;
  let observedSignal: AbortSignal | undefined;
  const fetchImpl: WechatFetch = async (_input, init) => {
    observedSignal = init.signal ?? undefined;
    assert.ok(observedSignal);
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          observedSignal?.addEventListener(
            "abort",
            () => controller.error(new Error("local-timeout-stream-secret")),
            { once: true },
          );
        },
      },
      { highWaterMark: 0 },
    );
    response = new Response(stream, {
      status: 200,
      headers: {
        "Wechatpay-Timestamp": TIMESTAMP,
        "Wechatpay-Nonce": RESPONSE_NONCE,
        "Wechatpay-Signature": responseSignature("{}"),
        "Wechatpay-Serial": VERIFIER_ID,
      },
    });
    return response;
  };

  await assert.rejects(
    client(fetchImpl, { timeoutMs: 0 }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_UNAVAILABLE",
          status: 503,
          message: "WeChat Pay is temporarily unavailable.",
        },
        ["local-timeout-stream-secret"],
      ),
  );
  assert.equal(observedSignal?.aborted, true);
  assert.equal(response?.body?.locked, false);
});

test("successful requests clear their timeout without a real wait", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const handle = {} as ReturnType<typeof setTimeout>;
  let scheduled: (() => void) | undefined;
  let cleared = false;
  let observedSignal: AbortSignal | undefined;

  globalThis.setTimeout = ((callback: () => void) => {
    scheduled = callback;
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((value: ReturnType<typeof setTimeout>) => {
    assert.equal(value === handle, true);
    cleared = true;
    scheduled = undefined;
  }) as typeof clearTimeout;

  try {
    await client(async (_input, init) => {
      observedSignal = init.signal ?? undefined;
      return signedResponse({
        status: 200,
        body: JSON.stringify({ state: "SUCCESS" }),
      });
    }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    });
    assert.equal(cleared, true);
    assert.equal(scheduled, undefined);
    assert.equal(observedSignal?.aborted, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("verified 4xx non-object, non-string code, and 429 bodies stay permanently fixed", async () => {
  const cases = [
    { status: 400, body: "null" },
    { status: 400, body: "[]" },
    { status: 400, body: JSON.stringify({ code: 7, message: "secret-number-code" }) },
    { status: 429, body: JSON.stringify({ code: "FREQUENCY_LIMITED", message: "secret-rate" }) },
  ];

  for (const entry of cases) {
    await assert.rejects(
      client(async () =>
        signedResponse({ status: entry.status, body: entry.body }),
      ).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_REQUEST_REJECTED",
            status: 400,
            message: "WeChat Pay rejected the request.",
          },
          [entry.body, "FREQUENCY_LIMITED", "secret-rate"],
        ),
    );
  }
});

test("signed empty 204 and 304 responses are permanent invalid responses", async () => {
  for (const status of [204, 304]) {
    const response = new Response(null, {
      status,
      headers: {
        "Wechatpay-Timestamp": TIMESTAMP,
        "Wechatpay-Nonce": RESPONSE_NONCE,
        "Wechatpay-Signature": responseSignature(""),
        "Wechatpay-Serial": VERIFIER_ID,
      },
    });
    await assert.rejects(
      client(async () => response).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(error, {
          code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
          status: 502,
          message: "WeChat Pay returned an invalid response.",
        }),
    );
  }
});

test("Content-Length cannot override streamed response byte accounting", async () => {
  const body = JSON.stringify({ state: "SUCCESS" });
  const response = signedResponse({
    status: 200,
    body,
    headers: { "Content-Length": "999999999" },
  });

  const result = await client(async () => response).request<{ state: string }>({
    method: "GET",
    pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
  });
  assert.equal(result.body.state === "SUCCESS", true);
});

test("path validation rejects every segment that remains percent-encoded after one decode", async () => {
  let fetchCalls = 0;
  const fetchImpl: WechatFetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  const invalidPaths = [
    "/v3/%252e%252e/merchant-secrets",
    "/v3/%252E%252E/merchant-secrets",
    "/v3/pay/%252Ftransactions",
    "/v3/pay/%252ftransactions",
    "/v3/pay/%255Ctransactions",
    "/v3/pay/%255ctransactions",
    "/v3/pay/%25252e%25252e",
    "/v3/pay/%2525252Ftransactions",
  ];

  for (const pathWithQuery of invalidPaths) {
    await assert.rejects(
      client(fetchImpl).request({ method: "GET", pathWithQuery }),
      (error: unknown) =>
        expectFixedError(error, {
          code: "PAYMENT_PROVIDER_REQUEST_INVALID",
          status: 400,
          message: "The WeChat Pay request is invalid.",
        }),
    );
  }
  assert.equal(fetchCalls, 0);
});

test("transport exports no factory that can mint network trust", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      wechatTransport,
      "createWechatFetchAdapter",
    ),
    false,
  );
});

test("the default global fetch uses the internal trusted boundary", async () => {
  const originalFetch = globalThis.fetch;
  const secret = "default-global-connection-secret";
  globalThis.fetch = (async () => {
    throw new TypeError(secret);
  }) as typeof fetch;
  try {
    const httpClient = new WechatHttpClient({
      config: config(),
      now: () => new Date(NOW),
      nonce: () => "request-nonce",
    });
    await assert.rejects(
      httpClient.request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_UNAVAILABLE",
            status: 503,
            message: "WeChat Pay is temporarily unavailable.",
          },
          [secret],
        ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only a default-fetch response reader TypeError is retryable", async () => {
  const secret = "trusted-reader-connection-secret";
  const makeResponse = (): Response => {
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(new TypeError(secret));
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, {
      status: 200,
      headers: {
        "Wechatpay-Timestamp": TIMESTAMP,
        "Wechatpay-Nonce": RESPONSE_NONCE,
        "Wechatpay-Signature": responseSignature("{}"),
        "Wechatpay-Serial": VERIFIER_ID,
      },
    });
  };
  const originalFetch = globalThis.fetch;
  const trustedResponse = makeResponse();

  globalThis.fetch = (async () => trustedResponse) as typeof fetch;
  try {
    const httpClient = new WechatHttpClient({
      config: config(),
      now: () => new Date(NOW),
      nonce: () => "request-nonce",
    });
    await assert.rejects(
      httpClient.request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_UNAVAILABLE",
            status: 503,
            message: "WeChat Pay is temporarily unavailable.",
          },
          [secret],
        ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(trustedResponse.body?.locked, false);

  const explicitResponse = makeResponse();
  await assert.rejects(
    client(async () => explicitResponse).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_TRANSPORT_FAILED",
          status: 502,
          message: "WeChat Pay transport failed.",
        },
        [secret],
      ),
  );
  assert.equal(explicitResponse.body?.locked, false);
});

test("ordinary injected TypeErrors cannot spoof the private connection trust marker", async () => {
  const secret = "spoofed-private-marker-secret";
  const spoofed = Object.assign(new TypeError(secret), {
    name: "WechatConnectionError",
    connection: true,
    [Symbol.for("WechatConnectionError")]: true,
  });

  await assert.rejects(
    client(async () => {
      throw spoofed;
    }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_TRANSPORT_FAILED",
          status: 502,
          message: "WeChat Pay transport failed.",
        },
        [secret, "WechatConnectionError"],
      ),
  );
});

test("missing signature headers stay permanent when unread-body cancellation hangs", async () => {
  let cancelCalls = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulls += 1;
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream, {
    status: 400,
    headers: { "Wechatpay-Timestamp": TIMESTAMP },
  });

  await assert.rejects(
    client(async () => response, { timeoutMs: 0 }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(error, {
        code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
        status: 502,
        message: "WeChat Pay returned an invalid response.",
      }),
  );
  assert.equal(cancelCalls, 1);
  assert.equal(pulls, 0);
  assert.equal(response.body?.locked, false);
});

test("oversized responses stay permanent when reader cancellation hangs", async () => {
  let cancelCalls = 0;
  const oversizedChunk = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(oversizedChunk);
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream, {
    status: 200,
    headers: {
      "Wechatpay-Timestamp": TIMESTAMP,
      "Wechatpay-Nonce": RESPONSE_NONCE,
      "Wechatpay-Signature": responseSignature("not-consumed"),
      "Wechatpay-Serial": VERIFIER_ID,
    },
  });

  await assert.rejects(
    client(async () => response, { timeoutMs: 0 }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(error, {
        code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
        status: 502,
        message: "WeChat Pay returned an invalid response.",
      }),
  );
  assert.equal(cancelCalls, 1);
  assert.equal(response.body?.locked, false);
});

test("a hanging response read times out, cancels best-effort, unlocks, and has no unhandled rejection", async () => {
  let cancelCalls = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream, {
    status: 200,
    headers: {
      "Wechatpay-Timestamp": TIMESTAMP,
      "Wechatpay-Nonce": RESPONSE_NONCE,
      "Wechatpay-Signature": responseSignature("{}"),
      "Wechatpay-Serial": VERIFIER_ID,
    },
  });

  try {
    await assert.rejects(
      client(async () => response, { timeoutMs: 0 }).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(error, {
          code: "PAYMENT_PROVIDER_UNAVAILABLE",
          status: 503,
          message: "WeChat Pay is temporarily unavailable.",
        }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelCalls, 1);
    assert.equal(response.body?.locked, false);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("successful JSON responses must be non-null non-array records", async () => {
  const invalidBodies = ["null", "[]", '"string-secret"', "7", "true", "false"];

  for (const body of invalidBodies) {
    await assert.rejects(
      client(async () => signedResponse({ status: 200, body })).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
            status: 502,
            message: "WeChat Pay returned an invalid response.",
          },
          [body, "string-secret"],
        ),
    );
  }
});
