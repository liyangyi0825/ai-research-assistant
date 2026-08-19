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

export function signWechatRequest(input: WechatRequestSigningInput): {
  authorization: string;
  message: string;
} {
  const message = `${input.method}\n${input.pathWithQuery}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`;

  let signatureBase64: string;
  try {
    signatureBase64 = rsaSign(
      "RSA-SHA256",
      Buffer.from(message, "utf8"),
      input.privateKeyPem,
    ).toString("base64");
  } catch {
    throw cryptoError(
      "WECHAT_SIGNING_FAILED",
      "WeChat request signing failed.",
      500,
    );
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

  let verified = false;
  try {
    verified = rsaVerify(
      "RSA-SHA256",
      Buffer.from(message, "utf8"),
      verifierPem,
      Buffer.from(input.signatureBase64, "base64"),
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
    if (
      input.ciphertextBase64.length === 0 ||
      input.ciphertextBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        input.ciphertextBase64,
      )
    ) {
      throw resourceInvalid();
    }

    const encrypted = Buffer.from(input.ciphertextBase64, "base64");
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

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw resourceInvalid();
  }
}
