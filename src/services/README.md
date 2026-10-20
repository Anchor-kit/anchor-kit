# Services

`LocalKeypairSigner` implements the `StellarTransactionSigner` boundary for signing Stellar
transaction XDR with a local secret seed. It exposes only a signing method; the keypair is kept
private, and transaction submission remains the application's responsibility.

Other provider and runtime orchestration services remain planned.
