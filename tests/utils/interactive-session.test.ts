import { describe, expect, it } from 'vitest';
import { CryptoUtils } from '@/utils/crypto.ts';
import { createInteractiveSession, verifyInteractiveSession } from '@/utils/interactive-session.ts';

const secret = 'interactive-session-test-secret';

describe('interactive deposit sessions', () => {
  it('binds authorization to one account, transaction, and action', async () => {
    const token = await createInteractiveSession(
      { account: 'GACCOUNT', transactionId: 'deposit-1', actions: ['view', 'submit'] },
      secret,
    );

    await expect(verifyInteractiveSession(token, secret, 'deposit-1', 'submit')).resolves.toEqual({
      account: 'GACCOUNT',
      transactionId: 'deposit-1',
      actions: ['view', 'submit'],
    });
    await expect(verifyInteractiveSession(token, secret, 'deposit-2', 'submit')).rejects.toThrow(
      'Interactive session is not authorized for this action',
    );
    await expect(verifyInteractiveSession(token, secret, 'deposit-1', 'refund')).rejects.toThrow(
      'Interactive session is not authorized for this action',
    );
  });

  it('rejects an API bearer token even when signed with the same secret', async () => {
    const apiToken = await CryptoUtils.generateJwt(
      { iss: 'anchor-kit', aud: 'anchor-api', sub: 'GACCOUNT' },
      secret,
      { expiresIn: '300s' },
    );

    await expect(verifyInteractiveSession(apiToken, secret, 'deposit-1', 'submit')).rejects.toThrow(
      'Interactive session is not authorized for this action',
    );
  });

  it('rejects invalid lifetimes and empty action sets', async () => {
    await expect(
      createInteractiveSession(
        { account: 'GACCOUNT', transactionId: 'deposit-1', actions: [] },
        secret,
      ),
    ).rejects.toThrow('account, transactionId, and at least one action are required');
    await expect(
      createInteractiveSession(
        { account: 'GACCOUNT', transactionId: 'deposit-1', actions: ['view'] },
        secret,
        0,
      ),
    ).rejects.toThrow('expiresInSeconds must be a positive safe integer');
  });
});
