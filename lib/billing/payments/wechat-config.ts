import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";

import { BillingError } from "../errors";

export type WechatVerifierConfig =
  | { mode: "PUBLIC_KEY"; keyId: string; publicKeyPem: string }
  | {
      mode: "PLATFORM_CERTIFICATE";
      serialNumber: string;
      certificatePem: string;
    };

export type WechatPayConfig = {
  mchId: string;
  appId: string;
  apiV3Key: Buffer;
  merchantPrivateKeyPem: string;
  merchantCertificateSerialNumber: string;
  notifyUrl: string;
  verifier: WechatVerifierConfig;
};

type WechatEnvironment = Readonly<Record<string, string | undefined>>;

function configurationError(
  code: "PROVIDER_NOT_CONFIGURED" | "PAYMENT_CONFIGURATION_CONFLICT",
  variables: readonly string[],
): BillingError {
  return new BillingError(
    code,
    `Invalid WeChat Pay configuration: ${variables.join(", ")}.`,
    code === "PROVIDER_NOT_CONFIGURED" ? 503 : 500,
  );
}

function required(env: WechatEnvironment, variable: string): string {
  const value = env[variable]?.trim();
  if (!value) {
    throw configurationError("PROVIDER_NOT_CONFIGURED", [variable]);
  }
  return value;
}

function canonicalValue(
  env: WechatEnvironment,
  canonical: string,
  alias: string,
): string {
  const canonicalValue = env[canonical]?.trim();
  const aliasValue = env[alias]?.trim();
  if (canonicalValue && aliasValue && canonicalValue !== aliasValue) {
    throw configurationError("PAYMENT_CONFIGURATION_CONFLICT", [
      canonical,
      alias,
    ]);
  }
  if (!canonicalValue && !aliasValue) {
    throw configurationError("PROVIDER_NOT_CONFIGURED", [canonical]);
  }
  return canonicalValue || aliasValue!;
}

function parsePrivateKey(pem: string, variable: string): void {
  try {
    const key = createPrivateKey(pem);
    if (
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength !== 2_048
    ) {
      throw new Error("not RSA-2048");
    }
  } catch {
    throw configurationError("PROVIDER_NOT_CONFIGURED", [variable]);
  }
}

function parsePublicKey(pem: string): void {
  try {
    const key = createPublicKey(pem);
    if (
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength !== 2_048
    ) {
      throw new Error("not RSA-2048");
    }
  } catch {
    throw configurationError("PROVIDER_NOT_CONFIGURED", ["WECHAT_PAY_PUBLIC_KEY"]);
  }
}

function normalizedCertificateSerialNumber(certificate: X509Certificate): string {
  const normalized = certificate.serialNumber.replaceAll(":", "").toUpperCase();
  return normalized.replace(/^0+/, "") || "0";
}

function parsePlatformCertificate(pem: string): string {
  try {
    const certificate = new X509Certificate(pem);
    const now = Date.now();
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (
      certificate.publicKey.asymmetricKeyType !== "rsa" ||
      certificate.publicKey.asymmetricKeyDetails?.modulusLength !== 2_048 ||
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      now < validFrom ||
      now > validTo
    ) {
      throw new Error("invalid platform certificate");
    }
    return normalizedCertificateSerialNumber(certificate);
  } catch {
    throw configurationError("PROVIDER_NOT_CONFIGURED", [
      "WECHAT_PAY_PLATFORM_CERT",
    ]);
  }
}

function parseNotifyUrl(value: string): void {
  try {
    if (new URL(value).protocol !== "https:") throw new Error("not https");
  } catch {
    throw configurationError("PROVIDER_NOT_CONFIGURED", ["WECHAT_PAY_NOTIFY_URL"]);
  }
}

function verifier(env: WechatEnvironment): WechatVerifierConfig {
  const publicKeyId = env.WECHAT_PAY_PUBLIC_KEY_ID?.trim();
  const publicKeyPem = env.WECHAT_PAY_PUBLIC_KEY?.trim();
  const platformCertificatePem = env.WECHAT_PAY_PLATFORM_CERT?.trim();
  const hasPublicVerifier = Boolean(publicKeyId || publicKeyPem);
  const hasPlatformVerifier = Boolean(platformCertificatePem);

  if (hasPublicVerifier && hasPlatformVerifier) {
    throw configurationError("PAYMENT_CONFIGURATION_CONFLICT", [
      "WECHAT_PAY_PUBLIC_KEY_ID",
      "WECHAT_PAY_PUBLIC_KEY",
      "WECHAT_PAY_PLATFORM_CERT",
    ]);
  }
  if (hasPublicVerifier) {
    if (!publicKeyId || !publicKeyPem) {
      throw configurationError("PROVIDER_NOT_CONFIGURED", [
        !publicKeyId ? "WECHAT_PAY_PUBLIC_KEY_ID" : "WECHAT_PAY_PUBLIC_KEY",
      ]);
    }
    if (!/^PUB_KEY_ID_\d{32,64}$/.test(publicKeyId)) {
      throw configurationError("PROVIDER_NOT_CONFIGURED", [
        "WECHAT_PAY_PUBLIC_KEY_ID",
      ]);
    }
    parsePublicKey(publicKeyPem);
    return { mode: "PUBLIC_KEY", keyId: publicKeyId, publicKeyPem };
  }
  if (platformCertificatePem) {
    return {
      mode: "PLATFORM_CERTIFICATE",
      serialNumber: parsePlatformCertificate(platformCertificatePem),
      certificatePem: platformCertificatePem,
    };
  }
  throw configurationError("PROVIDER_NOT_CONFIGURED", [
    "WECHAT_PAY_PUBLIC_KEY_ID",
    "WECHAT_PAY_PUBLIC_KEY",
    "WECHAT_PAY_PLATFORM_CERT",
  ]);
}

export function loadWechatPayConfig(env: WechatEnvironment): WechatPayConfig {
  const apiV3KeyValue = env.WECHAT_PAY_API_V3_KEY;
  if (
    apiV3KeyValue === undefined ||
    Buffer.byteLength(apiV3KeyValue, "utf8") !== 32
  ) {
    throw configurationError("PROVIDER_NOT_CONFIGURED", ["WECHAT_PAY_API_V3_KEY"]);
  }
  const merchantPrivateKeyPem = canonicalValue(
    env,
    "WECHAT_PAY_PRIVATE_KEY",
    "WECHAT_PAY_MCH_PRIVATE_KEY",
  );
  parsePrivateKey(merchantPrivateKeyPem, "WECHAT_PAY_PRIVATE_KEY");
  const notifyUrl = required(env, "WECHAT_PAY_NOTIFY_URL");
  parseNotifyUrl(notifyUrl);
  const mchId = required(env, "WECHAT_PAY_MCH_ID");
  if (!/^\d{1,32}$/.test(mchId)) {
    throw configurationError("PROVIDER_NOT_CONFIGURED", ["WECHAT_PAY_MCH_ID"]);
  }
  const appId = required(env, "WECHAT_PAY_APP_ID");
  if (!/^wx[A-Za-z0-9]{16}$/.test(appId)) {
    throw configurationError("PROVIDER_NOT_CONFIGURED", ["WECHAT_PAY_APP_ID"]);
  }
  const merchantCertificateSerialNumber = canonicalValue(
    env,
    "WECHAT_PAY_CERT_SERIAL_NO",
    "WECHAT_PAY_MCH_SERIAL_NO",
  );
  if (!/^[0-9A-Fa-f]{1,64}$/.test(merchantCertificateSerialNumber)) {
    throw configurationError("PROVIDER_NOT_CONFIGURED", [
      "WECHAT_PAY_CERT_SERIAL_NO",
    ]);
  }

  return {
    mchId,
    appId,
    apiV3Key: Buffer.from(apiV3KeyValue, "utf8"),
    merchantPrivateKeyPem,
    merchantCertificateSerialNumber:
      merchantCertificateSerialNumber.toUpperCase(),
    notifyUrl,
    verifier: verifier(env),
  };
}
