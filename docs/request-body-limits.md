# Request body limits

Align the reverse proxy, Express parser, and Anchor-Kit byte limit. The smallest configured limit rejects a request first, so mismatched limits can produce different responses depending on which layer receives the body.

This fictional Nginx and Express setup accepts bodies up to 1 MiB:

```nginx
server {
    listen 443 ssl;
    server_name anchor.example.test;

    client_max_body_size 1m;

    location /anchor/ {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

```ts
import express from 'express';
import { createAnchor } from 'anchor-kit';

const app = express();
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);

const anchor = createAnchor({
  // Other Anchor-Kit options omitted.
  framework: {
    http: { maxBodyBytes: 1024 * 1024 },
  },
});

app.use('/anchor', anchor.getExpressRouter());
```

Keep the three limits aligned when changing the allowed payload size. Nginx's `client_max_body_size`, Express's JSON parser `limit`, and `framework.http.maxBodyBytes` should represent the same byte budget. The SDK default is 1,048,576 bytes when `maxBodyBytes` is omitted.

The first layer whose limit is exceeded rejects the request. Nginx can return its own HTTP 413 before forwarding the body. If Express rejects it, Express body-parser reports an oversized entity with HTTP 413 before the Anchor router runs. If the body passes those limits but exceeds Anchor-Kit's limit, the SDK responds with HTTP 413 and JSON `{ "error": "payload_too_large" }`.

The `verify` hook copies the original JSON bytes into `req.rawBody`. Keep those bytes unchanged for webhook signature verification; do not parse and serialize the body again before Anchor-Kit receives it. This preserves the exact byte sequence that the provider signed.
