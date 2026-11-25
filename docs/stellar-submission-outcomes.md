# Handling Stellar submission outcomes

Use the persisted transaction hash to investigate a submission before preparing another transaction. A request timeout or lost response does not show whether Stellar accepted the transaction.

## Confirmed failure

A confirmed failure means the network returned a transaction result for the submitted hash and that result is final. Record the hash and result, then use the result details to identify the cause. Correct the underlying problem before creating a new transaction. Keep the failed hash available for support and reconciliation.

## Ambiguous outcome

An ambiguous outcome occurs when the submission request may have reached the network but the client did not receive a definitive response, such as after a timeout or connection loss.

1. Look up the persisted transaction hash on the same Stellar network that received the submission.
2. If the transaction is found, inspect its result and follow the confirmed-failure or confirmed-success path.
3. If the lookup does not find the transaction, retain the original hash and continue reconciliation. A missing result from one lookup is not proof that the submission failed.
4. Do not immediately sign and submit a replacement. First establish that the original transaction cannot still be accepted or included.

Automated recovery by querying the persisted hash is planned in [#758](https://github.com/Anchor-kit/anchor-kit/issues/758). Until that work is implemented, operators must perform the lookup and reconciliation manually; the SDK does not automatically resolve ambiguous submissions.
