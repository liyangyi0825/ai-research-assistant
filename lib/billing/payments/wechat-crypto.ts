import {
  createDecipheriv,
  sign as rsaSign,
  verify as rsaVerify,
} from "node:crypto";

import { BillingError } from "../errors";
import type { WechatVerifierConfig } from "./wechat-config";

export type WechatRequestSigningInput = {
  method: string;
  pathWithQuery: string;
  body: string;
  timestamp: number;
  nonce: string;
  mchId: string;
  certificateSerialNumber: string;
  privateKeyPem: string;
};

type WechatCryptoErrorCode =
  | "WECHAT_SIGNING_FAILED"
  | "WECHAT_SIGNATURE_INVALID"
  | "WECHAT_VERIFIER_UNKNOWN"
  | "WECHAT_TIMESTAMP_INVALID"
  | "WECHAT_RESOURCE_INVALID";

const MAX_METHOD_LENGTH = 32;
const MAX_PATH_WITH_QUERY_BYTES = 2_048;
const MAX_NONCE_LENGTH = 32;
const MAX_MCH_ID_LENGTH = 32;
const MAX_CERTIFICATE_SERIAL_LENGTH = 64;
const RSA_2048_SIGNATURE_BASE64_LENGTH = 344;
const RSA_2048_SIGNATURE_BYTES = 256;
const MAX_RESOURCE_BASE64_LENGTH = 1_048_576;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UPPERCASE_HTTP_TOKEN_PATTERN = /^[A-Z0-9!#$%&'*+.^_`|~-]+$/;
const NONCE_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MCH_ID_PATTERN = /^\d+$/;
const CERTIFICATE_SERIAL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function cryptoError(
  code: WechatCryptoErrorCode,
  message: string,
  status = 400,
): BillingError {
  return new BillingError(code, message, status);
}

function signatureInvalid(): BillingError {
  return cryptoError(
    "WECHAT_SIGNATURE_INVALID",
    "WeChat signature verification failed.",
  );
}

function timestampInvalid(): BillingError {
  return cryptoError("WECHAT_TIMESTAMP_INVALID", "WeChat timestamp is invalid.");
}

function resourceInvalid(): BillingError {
  return cryptoError("WECHAT_RESOURCE_INVALID", "WeChat resource is invalid.");
}

function signingFailed(): BillingError {
  return cryptoError(
    "WECHAT_SIGNING_FAILED",
    "WeChat request signing failed.",
    500,
  );
}

function hasValidNonce(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_NONCE_LENGTH &&
    NONCE_PATTERN.test(value)
  );
}

function hasValidMchId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_MCH_ID_LENGTH &&
    MCH_ID_PATTERN.test(value)
  );
}

function hasValidCertificateSerial(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CERTIFICATE_SERIAL_LENGTH &&
    CERTIFICATE_SERIAL_PATTERN.test(value)
  );
}

function hasValidSigningInput(input: WechatRequestSigningInput): boolean {
  return (
    Number.isSafeInteger(input.timestamp) &&
    input.timestamp >= 0 &&
    input.method.length <= MAX_METHOD_LENGTH &&
    UPPERCASE_HTTP_TOKEN_PATTERN.test(input.method) &&
    input.pathWithQuery.startsWith("/") &&
    Buffer.byteLength(input.pathWithQuery, "utf8") <=
      MAX_PATH_WITH_QUERY_BYTES &&
    !ASCII_CONTROL_PATTERN.test(input.pathWithQuery) &&
    hasValidNonce(input.nonce) &&
    hasValidMchId(input.mchId) &&
    hasValidCertificateSerial(input.certificateSerialNumber)
  );
}

function decodeStrictBase64(
  value: string,
  maximumEncodedLength: number,
  expectedDecodedLength?: number,
): Buffer | null {
  if (
    value.length === 0 ||
    value.length > maximumEncodedLength ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (expectedDecodedLength !== undefined &&
      decoded.length !== expectedDecodedLength)
  ) {
    return null;
  }
  return decoded;
}

export function signWechatRequest(input: WechatRequestSigningInput): {
  authorization: string;
  message: string;
} {
  if (!hasValidSigningInput(input)) throw signingFailed();

  const message = `${input.method}\n${input.pathWithQuery}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`;

  let signatureBase64: string;
  try {
    signatureBase64 = rsaSign(
      "RSA-SHA256",
      Buffer.from(message, "utf8"),
      input.privateKeyPem,
    ).toString("base64");
  } catch {
    throw signingFailed();
  }

  return {
    message,
    authorization:
      `WECHATPAY2-SHA256-RSA2048 mchid="${input.mchId}",` +
      `nonce_str="${input.nonce}",timestamp="${input.timestamp}",` +
      `serial_no="${input.certificateSerialNumber}",` +
      `signature="${signatureBase64}"`,
  };
}

export function verifyWechatSignature(input: {
  timestamp: string;
  nonce: string;
  body: string;
  signatureBase64: string;
  verifierId: string;
  verifier: WechatVerifierConfig;
}): void {
  const expectedVerifierId =
    input.verifier.mode === "PUBLIC_KEY"
      ? input.verifier.keyId
      : input.verifier.serialNumber;
  if (input.verifierId !== expectedVerifierId) {
    throw cryptoError(
      "WECHAT_VERIFIER_UNKNOWN",
      "WeChat verifier is unknown.",
    );
  }

  const verifierPem =
    input.verifier.mode === "PUBLIC_KEY"
      ? input.verifier.publicKeyPem
      : input.verifier.certificatePem;
  const message = `${input.timestamp}\n${input.nonce}\n${input.body}\n`;

  const signature = decodeStrictBase64(
    input.signatureBase64,
    RSA_2048_SIGNATURE_BASE64_LENGTH,
    RSA_2048_SIGNATURE_BYTES,
  );
  if (!signature) throw signatureInvalid();

  let verified = false;
  try {
    verified = rsaVerify(
      "RSA-SHA256",
      Buffer.from(message, "utf8"),
      verifierPem,
      signature,
    );
  } catch {
    throw signatureInvalid();
  }
  if (!verified) throw signatureInvalid();
}

export function verifyWechatTimestamp(input: {
  timestamp: string;
  now: Date;
  toleranceSeconds: number;
}): void {
  if (!/^\d+$/.test(input.timestamp)) throw timestampInvalid();

  const timestampSeconds = Number(input.timestamp);
  const nowMilliseconds = input.now.getTime();
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    !Number.isFinite(nowMilliseconds) ||
    !Number.isSafeInteger(input.toleranceSeconds) ||
    input.toleranceSeconds < 0
  ) {
    throw timestampInvalid();
  }

  const nowSeconds = Math.floor(nowMilliseconds / 1_000);
  if (Math.abs(nowSeconds - timestampSeconds) > input.toleranceSeconds) {
    throw timestampInvalid();
  }
}

export function decryptWechatResource(input: {
  apiV3Key: Buffer;
  nonce: string;
  associatedData: string;
  ciphertextBase64: string;
}): string {
  try {
    if (input.apiV3Key.length !== 32) throw resourceInvalid();
    if (Buffer.byteLength(input.nonce, "utf8") !== 12) throw resourceInvalid();
    const encrypted = decodeStrictBase64(
      input.ciphertextBase64,
      MAX_RESOURCE_BASE64_LENGTH,
    );
    if (!encrypted) throw resourceInvalid();
    if (encrypted.length < 16) throw resourceInvalid();

    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const authenticationTag = encrypted.subarray(encrypted.length - 16);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      input.apiV3Key,
      Buffer.from(input.nonce, "utf8"),
    );
    decipher.setAuthTag(authenticationTag);
    decipher.setAAD(Buffer.from(input.associatedData, "utf8"));

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw resourceInvalid();
  }
}
