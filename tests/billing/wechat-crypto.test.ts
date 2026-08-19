import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  type KeyObject,
  sign as rsaSign,
  verify as rsaVerify,
} from "node:crypto";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import {
  decryptWechatResource,
  signWechatRequest,
  type WechatRequestSigningInput,
  verifyWechatSignature,
  verifyWechatTimestamp,
} from "../../lib/billing/payments/wechat-crypto";
import type { WechatVerifierConfig } from "../../lib/billing/payments/wechat-config";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);

  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) {
    bytes.unshift(remaining & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function testCertificatePem(
  certificatePrivateKey: KeyObject,
  certificatePublicKey: KeyObject,
): string {
  const sha256WithRsa = der(
    0x30,
    Buffer.from("06092a864886f70d01010b", "hex"),
    Buffer.from("0500", "hex"),
  );
  const commonName = der(
    0x30,
    der(
      0x31,
      der(
        0x30,
        Buffer.from("0603550403", "hex"),
        der(0x0c, Buffer.from("wechat-crypto-test", "utf8")),
      ),
    ),
  );
  const validity = der(
    0x30,
    der(0x17, Buffer.from("260101000000Z", "ascii")),
    der(0x17, Buffer.from("360101000000Z", "ascii")),
  );
  const subjectPublicKeyInfo = certificatePublicKey.export({
    type: "spki",
    format: "der",
  });
  const toBeSigned = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, Buffer.from([0x01])),
    sha256WithRsa,
    commonName,
    validity,
    commonName,
    subjectPublicKeyInfo,
  );
  const signature = rsaSign("RSA-SHA256", toBeSigned, certificatePrivateKey);
  const certificate = der(
    0x30,
    toBeSigned,
    sha256WithRsa,
    der(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  );
  const base64 = certificate.toString("base64");
  const lines = base64.match(/.{1,64}/g);
  assert.ok(lines);
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

const certificatePem = testCertificatePem(privateKey, publicKey);

function signatureFor(timestamp: string, nonce: string, body: string): string {
  return rsaSign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, "utf8"),
    privateKey,
  ).toString("base64");
}

function mutateByte(value: Buffer, index: number): Buffer {
  const mutated = Buffer.from(value);
  mutated[index] ^= 0x01;
  return mutated;
}

function isBillingError(
  error: unknown,
  code: string,
  sensitiveValues: readonly string[] = [],
): boolean {
  assert.ok(error instanceof BillingError);
  assert.equal(error.code, code);
  assert.ok(error.status >= 400 && error.status < 500);
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length === 0) continue;
    assert.equal(error.message.includes(sensitiveValue), false);
  }
  return true;
}

function signingInput(
  overrides: Partial<WechatRequestSigningInput> = {},
): WechatRequestSigningInput {
  return {
    method: "POST",
    pathWithQuery: "/v3/pay/transactions/native?x=1",
    body: "{\"amount\":{\"total\":7900}}",
    timestamp: 1_787_073_600,
    nonce: "nonce-1",
    mchId: "1900000001",
    certificateSerialNumber: "MERCHANT_SERIAL",
    privateKeyPem,
    ...overrides,
  };
}

function isSigningFailure(
  error: unknown,
  sensitiveValue: string,
): boolean {
  assert.ok(error instanceof BillingError);
  assert.equal(error.code, "WECHAT_SIGNING_FAILED");
  assert.equal(error.status, 500);
  assert.equal(error.message, "WeChat request signing failed.");
  if (sensitiveValue.length > 0) {
    assert.equal(error.message.includes(sensitiveValue), false);
  }
  return true;
}

function publicKeyVerifier(): WechatVerifierConfig {
  return {
    mode: "PUBLIC_KEY",
    keyId: "PUB_KEY_ID_1",
    publicKeyPem,
  };
}

function nonCanonicalPaddingBits(value: string): string {
  assert.equal(value.endsWith("=="), true);
  const index = value.length - 3;
  const replacement = { A: "B", Q: "R", g: "h", w: "x" }[
    value[index]
  ];
  assert.ok(replacement);
  return `${value.slice(0, index)}${replacement}==`;
}

test("signWechatRequest signs the exact canonical request and authorization fields", () => {
  const signed = signWechatRequest({
    method: "POST",
    pathWithQuery: "/v3/pay/transactions/native?x=1",
    body: "{\"amount\":{\"total\":7900}}",
    timestamp: 1_787_073_600,
    nonce: "nonce-1",
    mchId: "1900000001",
    certificateSerialNumber: "MERCHANT_SERIAL",
    privateKeyPem,
  });

  assert.equal(
    signed.message,
    "POST\n/v3/pay/transactions/native?x=1\n1787073600\nnonce-1\n{\"amount\":{\"total\":7900}}\n",
  );
  assert.match(
    signed.authorization,
    /^WECHATPAY2-SHA256-RSA2048 mchid="1900000001",nonce_str="nonce-1",timestamp="1787073600",serial_no="MERCHANT_SERIAL",signature="[A-Za-z0-9+/]+={0,2}"$/,
  );

  const signatureBase64 = signed.authorization.match(/signature="([^"]+)"$/)?.[1];
  assert.ok(signatureBase64);
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(signed.message, "utf8"),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    ),
    true,
  );
});

test("signWechatRequest accepts RFC3986-unreserved nonce characters", () => {
  const signed = signWechatRequest(
    signingInput({ nonce: "nonce-dot.~_safe" }),
  );

  assert.equal(
    signed.message,
    "POST\n/v3/pay/transactions/native?x=1\n1787073600\nnonce-dot.~_safe\n{\"amount\":{\"total\":7900}}\n",
  );
  assert.match(signed.authorization, /nonce_str="nonce-dot\.~_safe"/);
});

test("request signatures reject query, body, and signature-byte tampering", () => {
  const signed = signWechatRequest({
    method: "POST",
    pathWithQuery: "/v3/pay/transactions/native?x=1",
    body: "{\"amount\":{\"total\":7900}}",
    timestamp: 1_787_073_600,
    nonce: "nonce-1",
    mchId: "1900000001",
    certificateSerialNumber: "MERCHANT_SERIAL",
    privateKeyPem,
  });
  const signatureBase64 = signed.authorization.match(/signature="([^"]+)"$/)?.[1];
  assert.ok(signatureBase64);
  const signature = Buffer.from(signatureBase64, "base64");

  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(signed.message.replace("?x=1", "?x=2"), "utf8"),
      publicKey,
      signature,
    ),
    false,
  );
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(signed.message.replace("7900", "7901"), "utf8"),
      publicKey,
      signature,
    ),
    false,
  );
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(signed.message, "utf8"),
      publicKey,
      mutateByte(signature, signature.length - 1),
    ),
    false,
  );
});

test("signWechatRequest rejects header injection and canonical-field control characters", () => {
  const invalidInputs: Array<
    [Partial<WechatRequestSigningInput>, string]
  > = [
    [{ nonce: 'n",foo="bar' }, 'n",foo="bar'],
    [{ method: "POST\r\nX-Evil: 1" }, "POST\r\nX-Evil: 1"],
    [
      { pathWithQuery: "/v3/pay\r\nX-Evil: 1" },
      "/v3/pay\r\nX-Evil: 1",
    ],
    [{ nonce: "nonce\r\nX-Evil: 1" }, "nonce\r\nX-Evil: 1"],
    [{ mchId: "1900000001\r\nX-Evil: 1" }, "1900000001\r\nX-Evil: 1"],
    [
      { certificateSerialNumber: "SERIAL\r\nX-Evil: 1" },
      "SERIAL\r\nX-Evil: 1",
    ],
  ];

  for (const [overrides, sensitiveValue] of invalidInputs) {
    assert.throws(
      () => signWechatRequest(signingInput(overrides)),
      (error: unknown) => isSigningFailure(error, sensitiveValue),
    );
  }
});

test("signWechatRequest rejects invalid timestamp numbers", () => {
  for (const timestamp of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1_787_073_600.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => signWechatRequest(signingInput({ timestamp })),
      (error: unknown) => isSigningFailure(error, String(timestamp)),
    );
  }
});

test("signWechatRequest rejects empty, malformed, and overlong protocol fields", () => {
  const invalidInputs: Array<
    [Partial<WechatRequestSigningInput>, string]
  > = [
    [{ method: "" }, ""],
    [{ method: "post" }, "post"],
    [{ method: "P".repeat(33) }, "P".repeat(33)],
    [{ pathWithQuery: "" }, ""],
    [{ pathWithQuery: "v3/pay" }, "v3/pay"],
    [{ pathWithQuery: `/${"p".repeat(2_048)}` }, "p".repeat(2_048)],
    [{ nonce: "" }, ""],
    [{ nonce: "n,foo" }, "n,foo"],
    [{ nonce: "n".repeat(33) }, "n".repeat(33)],
    [{ mchId: "" }, ""],
    [{ mchId: "m,ch" }, "m,ch"],
    [{ mchId: "merchant_1" }, "merchant_1"],
    [{ mchId: "m".repeat(33) }, "m".repeat(33)],
    [{ certificateSerialNumber: "" }, ""],
    [{ certificateSerialNumber: "serial\u0000value" }, "serial\u0000value"],
    [
      { certificateSerialNumber: "S".repeat(65) },
      "S".repeat(65),
    ],
  ];

  for (const [overrides, sensitiveValue] of invalidInputs) {
    assert.throws(
      () => signWechatRequest(signingInput(overrides)),
      (error: unknown) => isSigningFailure(error, sensitiveValue),
    );
  }
});

test("verifyWechatSignature accepts a matching public-key verifier", () => {
  const timestamp = "1787073600";
  const nonce = "response-nonce";
  const body = "{\"event_type\":\"TRANSACTION.SUCCESS\"}";
  const verifier: WechatVerifierConfig = {
    mode: "PUBLIC_KEY",
    keyId: "PUB_KEY_ID_1",
    publicKeyPem,
  };

  assert.doesNotThrow(() =>
    verifyWechatSignature({
      timestamp,
      nonce,
      body,
      signatureBase64: signatureFor(timestamp, nonce, body),
      verifierId: "PUB_KEY_ID_1",
      verifier,
    }),
  );
});

test("verifyWechatSignature accepts a matching platform-certificate verifier", () => {
  const timestamp = "1787073600";
  const nonce = "certificate-nonce";
  const body = "{\"id\":\"notification-1\"}";
  const verifier: WechatVerifierConfig = {
    mode: "PLATFORM_CERTIFICATE",
    serialNumber: "CERT_SERIAL_1",
    certificatePem,
  };

  assert.doesNotThrow(() =>
    verifyWechatSignature({
      timestamp,
      nonce,
      body,
      signatureBase64: signatureFor(timestamp, nonce, body),
      verifierId: "CERT_SERIAL_1",
      verifier,
    }),
  );
});

test("verifyWechatSignature rejects unknown verifier IDs exactly", () => {
  const timestamp = "1787073600";
  const nonce = "unknown-id-nonce";
  const body = "{\"id\":\"notification-2\"}";
  const verifier: WechatVerifierConfig = {
    mode: "PUBLIC_KEY",
    keyId: "PUB_KEY_ID_1",
    publicKeyPem,
  };

  assert.throws(
    () =>
      verifyWechatSignature({
        timestamp,
        nonce,
        body,
        signatureBase64: signatureFor(timestamp, nonce, body),
        verifierId: "pub_key_id_1",
        verifier,
      }),
    (error: unknown) =>
      isBillingError(error, "WECHAT_VERIFIER_UNKNOWN", [nonce, body]),
  );
});

test("verifyWechatSignature rejects body, nonce, and signature-byte tampering", () => {
  const timestamp = "1787073600";
  const nonce = "tamper-nonce";
  const body = "{\"amount\":7900}";
  const signature = Buffer.from(
    signatureFor(timestamp, nonce, body),
    "base64",
  );
  const verifier: WechatVerifierConfig = {
    mode: "PUBLIC_KEY",
    keyId: "PUB_KEY_ID_1",
    publicKeyPem,
  };
  const invalidInputs = [
    { nonce, body: "{\"amount\":7901}", signatureBase64: signature.toString("base64") },
    { nonce: "tampered-nonce", body, signatureBase64: signature.toString("base64") },
    {
      nonce,
      body,
      signatureBase64: mutateByte(signature, 0).toString("base64"),
    },
  ];

  for (const invalid of invalidInputs) {
    assert.throws(
      () =>
        verifyWechatSignature({
          timestamp,
          ...invalid,
          verifierId: "PUB_KEY_ID_1",
          verifier,
        }),
      (error: unknown) =>
        isBillingError(error, "WECHAT_SIGNATURE_INVALID", [
          invalid.nonce,
          invalid.body,
          invalid.signatureBase64,
        ]),
    );
  }
});

test("verifyWechatSignature rejects whitespace, trailing data, malformed, and oversized Base64", () => {
  const timestamp = "1787073600";
  const nonce = "strict-base64-nonce";
  const body = "{\"id\":\"strict-base64\"}";
  const validSignature = signatureFor(timestamp, nonce, body);
  const invalidSignatures = [
    "",
    ` ${validSignature}`,
    `${validSignature.slice(0, 100)}\n${validSignature.slice(100)}`,
    `${validSignature}AAAA`,
    "%%%not-base64%%%",
    "A".repeat(348),
  ];

  for (const signatureBase64 of invalidSignatures) {
    assert.throws(
      () =>
        verifyWechatSignature({
          timestamp,
          nonce,
          body,
          signatureBase64,
          verifierId: "PUB_KEY_ID_1",
          verifier: publicKeyVerifier(),
        }),
      (error: unknown) =>
        isBillingError(error, "WECHAT_SIGNATURE_INVALID", [
          signatureBase64,
          nonce,
          body,
        ]),
    );
  }
});

test("verifyWechatSignature rejects non-canonical Base64 padding bits", () => {
  const timestamp = "1787073600";
  const nonce = "padding-bits-nonce";
  const body = "{\"id\":\"padding-bits\"}";
  const signatureBase64 = nonCanonicalPaddingBits(
    signatureFor(timestamp, nonce, body),
  );

  assert.throws(
    () =>
      verifyWechatSignature({
        timestamp,
        nonce,
        body,
        signatureBase64,
        verifierId: "PUB_KEY_ID_1",
        verifier: publicKeyVerifier(),
      }),
    (error: unknown) =>
      isBillingError(error, "WECHAT_SIGNATURE_INVALID", [
        signatureBase64,
        nonce,
        body,
      ]),
  );
});

test("verifyWechatTimestamp accepts both inclusive 300-second boundaries", () => {
  const now = new Date(1_787_073_600_000);

  assert.doesNotThrow(() =>
    verifyWechatTimestamp({
      timestamp: "1787073300",
      now,
      toleranceSeconds: 300,
    }),
  );
  assert.doesNotThrow(() =>
    verifyWechatTimestamp({
      timestamp: "1787073900",
      now,
      toleranceSeconds: 300,
    }),
  );
});

test("verifyWechatTimestamp rejects values outside the boundary and non-integers", () => {
  const now = new Date(1_787_073_600_000);

  for (const timestamp of [
    "1787073299",
    "1787073901",
    "1787073600.5",
    "1787073600x",
    "-1",
    "9007199254740992",
    "1787073600000",
    "",
  ]) {
    assert.throws(
      () => verifyWechatTimestamp({ timestamp, now, toleranceSeconds: 300 }),
      (error: unknown) =>
        isBillingError(error, "WECHAT_TIMESTAMP_INVALID", [timestamp]),
    );
  }
});

test("verifyWechatTimestamp rejects an unsafe integer independently of the replay window", () => {
  assert.throws(
    () =>
      verifyWechatTimestamp({
        timestamp: "9007199254740992",
        now: new Date(8_640_000_000_000_000),
        toleranceSeconds: 8_998_559_254_740_992,
      }),
    (error: unknown) =>
      isBillingError(error, "WECHAT_TIMESTAMP_INVALID", [
        "9007199254740992",
      ]),
  );
});

test("verifyWechatTimestamp rejects invalid clocks and non-integer tolerances", () => {
  const timestamp = "1787073600";
  const invalidInputs = [
    { now: new Date(Number.NaN), toleranceSeconds: 300 },
    { now: new Date(1_787_073_600_000), toleranceSeconds: -1 },
    { now: new Date(1_787_073_600_000), toleranceSeconds: 0.5 },
    { now: new Date(1_787_073_600_000), toleranceSeconds: Number.NaN },
    {
      now: new Date(1_787_073_600_000),
      toleranceSeconds: Number.POSITIVE_INFINITY,
    },
    {
      now: new Date(1_787_073_600_000),
      toleranceSeconds: Number.MAX_SAFE_INTEGER + 1,
    },
  ];

  for (const invalid of invalidInputs) {
    assert.throws(
      () => verifyWechatTimestamp({ timestamp, ...invalid }),
      (error: unknown) =>
        isBillingError(error, "WECHAT_TIMESTAMP_INVALID", [timestamp]),
    );
  }
});

test("decryptWechatResource decrypts a deterministic AES-256-GCM resource", () => {
  const plaintext = decryptWechatResource({
    apiV3Key: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
    nonce: "0123456789ab",
    associatedData: "transaction",
    ciphertextBase64:
      "4ouKWSuj/DnPJxKEgzRMF3K25P41tTpaw61Kv9zml1GNQhPsUW0=",
  });

  assert.equal(plaintext, "{\"mchid\":\"1900000001\"}");
});

test("decryptWechatResource rejects wrong key, nonce, AAD, tag, and ciphertext", () => {
  const ciphertext = Buffer.from(
    "4ouKWSuj/DnPJxKEgzRMF3K25P41tTpaw61Kv9zml1GNQhPsUW0=",
    "base64",
  );
  const valid = {
    apiV3Key: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
    nonce: "0123456789ab",
    associatedData: "transaction",
    ciphertextBase64: ciphertext.toString("base64"),
  };
  const invalidInputs = [
    { ...valid, apiV3Key: Buffer.alloc(32, 0x78) },
    { ...valid, apiV3Key: Buffer.alloc(31, 0x78) },
    { ...valid, nonce: "1123456789ab" },
    { ...valid, associatedData: "transaction-tampered" },
    {
      ...valid,
      ciphertextBase64: mutateByte(ciphertext, ciphertext.length - 1).toString(
        "base64",
      ),
    },
    {
      ...valid,
      ciphertextBase64: mutateByte(ciphertext, 0).toString("base64"),
    },
    { ...valid, ciphertextBase64: Buffer.alloc(15).toString("base64") },
    { ...valid, ciphertextBase64: "%%%not-base64%%%" },
  ];

  for (const invalid of invalidInputs) {
    assert.throws(
      () => decryptWechatResource(invalid),
      (error: unknown) =>
        isBillingError(error, "WECHAT_RESOURCE_INVALID", [
          invalid.nonce,
          invalid.associatedData,
          invalid.ciphertextBase64,
          invalid.apiV3Key.toString("utf8"),
        ]),
    );
  }
});

test("decryptWechatResource rejects non-canonical and bounded Base64 violations", () => {
  const valid = {
    apiV3Key: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
    nonce: "0123456789ab",
    associatedData: "transaction",
  };
  const invalidCiphertexts = [
    "4ouKWSuj/DnPJxKEgzRMF3K25P41tTpaw61Kv9zml1GNQhPsUW1=",
    " 4ouKWSuj/DnPJxKEgzRMF3K25P41tTpaw61Kv9zml1GNQhPsUW0=",
    "4ouKWSuj/DnPJxKEgzRMF3K25P41tTpaw61Kv9zml1GNQhPsUW0=AAAA",
    "A".repeat(1_048_580),
  ];

  for (const ciphertextBase64 of invalidCiphertexts) {
    assert.throws(
      () => decryptWechatResource({ ...valid, ciphertextBase64 }),
      (error: unknown) =>
        isBillingError(error, "WECHAT_RESOURCE_INVALID", [valid.nonce]),
    );
  }
});

test("decryptWechatResource rejects authenticated resources with non-12-byte nonces", () => {
  const apiV3Key = Buffer.from(
    "0123456789abcdef0123456789abcdef",
    "utf8",
  );
  const associatedData = "transaction";
  const invalidNonceFixtures = [
    {
      nonce: "0123456789a",
      ciphertextBase64:
        "4Qp96tOIWttKSDyEOIMJF+UDRg0G+o9iObBfSrx72E61RVf5qRY=",
    },
    {
      nonce: "0123456789abc",
      ciphertextBase64:
        "0Ys9GKmKrqttodHsRkYq5rtq20hE3hNW2U/VnbOccrfGu+A3/lw=",
    },
    {
      nonce: "微0123456789",
      ciphertextBase64:
        "EGGn73U9DfTWam4nfz+re1L7iULcse/2DgIN5jK6QsxzCiVJWz8=",
    },
  ];

  for (const invalid of invalidNonceFixtures) {
    assert.notEqual(Buffer.byteLength(invalid.nonce, "utf8"), 12);
    assert.throws(
      () =>
        decryptWechatResource({
          apiV3Key,
          associatedData,
          ...invalid,
        }),
      (error: unknown) =>
        isBillingError(error, "WECHAT_RESOURCE_INVALID", [
          invalid.nonce,
          invalid.ciphertextBase64,
        ]),
    );
  }
});
