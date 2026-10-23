import { hasSufficientSignerWeight } from '@/runtime/http/express-router-impl.ts';
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

function makeChallenge(signers: Keypair[]) {
  const source = Keypair.random();
  const transaction = new TransactionBuilder(new Account(source.publicKey(), '0'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({ name: 'test auth', value: 'nonce', source: source.publicKey() }),
    )
    .setTimeout(60)
    .build();
  transaction.sign(...signers);
  return transaction;
}

describe('SEP-10 signer weight verification', () => {
  it('accepts valid unique authorized signatures that meet the threshold', () => {
    const first = Keypair.random();
    const second = Keypair.random();
    const transaction = makeChallenge([first, second]);

    expect(
      hasSufficientSignerWeight(
        transaction,
        [
          { publicKey: first.publicKey(), weight: 1 },
          { publicKey: second.publicKey(), weight: 2 },
        ],
        3,
      ),
    ).toBe(true);
  });

  it('rejects insufficient weight and duplicate signer entries', () => {
    const signer = Keypair.random();
    const transaction = makeChallenge([signer]);

    expect(
      hasSufficientSignerWeight(transaction, [{ publicKey: signer.publicKey(), weight: 1 }], 2),
    ).toBe(false);
    expect(
      hasSufficientSignerWeight(
        transaction,
        [
          { publicKey: signer.publicKey(), weight: 1 },
          { publicKey: signer.publicKey(), weight: 2 },
        ],
        2,
      ),
    ).toBe(false);
  });

  it('rejects duplicate signatures and signatures from unauthorized signers', () => {
    const authorized = Keypair.random();
    const unauthorized = Keypair.random();
    const duplicate = makeChallenge([authorized]);
    duplicate.signatures.push(duplicate.signatures[0]!);
    const outsider = makeChallenge([unauthorized]);
    const signers = [{ publicKey: authorized.publicKey(), weight: 1 }];

    expect(hasSufficientSignerWeight(duplicate, signers, 2)).toBe(false);
    expect(hasSufficientSignerWeight(outsider, signers, 1)).toBe(false);
  });
});
