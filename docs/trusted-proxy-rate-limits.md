# Trusted proxy rate-limit configuration

Rate limiting identifies clients by their socket address by default. This is
the safe default because the address comes from the connection to the anchor.

Set framework.rateLimit.trustForwardedFor to true only when every request
reaches the application through a trusted reverse proxy that removes
untrusted client-supplied forwarding headers and writes the canonical
x-forwarded-for value. When enabled, Anchor-Kit uses the left-most address in
that header as the client key.

An untrusted client can spoof x-forwarded-for. Enabling this option without a
trusted proxy lets a client rotate rate-limit keys and bypass throttling.

Example behind a trusted proxy:

```ts
framework: {
  rateLimit: {
    trustForwardedFor: true,
  },
}
```

Keep trustForwardedFor false for direct internet traffic or when the proxy
chain is not fully controlled.
