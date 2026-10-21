# Web Authentication endpoint compatibility

The router exposes the standard JSON endpoint shape:

1. `GET /auth?account=<stellar-public-key>` returns the challenge XDR in `transaction` and includes
   `network_passphrase`, `expires_at`, and `expires_in`.
2. Sign the returned transaction and send `POST /auth` with JSON
   `{ "transaction": "<signed transaction XDR>" }`.
3. A successful response includes `token`, `account`, `expires_in`, `expires_at`, and
   `token_type: "Bearer"`.

The POST handler derives the account from the nonce operation in the signed transaction; callers
do not need to send a separate account field.

The existing custom routes remain supported for compatibility:

- `GET /auth/challenge?account=...` returns the XDR as `challenge`.
- `POST /auth/token` continues to accept `{ "account": "...", "challenge": "..." }`.

Both forms use the same single-use challenge records, rate limits, signature checks, and token
response. New clients should use `/auth` and the `transaction` field.

Focused verification:

```bash
bun test tests/runtime/auth-standard-endpoint.test.ts
```

Expected result: the standard GET-then-POST flow succeeds using `transaction`, and both legacy
routes remain covered and pass.
