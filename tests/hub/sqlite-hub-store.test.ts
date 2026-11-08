import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { hubStoreContract } from './hub-store-contract.js';
hubStoreContract('sqlite', async () => new SqliteHubStore(':memory:', { dims: 4 }));
