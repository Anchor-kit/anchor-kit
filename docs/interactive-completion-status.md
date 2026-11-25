# Interactive completion status

The SDK does not yet expose an idempotent interactive completion endpoint. The session gate proposed in [#791](https://github.com/Anchor-kit/anchor-kit/pull/791) consumes a completion action once and rejects a replay. The completion requirement in [#730](https://github.com/Anchor-kit/anchor-kit/issues/730) also requires a matching replay to return the first result.

The implementation needs to bind a request to the authorized account, transaction, and submitted fields; persist the result together with the state transition; return the stored result for a matching replay; and reject a conflicting or unauthorized request without creating another operation. It must not place submitted customer data in logs.

An open design question is how a matching replay should retrieve its stored result after the one-use action is consumed while an expired or revoked session remains unable to retrieve it.

The existing token-scope checks can be run with:

```sh
bun test tests/utils/interactive-session.test.ts
```

Expected result: 3 tests pass. These tests cover session claims, not endpoint authorization, persistence, or replay.
