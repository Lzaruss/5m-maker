// src/live/reconciler.ts
export type Side = 'BUY' | 'SELL';
export interface LiveOrder { id: string; side: Side; price: number; size: number; }
export interface DesiredQuote { side: Side; price: number; size: number; }
export interface ReconcilePlan { toCancel: string[]; toPlace: DesiredQuote[]; }

const samePrice = (a: number, b: number, tick: number) => Math.abs(a - b) < tick / 2;

export function reconcile(open: LiveOrder[], desired: DesiredQuote[], tick: number): ReconcilePlan {
  const toCancel: string[] = [];
  const toPlace: DesiredQuote[] = [];

  for (const side of ['BUY', 'SELL'] as Side[]) {
    const want = desired.find((d) => d.side === side);
    const have = open.filter((o) => o.side === side);

    if (!want) {
      // side no longer desired -> cancel all on this side
      for (const o of have) toCancel.push(o.id);
      continue;
    }
    const match = have.find((o) => samePrice(o.price, want.price, tick));
    if (match) {
      // keep the matching order; cancel any other (stale/duplicate) orders this side
      for (const o of have) if (o.id !== match.id) toCancel.push(o.id);
    } else {
      // no order at the desired price -> cancel all this side and place fresh
      for (const o of have) toCancel.push(o.id);
      toPlace.push({ side, price: want.price, size: want.size });
    }
  }
  return { toCancel, toPlace };
}
