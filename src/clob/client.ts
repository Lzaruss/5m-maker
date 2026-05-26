import { ClobClient, type Chain } from '@polymarket/clob-client-v2';
import { Wallet } from '@ethersproject/wallet';
import { loadEnv } from '../util/config.js';
import { logger } from '../util/logger.js';

let _client: ClobClient | null = null;

export function getClobClient(): ClobClient {
  if (_client) return _client;

  const env = loadEnv();
  const signer = new Wallet(env.clobPrivateKey);

  _client = new ClobClient({
    host: env.clobHost,
    chain: env.clobChainId as Chain,
    signer,
    creds: {
      key: env.clobApiKey,
      secret: env.clobApiSecret,
      passphrase: env.clobApiPassphrase,
    },
    signatureType: env.clobSignatureType,
    funderAddress: env.clobFunderAddress,
  });

  logger.debug(
    { funder: env.clobFunderAddress, signatureType: env.clobSignatureType },
    'CLOB v2 client initialized',
  );
  return _client;
}

/**
 * Read USDC liquid balance for the proxy wallet.
 * Mirrors the working pattern from `copytrading/src/clob/positions.ts`:
 * pass `{ asset_type: "COLLATERAL" }` to `getBalanceAllowance`. Without that
 * argument the v2 SDK returns `'0'` for this wallet (the bug that produced
 * the empty balance reading in the prior run).
 */
export async function getUsdcBalance(): Promise<number> {
  const c = getClobClient();
  const result: any = await (c as any).getBalanceAllowance({ asset_type: 'COLLATERAL' });
  const raw = Number(result?.balance ?? result?.allowance ?? 0);
  return raw / 1_000_000;
}

export function resetClobClient(): void {
  _client = null;
}
