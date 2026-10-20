# Plugin lifecycle contract

Plugins are registered with AnchorInstance.use before initialization. Registration
is keyed by plugin id; registering the same id twice throws an error.

Call use before await anchor.init(). Initialization connects the database,
creates the queue, webhook processor, watchers, and Express middleware. After
those services exist, Anchor-Kit calls each registered plugin's init callback in
registration order. If a callback throws, initialization fails and the host
must treat the anchor as not ready.

Do not register a plugin after initialization. A late registration is not part
of the initialized lifecycle and its init callback is not replayed. Plugins can
be read after initialization with getPlugin, but the host must not use the
instance until init resolves.

The typed plugin declaration can also describe routes, schema extensions, and
lifecycle hooks. These declarations are extension metadata; a plugin should
keep its own resources and release them from host-controlled shutdown code.
Plugin init should be limited to setup that needs the initialized AnchorInstance.

Minimal typed configuration example:

```ts
import { createAnchor, type AnchorInstance, type AnchorPlugin } from 'anchor-kit';

interface AuditPluginConfig {
  auditName: string;
}

const auditPlugin: AnchorPlugin = {
  id: 'example.audit',
  name: 'Audit example',
  init: (instance) => {
    const anchor = instance as AnchorInstance;
    const pluginConfig: AuditPluginConfig = { auditName: 'local-audit' };
    console.log(pluginConfig.auditName, anchor.getPlugin('example.audit')?.id);
  },
};

const anchor = createAnchor(config);
anchor.use(auditPlugin);
await anchor.init();
```

The host owns startBackgroundJobs and shutdown. A plugin must not assume that
background workers are running when init executes.
