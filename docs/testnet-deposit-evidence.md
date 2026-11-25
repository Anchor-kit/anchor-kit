# Testnet deposit evidence

The installed-SDK mock-rail deposit demonstration is not yet available. The current example uses an in-memory queue and does not prove a confirmed Stellar settlement or recovery after a worker restart.

## Package preflight

Run this from the repository root:

```sh
bun install --frozen-lockfile
bun run check:package-consumer
```

Expected result: the clean external TypeScript consumer resolves `createAnchor` and public types from the packed SDK. This is a package check; it does not initiate a deposit or contact testnet.

## Remaining work

The demonstration needs a wallet interoperability check ([#742](https://github.com/Anchor-kit/anchor-kit/issues/742)), an interactive host page ([#745](https://github.com/Anchor-kit/anchor-kit/issues/745)), a mock rail lifecycle ([#721](https://github.com/Anchor-kit/anchor-kit/issues/721)), settlement confirmation ([#756](https://github.com/Anchor-kit/anchor-kit/issues/756)), atomic enqueue ([#757](https://github.com/Anchor-kit/anchor-kit/issues/757)), ambiguous-submission recovery ([#758](https://github.com/Anchor-kit/anchor-kit/issues/758)), a durable-worker deployment ([#736](https://github.com/Anchor-kit/anchor-kit/issues/736)), and a wallet session helper ([#753](https://github.com/Anchor-kit/anchor-kit/issues/753)). Release CI package coverage is tracked in [#694](https://github.com/Anchor-kit/anchor-kit/issues/694).

Once those pieces are available, record the confirmed testnet transaction hash and the recipient's balance before and after settlement. Repeat delivery of the same rail event and restart the worker; verify that the final lookup still shows one settlement. Keep seeds, authentication tokens, customer data, and other credentials out of the recorded evidence.
