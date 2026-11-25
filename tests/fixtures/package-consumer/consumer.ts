import { AnchorClient, createAnchor } from 'anchor-kit';
import type { AnchorKitConfig, CreateAnchorOptions, DatabaseAdapter } from 'anchor-kit';

declare const config: Partial<AnchorKitConfig>;
declare const adapter: DatabaseAdapter;

const options: CreateAnchorOptions = { databaseAdapter: adapter };
const anchor = createAnchor(config, options);

void anchor;

const client = new AnchorClient({
  authEndpoint: 'https://anchor.example/auth',
  transferServer: 'https://anchor.example/sep24',
});
void client;
