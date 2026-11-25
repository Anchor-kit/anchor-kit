import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { createAnchor, type AnchorInstance } from '../src/index.ts';
import type { KycVerificationProvider } from '../src/runtime/interfaces.ts';

export interface ExampleApp {
  app: Express;
  anchor: AnchorInstance;
  shutdown: () => Promise<void>;
}

export interface ExampleAppOptions {
  kycRequired?: Record<string, string[]>;
  kycVerificationProvider?: KycVerificationProvider;
}

export function isSqliteDatabaseUrl(databaseUrl: string): boolean {
  if (databaseUrl.startsWith('sqlite:') || databaseUrl.startsWith('file:')) {
    return true;
  }

  return !/^[a-z][a-z\d+.-]*:/i.test(databaseUrl);
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

function getInteractiveCallbackOrigins(): string[] {
  const raw = process.env.INTERACTIVE_CALLBACK_ORIGINS;
  if (raw === undefined || raw.trim() === '') return [];
  const origins = [
    ...new Set(
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ];
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('INTERACTIVE_CALLBACK_ORIGINS must contain origin URLs');
    }
    const isLocalHttp =
      parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      (parsed.protocol !== 'https:' && !isLocalHttp)
    ) {
      throw new Error('INTERACTIVE_CALLBACK_ORIGINS must contain HTTPS origins');
    }
  }
  return origins;
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

export function parsePort(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue === '') {
    return 3000;
  }

  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

export async function createExampleApp(options: ExampleAppOptions = {}): Promise<ExampleApp> {
  const databaseUrl =
    process.env.DATABASE_URL ?? `file:/tmp/anchor-kit-example-${randomUUID()}.sqlite`;
  const defaultSep10SigningSecret = Keypair.random().secret();
  const interactiveCallbackOrigins = getInteractiveCallbackOrigins();

  const anchor = createAnchor(
    {
      network: { network: 'testnet' },
      server: {
        homeDomain: process.env.ANCHOR_HOME_DOMAIN ?? 'localhost',
        interactiveDomain: process.env.INTERACTIVE_DOMAIN ?? 'http://localhost:3000',
        interactiveCallbackOrigins,
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
              process.env.ASSET_ISSUER ??
              'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
          },
        ],
      },
      kycRequired: options.kycRequired,
      framework: {
        database: {
          provider: isSqliteDatabaseUrl(databaseUrl) ? 'sqlite' : 'postgres',
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
    },
    { kycVerificationProvider: options.kycVerificationProvider },
  );

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
  app.use(
    express.raw({
      limit: getMaxBodyBytes() ?? '1mb',
      type: ['application/x-www-form-urlencoded', 'multipart/form-data'],
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get('/deposit/:id', (req, res) => {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const nonce = randomUUID().replaceAll('-', '');
    const allowedOrigins = JSON.stringify(interactiveCallbackOrigins).replaceAll('<', '\\u003c');
    const safeId = JSON.stringify(id).replaceAll('<', '\\u003c');
    const frameAncestors = interactiveCallbackOrigins.length
      ? interactiveCallbackOrigins.join(' ')
      : "'none'";
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors ${frameAncestors}`,
    );
    res.type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Deposit details</title></head>
<body>
  <main>
    <h1>Deposit details</h1>
    <p id="status" role="status" aria-live="polite">Loading your transaction…</p>
    <p id="summary"></p>
    <form id="completion" hidden>
      <div id="fields"></div>
      <button type="submit">Continue</button>
    </form>
  </main>
  <script nonce="${nonce}">
  (() => {
    const allowedOrigins = ${allowedOrigins};
    const pageUrl = new URL(window.location.href);
    const token = pageUrl.searchParams.get('token');
    const callback = pageUrl.searchParams.get('callback');
    pageUrl.searchParams.delete('token');
    window.history.replaceState(null, '', pageUrl.pathname + pageUrl.search + pageUrl.hash);

    const status = document.getElementById('status');
    const summary = document.getElementById('summary');
    const form = document.getElementById('completion');
    const fields = document.getElementById('fields');
    const transactionId = ${safeId};
    const endpoint = '/anchor/interactive/deposit/' + encodeURIComponent(transactionId);

    function showError(message) {
      status.textContent = message;
      form.hidden = true;
    }

    function notifyWallet(transaction) {
      if (callback !== 'postMessage') return;
      const callbackKey = 'anchor-kit-callback-' + transactionId;
      try { if (window.sessionStorage.getItem(callbackKey) === 'sent') return; } catch {}
      let origin;
      try { origin = new URL(document.referrer).origin; } catch { return; }
      if (!allowedOrigins.includes(origin)) return;
      const recipient = window.opener || (window.parent !== window ? window.parent : null);
      if (!recipient) return;
      recipient.postMessage({ transaction }, origin);
      try { window.sessionStorage.setItem(callbackKey, 'sent'); } catch {}
    }

    async function loadState() {
      if (!token) return showError('This deposit link has expired. Return to your wallet and start again.');
      try {
        const response = await fetch(endpoint, {
          headers: { Authorization: 'Bearer ' + token },
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer'
        });
        const state = await response.json();
        if (!response.ok) return showError(state.message || 'This deposit link is unavailable.');
        summary.textContent = state.transaction.amount + ' ' + state.transaction.asset_code;
        if (state.transaction.status !== 'incomplete') {
          status.textContent = 'Your information has been sent. Return to your wallet for updates.';
          notifyWallet(state.transaction);
          return;
        }
        if (state.kyc_verified) {
          status.textContent = 'Your identity is verified. Continue to return to your wallet.';
        } else if (state.missing_fields.length === 0 && state.required_fields.length > 0) {
          status.textContent = state.kyc_status === 'rejected'
            ? 'Your information could not be verified. Contact the anchor.'
            : 'Your information is waiting for review.';
          return;
        } else if (state.required_fields.length === 0) {
          status.textContent = 'Continue to send this deposit request back to your wallet.';
        } else {
          status.textContent = 'Enter the requested information to continue.';
        }
        for (const name of state.missing_fields) {
          const label = document.createElement('label');
          label.textContent = name.replaceAll('_', ' ');
          label.htmlFor = 'field-' + name;
          const input = document.createElement('input');
          input.id = label.htmlFor;
          input.name = name;
          input.autocomplete = 'off';
          input.required = true;
          fields.append(label, input, document.createElement('br'));
        }
        form.hidden = false;
      } catch {
        showError('Could not load this deposit. Check your connection and try again.');
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      status.textContent = 'Sending your information…';
      const values = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await fetch(endpoint + '/complete', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: values, callback: callback || undefined }),
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer'
        });
        const result = await response.json();
        if (!response.ok && response.status !== 202) {
          status.textContent = result.message || 'Check the requested fields and try again.';
          button.disabled = false;
          return;
        }
        status.textContent = result.kyc_status === 'rejected'
          ? 'Your information could not be verified. Contact the anchor.'
          : result.kyc_status === 'pending'
            ? 'Your information is waiting for review.'
            : result.kyc_verified
          ? 'Your information is verified. Return to your wallet.'
          : 'Your information has been sent. Return to your wallet for updates.';
        form.hidden = true;
        notifyWallet(result.transaction);
      } catch {
        status.textContent = 'Could not send your information. Check your connection and try again.';
        button.disabled = false;
      }
    });

    loadState();
  })();
  </script>
</body>
</html>`);
  });

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
  const port = parsePort(process.env.PORT);

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
