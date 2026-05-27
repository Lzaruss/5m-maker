// src/live/reconciler.ts
export type Side = 'BUY' | 'SELL';
export interface LiveOrder { id: string; side: Side; price: number; size: number; }
export interface DesiredQuote { side: Side; price: number; size: number; }
export interface ReconcilePlan { toCancel: string[]; toPlace: DesiredQuote[]; }

/**
 * Reconcile desired quotes against currently-resting orders. `tolerance`
 * controls how close a resting price has to be to the desired price to be
 * treated as "same" — larger tolerance = less cancel/replace churn, which
 * reduces the cancel-fill race scenario (where a cancelled order fills
 * before the cancel lands and we end up with both the old and new order
 * filling). Defaults to `tick / 2` (exact-tick matching).
 */
export function reconcile(
  open: LiveOrder[],
  desired: DesiredQuote[],
  tick: number,
  tolerance: number = tick / 2,
): ReconcilePlan {
  const samePrice = (a: number, b: number) => Math.abs(a - b) < tolerance;
  const toCancel: string[] = [];
  const toPlace: DesiredQuote[] = [];

  for (const side of ['BUY', 'SELL'] as Side[]) {
    const want = desired.find((d) => d.side === side);
    const have = open.filter((o) => o.side === side);

    if (!want) {
      for (const o of have) toCancel.push(o.id);
      continue;
    }
    const match = have.find((o) => samePrice(o.price, want.price));
    if (match) {
      for (const o of have) if (o.id !== match.id) toCancel.push(o.id);
    } else {
      for (const o of have) toCancel.push(o.id);
      toPlace.push({ side, price: want.price, size: want.size });
    }
  }
  return { toCancel, toPlace };
}
