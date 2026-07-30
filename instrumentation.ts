export async function register() {
  const { validateBillingRuntimeAtStartup } = await import(
    "./lib/billing/config"
  );

  validateBillingRuntimeAtStartup();
}
