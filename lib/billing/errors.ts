export class BillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BillingError";
    Object.setPrototypeOf(this, BillingError.prototype);
  }
}
