# Deposit idempotency

The interactive deposit endpoint accepts an Idempotency-Key header. Keys are
scoped to the authenticated account, so the same key can be used independently
by different accounts.

The first request creates the transaction and returns 201. Repeating the same
key with the same request body returns the stored response and includes
idempotency_replay: true. The stored response is not processed again.

Reusing a key with a different request body is a conflict. The endpoint returns
409 with error idempotency_conflict. Clients must use a new key when changing
the asset or amount.

Example:

```bash
curl -s -X POST "$BASE/transactions/deposit/interactive" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: dep-001" \
  -d '{"asset_code":"USDC","amount":"25.5"}'
```
