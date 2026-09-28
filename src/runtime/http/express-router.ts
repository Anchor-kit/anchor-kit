import type { AnchorConfig } from '@/core/config.ts';
import { InMemoryRateLimiter, type RateLimitRule } from '@/runtime/http/rate-limiter.ts';
import type { DatabaseAdapter, WebhookProcessor } from '@/runtime/interfaces.ts';
import { Keypair } from '@stellar/stellar-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleExpressRouterRequest, type ExpressRouterContext } from './express-router-impl.ts';

export type ExpressLikeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
) => void;

interface RouterDependencies {
  config: AnchorConfig;
  database: DatabaseAdapter;
  webhookProcessor: WebhookProcessor;
}

export class AnchorExpressRouter {
  private readonly context: ExpressRouterContext;

  constructor(dependencies: RouterDependencies) {
    const config = dependencies.config;
    const sep10ServerKeypair = Keypair.fromSecret(config.get('security').sep10SigningKey);
    const networkPassphrase = config.get('network').networkPassphrase ?? '';
    const maxBodyBytes = config.get('framework').http?.maxBodyBytes ?? 1024 * 1024;
    const rateLimitConfig = config.get('framework').rateLimit;
    const windowMs = rateLimitConfig?.windowMs ?? 60000;
    const rateRules: Record<
      'auth_challenge' | 'auth_token' | 'webhook' | 'deposit',
      RateLimitRule
    > = {
      auth_challenge: { windowMs, max: rateLimitConfig?.authChallengeMax ?? 30 },
      auth_token: { windowMs, max: rateLimitConfig?.authTokenMax ?? 30 },
      webhook: { windowMs, max: rateLimitConfig?.webhookMax ?? 120 },
      deposit: { windowMs, max: rateLimitConfig?.depositMax ?? 60 },
    };

    this.context = {
      config,
      database: dependencies.database,
      webhookProcessor: dependencies.webhookProcessor,
      sep10ServerKeypair,
      networkPassphrase,
      maxBodyBytes,
      rateLimiter: new InMemoryRateLimiter(),
      rateRules,
    };
  }

  public getMiddleware(): ExpressLikeMiddleware {
    return (req, res, next) => {
      void handleExpressRouterRequest(this.context, req, res).catch((error: unknown) => {
        if (next) {
          next(error);
          return;
        }

        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
        }
        res.end(
          JSON.stringify({
            error: 'internal_server_error',
            message: 'Internal server error',
          }),
        );
      });
    };
  }
}
