import {
  UsageQuotaService,
  type BillingUsageRpcAdapter,
  type UsageReservationInput,
  type UsageRpcResult,
} from "./usage-quota";

export class CreditService {
  private readonly usage: UsageQuotaService;

  constructor(adapter?: BillingUsageRpcAdapter) {
    this.usage = new UsageQuotaService(adapter);
  }

  reserve(input: UsageReservationInput): Promise<UsageRpcResult> {
    return this.usage.reserve(input);
  }

  finalize(userId: string, taskKey: string): Promise<UsageRpcResult> {
    return this.usage.finalize(userId, taskKey);
  }

  release(userId: string, taskKey: string): Promise<UsageRpcResult> {
    return this.usage.release(userId, taskKey);
  }
}
