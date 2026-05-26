// scripts/cancel-all.ts — panic button: cancel every open order on the account.
import { cancelAll } from '../src/clob/orders.js';
cancelAll().then(() => { console.log('All open orders cancelled.'); process.exit(0); });
