export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE' | 'BNB';

export const ASSET_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
  DOGE: 'dogeusdt',
  BNB: 'bnbusdt',
};

export const SYMBOL_TO_ASSET: Record<string, Asset> = Object.fromEntries(
  (Object.entries(ASSET_SYMBOLS) as [Asset, string][]).map(([a, s]) => [s, a]),
) as Record<string, Asset>;

export const ALL_ASSETS: Asset[] = Object.keys(ASSET_SYMBOLS) as Asset[];

/** Detect the crypto asset a Polymarket question refers to, or null. */
export function assetOf(question: string): Asset | null {
  const q = question.toLowerCase();
  if (q.includes('bitcoin')) return 'BTC';
  if (q.includes('ethereum')) return 'ETH';
  if (q.includes('solana')) return 'SOL';
  if (q.includes('xrp')) return 'XRP';
  if (q.includes('dogecoin')) return 'DOGE';
  if (q.includes('bnb') || q.includes('binance coin')) return 'BNB';
  return null;
}

export function isAsset(x: string): x is Asset {
  return x in ASSET_SYMBOLS;
}
