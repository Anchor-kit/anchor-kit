# Transaction history

`GET /transactions?asset_code=USDC` returns a SEP-24 `{ "transactions": [...] }` envelope for the authenticated bearer token's account, including its memo when present. Responses use `Cache-Control: no-store`.

Use `limit` (default 10, maximum 100), `kind` (`deposit` or `withdrawal`), and `no_older_than` (UTC ISO 8601) to filter results. The current runtime creates deposits only, so a withdrawal filter returns an empty list. Repeated, empty, or malformed filters return HTTP 400.

Results sort by creation time descending, then ID descending. Pass the last returned transaction's `id` as `paging_id` to fetch the next page, excluding that transaction. The cursor must identify a transaction owned by the authenticated account for the requested asset and kind. Unknown or foreign cursors return the same HTTP 400 response. New transactions inserted ahead of a cursor do not shift subsequent pages.

Custom database adapters implement `listTransactions(TransactionHistoryQuery)` and enforce account ownership in the query. `SqlDatabaseAdapter` validates filters and binds SQL parameters for SQLite and PostgreSQL.

Run the focused acceptance check:

```sh
bun test tests/runtime/sep24-transaction-history.test.ts tests/runtime/sep24-transaction-lookup.test.ts
```

Expected: two SQLite tests pass; two PostgreSQL tests skip without `DATABASE_URL`. Supply a disposable PostgreSQL database through `DATABASE_URL` to run all four. The history check covers equal timestamps, exclusive cursors, account/memo/asset isolation, filter validation, page limits, no-store responses, and CORS/method routing.

Wire contract: [SEP-24 transaction history](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#transaction-history).
