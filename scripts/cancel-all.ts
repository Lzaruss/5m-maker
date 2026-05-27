// scripts/cancel-all.ts — panic button: cancel every open order on the account.
import { cancelAll } from '../src/clob/orders.js';
import { loadEnv, assertLiveEnv } from '../src/util/config.js';

assertLiveEnv(loadEnv()); // fail fast with a clear message if creds are missing
cancelAll().then(() => { console.log('All open orders cancelled.'); process.exit(0); });
