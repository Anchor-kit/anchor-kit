import type { PaymentRailAdapter } from '../src/runtime/interfaces.ts';
import type {
  NormalizedPaymentRailEvent,
  PaymentRailInitiationRequest,
  PaymentRailOperation,
  RailCapabilityResult,
} from '../src/types/transaction.ts';

export interface MockPaymentRailOptions {
  initialStatus?: 'pending' | 'succeeded' | 'failed';
  statusAfterDelay?: 'pending' | 'succeeded' | 'failed';
  delayMs?: number;
  failInitiation?: boolean;
}

/** Deterministic, in-memory rail fixture for local acceptance checks only. */
export class MockPaymentRail implements PaymentRailAdapter {
  readonly provider = 'mock';
  readonly capabilities = {
    initiation: true,
    eventVerification: true,
    statusLookup: true,
    recovery: true,
  } as const;
  private readonly operations = new Map<string, PaymentRailOperation>();
  private readonly seenEvents = new Map<string, NormalizedPaymentRailEvent>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly options: Required<MockPaymentRailOptions>;

  constructor(options: MockPaymentRailOptions = {}) {
    this.options = {
      initialStatus: options.initialStatus ?? 'pending',
      statusAfterDelay: options.statusAfterDelay ?? 'succeeded',
      delayMs: options.delayMs ?? 0,
      failInitiation: options.failInitiation ?? false,
    };
  }

  async initiate(
    input: PaymentRailInitiationRequest,
  ): Promise<RailCapabilityResult<PaymentRailOperation>> {
    if (this.options.failInitiation) return { supported: false, reason: 'mock initiation failure' };
    const prior = this.operations.get(input.operationId);
    if (prior) {
      if (
        prior.provider !== this.provider ||
        prior.reference !== input.reference ||
        prior.amount.amount !== input.amount.amount ||
        prior.amount.currency !== input.amount.currency
      ) {
        return {
          supported: false,
          reason: 'operationId was reused with different payment details',
        };
      }
      return { supported: true, value: prior };
    }
    const operation: PaymentRailOperation = {
      operationId: input.operationId,
      provider: this.provider,
      reference: input.reference,
      providerReference: `mock-${input.reference}`,
      amount: input.amount,
      status: this.options.initialStatus,
    };
    this.operations.set(input.operationId, operation);
    if (this.options.delayMs === 0)
      this.updateStatus(input.operationId, this.options.statusAfterDelay);
    else
      this.timers.set(
        input.operationId,
        setTimeout(
          () => this.updateStatus(input.operationId, this.options.statusAfterDelay),
          this.options.delayMs,
        ),
      );
    return { supported: true, value: operation };
  }

  async verifyEvent(input: {
    rawBody: string | Buffer | Uint8Array;
  }): Promise<RailCapabilityResult<NormalizedPaymentRailEvent>> {
    let event: NormalizedPaymentRailEvent;
    try {
      event = JSON.parse(Buffer.from(input.rawBody).toString('utf8')) as NormalizedPaymentRailEvent;
    } catch {
      return { supported: false, reason: 'invalid mock event JSON' };
    }
    const prior = this.seenEvents.get(event.eventId);
    if (prior) return { supported: true, value: prior };
    const operation = [...this.operations.values()].find(
      (entry) => entry.reference === event.reference,
    );
    if (
      !operation ||
      event.provider !== this.provider ||
      !event.eventId ||
      !['pending', 'succeeded', 'failed'].includes(event.status)
    ) {
      return { supported: false, reason: 'mock event does not match a known operation' };
    }
    this.seenEvents.set(event.eventId, event);
    this.updateStatus(operation.operationId, event.status);
    return { supported: true, value: event };
  }

  async getStatus(input: {
    operationId: string;
    reference: string;
  }): Promise<RailCapabilityResult<PaymentRailOperation>> {
    const operation = this.operations.get(input.operationId);
    return operation?.reference === input.reference
      ? { supported: true, value: operation }
      : { supported: false, reason: 'mock operation not found' };
  }

  async recover(input: {
    operationId: string;
    reference: string;
  }): Promise<RailCapabilityResult<PaymentRailOperation>> {
    return this.getStatus(input);
  }

  private updateStatus(operationId: string, status: PaymentRailOperation['status']): void {
    const operation = this.operations.get(operationId);
    if (operation) this.operations.set(operationId, { ...operation, status });
  }
}
