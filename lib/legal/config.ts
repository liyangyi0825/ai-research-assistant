export const LEGAL_OPERATOR_PLACEHOLDER = "运营主体信息待依法确认";

export type LegalOperatorConfig = {
  operatorName: string;
  operatorCreditCode: string;
  contactEmail: string;
  isPlaceholder: boolean;
};

type LegalEnvironment = Readonly<Record<string, string | undefined>>;

function valueOrPlaceholder(value: string | undefined): string {
  return value?.trim() || LEGAL_OPERATOR_PLACEHOLDER;
}

export function getLegalOperatorConfig(
  env: LegalEnvironment = process.env,
): LegalOperatorConfig {
  const operatorName = valueOrPlaceholder(env.LEGAL_OPERATOR_NAME);
  const operatorCreditCode = valueOrPlaceholder(
    env.LEGAL_OPERATOR_CREDIT_CODE,
  );
  const contactEmail = valueOrPlaceholder(env.LEGAL_CONTACT_EMAIL);

  return {
    operatorName,
    operatorCreditCode,
    contactEmail,
    isPlaceholder:
      operatorName === LEGAL_OPERATOR_PLACEHOLDER ||
      operatorCreditCode === LEGAL_OPERATOR_PLACEHOLDER ||
      contactEmail === LEGAL_OPERATOR_PLACEHOLDER,
  };
}
