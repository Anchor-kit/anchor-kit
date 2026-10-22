import { CryptoUtils } from './crypto.ts';

const INTERACTIVE_SESSION_ISSUER = 'anchor-kit';
const INTERACTIVE_SESSION_AUDIENCE = 'anchor-interactive';
const INTERACTIVE_SESSION_PURPOSE = 'deposit-session';

export interface InteractiveSessionClaims {
  account: string;
  transactionId: string;
  actions: string[];
}

/** Create a short-lived JWT scoped to one account, deposit, and action set. */
export async function createInteractiveSession(
  claims: InteractiveSessionClaims,
  secret: string,
  expiresInSeconds = 300,
): Promise<string> {
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new TypeError('expiresInSeconds must be a positive safe integer');
  }
  if (!claims.account || !claims.transactionId || claims.actions.length === 0) {
    throw new TypeError('account, transactionId, and at least one action are required');
  }

  return CryptoUtils.generateJwt(
    {
      iss: INTERACTIVE_SESSION_ISSUER,
      aud: INTERACTIVE_SESSION_AUDIENCE,
      purpose: INTERACTIVE_SESSION_PURPOSE,
      sub: claims.account,
      transaction_id: claims.transactionId,
      actions: [...new Set(claims.actions)],
    },
    secret,
    { expiresIn: `${expiresInSeconds}s` },
  );
}

/** Verify signature, purpose, transaction binding, and requested action. */
export async function verifyInteractiveSession(
  token: string,
  secret: string,
  transactionId: string,
  action: string,
): Promise<InteractiveSessionClaims> {
  const payload = await CryptoUtils.verifyJwt(token, secret);
  const actions = payload.actions;
  if (
    payload.iss !== INTERACTIVE_SESSION_ISSUER ||
    payload.aud !== INTERACTIVE_SESSION_AUDIENCE ||
    payload.purpose !== INTERACTIVE_SESSION_PURPOSE ||
    typeof payload.sub !== 'string' ||
    payload.transaction_id !== transactionId ||
    !Array.isArray(actions) ||
    !actions.every((value): value is string => typeof value === 'string') ||
    !actions.includes(action)
  ) {
    throw new Error('Interactive session is not authorized for this action');
  }

  return { account: payload.sub, transactionId, actions };
}
