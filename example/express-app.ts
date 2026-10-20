import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { createAnchor, type AnchorInstance } from '../src/index.ts';

export interface ExampleApp {
  app: Express;
  anchor: AnchorInstance;
  shutdown: () => Promise<void>;
}

function getChallengeExpirationSeconds(): number {
  const rawValue = process.env.CHALLENGE_EXPIRATION_SECONDS;

  if (!rawValue) {
    return 300;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 300;
  }

  return parsedValue;
}

function getWatchersEnabled(): boolean {
  return process.env.WATCHERS_ENABLED !== 'false';
}

function getMaxBodyBytes(): number | undefined {
  const rawValue = process.env.MAX_BODY_BYTES;

  if (!rawValue) {
    return undefined;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return undefined;
  }

  return parsedValue;
}

function getAuthTokenLifetimeSeconds(): number | undefined {
  const rawValue = process.env.AUTH_TOKEN_LIFETIME_SECONDS;

  if (!rawValue) {
    return undefined;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return undefined;
  }

  return parsedValue;
}

export async function createExampleApp(): Promise<ExampleApp> {
  const databaseUrl =
    process.env.DATABASE_URL ?? `file:/tmp/anchor-kit-example-${randomUUID()}.sqlite`;
  const defaultSep10SigningSecret = Keypair.random().secret();

  const anchor = createAnchor({
    network: { network: 'testnet' },
    server: {
      homeDomain: process.env.ANCHOR_HOME_DOMAIN ?? 'localhost',
      interactiveDomain: process.env.INTERACTIVE_DOMAIN ?? 'http://localhost:3000',
    },
    security: {
      sep10SigningKey: process.env.SEP10_SIGNING_KEY ?? defaultSep10SigningSecret,
      interactiveJwtSecret: process.env.INTERACTIVE_JWT_SECRET ?? 'example-jwt-secret',
      distributionAccountSecret:
        process.env.DISTRIBUTION_ACCOUNT_SECRET ?? 'example-distribution-secret',
      webhookSecret: process.env.WEBHOOK_SECRET,
      verifyWebhookSignatures: process.env.WEBHOOK_SECRET ? true : false,
      challengeExpirationSeconds: getChallengeExpirationSeconds(),
      authTokenLifetimeSeconds: getAuthTokenLifetimeSeconds(),
    },
    assets: {
      assets: [
        {
          code: process.env.ASSET_CODE ?? 'USDC',
          issuer:
            process.env.ASSET_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          deposits_enabled: true,
        },
      ],
    },
    framework: {
      database: {
        provider: databaseUrl.startsWith('file:') ? 'sqlite' : 'postgres',
        url: databaseUrl,
      },
      http: {
        maxBodyBytes: getMaxBodyBytes(),
      },
      queue: {
        backend: 'memory',
        concurrency: 2,
      },
      watchers: {
        enabled: getWatchersEnabled(),
        pollIntervalMs: 15000,
        transactionTimeoutMs: 300000,
      },
    },
    webhooks: {
      onEvent: async (event) => {
        if (process.env.DEBUG_WEBHOOKS === '1') {
          console.log('Webhook event received', event.eventId);
        }
      },
    },
  });

  await anchor.init();
  await anchor.startBackgroundJobs();

  const app = express();
  app.use(
    express.json({
      limit: getMaxBodyBytes() ?? '1mb',
      verify: (req, _res, buf) => {
        (req as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.use('/anchor', anchor.getExpressRouter());

  return {
    app,
    anchor,
    shutdown: async () => {
      await anchor.stopBackgroundJobs();
      await anchor.shutdown();
    },
  };
}

if (import.meta.main) {
  const portRaw = process.env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('PORT must be a positive number');
  }

  const { app, shutdown } = await createExampleApp();
  const server = app.listen(port, () => {
    console.log(`Example app listening on http://localhost:${port}`);
  });

  const close = async (): Promise<void> => {
    await shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  process.on('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });
}
