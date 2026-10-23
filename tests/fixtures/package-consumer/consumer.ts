import { createAnchor } from 'anchor-kit';
import type { AnchorKitConfig, CreateAnchorOptions, DatabaseAdapter } from 'anchor-kit';

declare const config: Partial<AnchorKitConfig>;
declare const adapter: DatabaseAdapter;

const options: CreateAnchorOptions = { databaseAdapter: adapter };
const anchor = createAnchor(config, options);

void anchor;
