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
    "",
  ]) {
    assert.throws(
      () => verifyWechatTimestamp({ timestamp, now, toleranceSeconds: 300 }),
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
