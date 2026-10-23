import type {
  DatabaseAdapter,
  InteractiveSessionRecord,
  InteractiveSessionRejection,
} from '@/runtime/interfaces.ts';
import type { IncomingMessage } from 'node:http';
import { isInteractiveSessionExpired } from '../../utils/interactive-session.ts';

/**
 * Request header carrying the interactive session id issued with the
 * `interactive_url`.
 *
 * The hosted flow only receives a transaction id in its URL, so the session id
 * travels out-of-band as a header instead of being appended to the URL where it
 * would leak through referrers, logs and browser history.
 */
export const INTERACTIVE_SESSION_HEADER = 'x-interactive-session';

export type InteractiveSessionGateResult =
  | { ok: true; session: InteractiveSessionRecord | null }
  | { ok: false; reason: InteractiveSessionRejection };

/**
 * Reads the single interactive session id from the request headers.
 *
 * Mirrors `readBearerToken`: a missing, empty, or ambiguous (multi-valued)
 * header resolves to `null`, which callers treat as absent rather than as a
 * session they can trust.
 */
export function readInteractiveSessionId(req: IncomingMessage): string | null {
  const header = req.headers[INTERACTIVE_SESSION_HEADER];
  const values = Array.isArray(header) ? header : [header];
  const present = values.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  return present.length === 1 ? present[0].trim() : null;
}

/**
 * Pure verdict for one session against one requested action.
 *
 * Checks run in a fixed order: identity binding first, then revocation and
 * expiry, then the action set. Binding is evaluated before state so a caller
 * that does not own the session cannot learn whether it has been revoked or
 * has expired. Every rejection happens before any write, because callers only
 * call this to decide whether the write may proceed.
 */
export function evaluateInteractiveSession(input: {
  session: InteractiveSessionRecord | null;
  account: string;
  transactionId: string;
  action: string;
  nowMs?: number;
}): { ok: true } | { ok: false; reason: InteractiveSessionRejection } {
  const { session } = input;
  if (!session) return { ok: false, reason: 'session_not_found' };
  if (session.account !== input.account) return { ok: false, reason: 'wrong_account' };
  if (session.transactionId !== input.transactionId) {
    return { ok: false, reason: 'wrong_transaction' };
  }
  if (session.revokedAt !== null) return { ok: false, reason: 'session_revoked' };
  if (isInteractiveSessionExpired(session.expiresAt, input.nowMs)) {
    return { ok: false, reason: 'session_expired' };
  }
  if (!session.actions.includes(input.action)) {
    return { ok: false, reason: 'action_not_permitted' };
  }
  if (session.consumedActions.includes(input.action)) {
    return { ok: false, reason: 'action_already_consumed' };
  }

  return { ok: true };
}

/**
 * Shared gate for interactive endpoints: read the session id, load the
 * persisted session, and evaluate it against the caller's account, the
 * transaction under discussion, and the action being attempted.
 *
 * This is the single place interactive endpoints decide whether an action may
 * proceed, so every state-changing endpoint rejects the same set of
 * expired, revoked, wrong-account, and wrong-transaction sessions.
 *
 * When `required` is false an absent header passes with a `null` session,
 * which lets endpoints that legitimately accept unauthenticated first-time
 * requests opt in without weakening the checks for sessions that are present.
 */
export async function gateInteractiveSession(input: {
  database: DatabaseAdapter;
  req: IncomingMessage;
  account: string;
  transactionId: string;
  action: string;
  required: boolean;
  nowMs?: number;
}): Promise<
  | { ok: true; session: InteractiveSessionRecord | null }
  | { ok: false; reason: InteractiveSessionRejection }
> {
  const sessionId = readInteractiveSessionId(input.req);
  if (sessionId === null) {
    if (!input.required) return { ok: true, session: null };
    return { ok: false, reason: 'missing_session' };
  }

  const session = await input.database.getInteractiveSessionById(sessionId);
  const verdict = evaluateInteractiveSession({
    session,
    account: input.account,
    transactionId: input.transactionId,
    action: input.action,
    nowMs: input.nowMs,
  });

  return verdict.ok ? { ok: true, session } : verdict;
}

/**
 * Maps a rejection to the HTTP contract reported to the caller.
 *
 * Ownership and action failures are 403 so they are distinguishable from an
 * unusable session (401), and a replayed completion is 409 because the first
 * consumption already succeeded.
 */
export function interactiveSessionRejection(reason: InteractiveSessionRejection): {
  status: number;
  error: string;
  message: string;
} {
  switch (reason) {
    case 'missing_session':
      return {
        status: 401,
        error: 'interactive_session_required',
        message: 'Interactive session is required',
      };
    case 'session_not_found':
      return {
        status: 401,
        error: 'interactive_session_invalid',
        message: 'Interactive session not found',
      };
    case 'session_expired':
      return {
        status: 401,
        error: 'interactive_session_expired',
        message: 'Interactive session has expired',
      };
    case 'session_revoked':
      return {
        status: 401,
        error: 'interactive_session_revoked',
        message: 'Interactive session has been revoked',
      };
    case 'wrong_account':
      return {
        status: 403,
        error: 'forbidden',
        message: 'Interactive session belongs to another account',
      };
    case 'wrong_transaction':
      return {
        status: 403,
        error: 'forbidden',
        message: 'Interactive session is bound to a different transaction',
      };
    case 'action_not_permitted':
      return {
        status: 403,
        error: 'interactive_session_forbidden',
        message: 'Interactive session is not authorized for this action',
      };
    case 'action_already_consumed':
      return {
        status: 409,
        error: 'interactive_session_consumed',
        message: 'Interactive session action has already been consumed',
      };
  }
}
