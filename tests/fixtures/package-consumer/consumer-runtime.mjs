import assert from 'node:assert/strict';
import { AnchorClient, AnchorClientError } from 'anchor-kit';

const calls = [];
const responses = [
  { transaction: 'challenge-xdr', network_passphrase: 'Test SDF Network ; September 2015' },
  { token: 'private-token' },
  { type: 'interactive_customer_info_needed', url: 'https://anchor.example/form', id: 'tx-1' },
  { transaction: { id: 'tx-1', status: 'pending_user_transfer_start', kind: 'deposit' } },
];
const client = new AnchorClient({
  authEndpoint: 'https://anchor.example/auth',
  transferServer: 'https://anchor.example/sep24',
  fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  },
});
assert.equal((await client.getChallenge('GACCOUNT')).transaction, 'challenge-xdr');
assert.equal((await client.exchangeChallenge('signed-xdr')).token, 'private-token');
assert.equal((await client.initiateDeposit('private-token', { asset_code: 'USDC' })).id, 'tx-1');
assert.equal(
  (await client.getTransaction('private-token', 'tx-1')).transaction.status,
  'pending_user_transfer_start',
);
assert.deepEqual(
  calls.map(({ url }) => new URL(url).pathname),
  ['/auth', '/auth', '/sep24/transactions/deposit/interactive', '/sep24/transaction'],
);
assert.ok(
  calls.every(({ url, init }) => !url.includes('private-token') && init.redirect === 'error'),
);
assert.equal(calls[2].init.headers.authorization, 'Bearer private-token');
assert.equal(calls[3].init.headers.authorization, 'Bearer private-token');
const failure = new AnchorClient({
  authEndpoint: 'https://anchor.example/auth',
  transferServer: 'https://anchor.example/sep24',
  fetch: async () => new Response('secret private-token', { status: 401 }),
});
await assert.rejects(
  () => failure.getTransaction('private-token', 'tx-1'),
  (error) =>
    error instanceof AnchorClientError &&
    error.code === 'http' &&
    error.status === 401 &&
    !error.message.includes('private-token'),
);
