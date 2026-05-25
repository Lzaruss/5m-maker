/**
 * Tape explorer — pure data study, NO strategy simulation.
 *
 * Reads recorded tape(s) and reports the facts that should drive the plan,
 * especially the rewards-vs-spread question:
 *   - real book spread per asset (how much spread capture is even possible)
 *   - competing liquidity inside the reward band (drives our reward share)
 *   - within-window dynamics by time-to-resolve (where volume & risk concentrate)
 *   - trade flow (size distribution, fraction >= reward min size)
 *   - outcome balance (Up vs Down)
 *
 * Streaming + bounded memory, so it handles long multi-day tapes.
 *
 *   npm run analyze                       # all tapes in data/
 *   npm run analyze -- data/tape-X.jsonl  # a specific tape
 */
import { readdirSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Seconds-to-resolve buckets across a 5-minute (300s) window.
const BUCKETS = [
  { label: 'T-300..240', lo: 240, hi: 300 },
  { label: 'T-240..180', lo: 180, hi: 240 },
  { label: 'T-180..120', lo: 120, hi: 180 },
  { label: 'T-120..60', lo: 60, hi: 120 },
  { label: 'T-60..20', lo: 20, hi: 60 },
  { label: 'T-20..0', lo: 0, hi: 20 },
];
function bucketOf(sec: number): number {
  for (let i = 0; i < BUCKETS.length; i++) if (sec >= BUCKETS[i].lo && sec < BUCKETS[i].hi) return i;
  return -1;
}

interface Meta {
  asset: string;
  resolvesAt: number;
  rewardsMaxSpread: number | null;
  rewardsMinSize: number | null;
}

interface Agg {
  bookSamples: number;
  spreadCentSum: number; // sum of (ask-bid)*100
  bandBidSum: number; // competing bid shares within reward band
  bandAskSum: number; // competing ask shares within reward band
  bandSamples: number;
  trades: number;
  tradeShares: number;
  tradeNotional: number;
}
function emptyAgg(): Agg {
  return {
    bookSamples: 0,
    spreadCentSum: 0,
    bandBidSum: 0,
    bandAskSum: 0,
    bandSamples: 0,
    trades: 0,
    tradeShares: 0,
    tradeNotional: 0,
  };
}

function allTapes(): string[] {
  const dir = resolve('data');
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl'))
    .sort();
  if (files.length === 0) throw new Error('No tape-*.jsonl in data/. Run `npm run record` first.');
  return files.map((f) => resolve(dir, f));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const paths = args.length ? args.map((a) => resolve(a)) : allTapes();

  const meta = new Map<string, Meta>();
  const byAsset = new Map<string, Agg>();
  const byBucket: Agg[] = BUCKETS.map(emptyAgg);
  const spreadHist = new Map<number, number>(); // cents -> count
  const assetSpreadHist = new Map<string, Map<number, number>>(); // asset -> cents -> count
  const tradeSizeHist = new Map<string, number>(); // bucket -> count
  const perWindowTrades = new Map<string, number>();
  const assetWindows = new Map<string, Set<string>>();

  let books = 0;
  let trades = 0;
  let resolutions = 0;
  let upWon = 0;
  let downWon = 0;
  let tradesGteMin = 0;
  let tradesWithMinKnown = 0;
  let minTs = Infinity;
  let maxTs = 0;
  const rewardSpreads = new Set<number>();
  const rewardMinSizes = new Set<number>();

  const aggFor = (m: Map<string, Agg>, k: string) => {
    let a = m.get(k);
    if (!a) {
      a = emptyAgg();
      m.set(k, a);
    }
    return a;
  };

  for (const path of paths) {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      const s = line.trim();
      if (!s) continue;
      let e: any;
      try {
        e = JSON.parse(s);
      } catch {
        continue;
      }
      if (e.ts) {
        if (e.ts < minTs) minTs = e.ts;
        if (e.ts > maxTs) maxTs = e.ts;
      }

      if (e.t === 'market') {
        meta.set(e.tokenId, {
          asset: e.asset ?? '?',
          resolvesAt: e.resolvesAt ?? 0,
          rewardsMaxSpread: e.rewardsMaxSpread ?? null,
          rewardsMinSize: e.rewardsMinSize ?? null,
        });
        if (typeof e.rewardsMaxSpread === 'number') rewardSpreads.add(e.rewardsMaxSpread);
        if (typeof e.rewardsMinSize === 'number') rewardMinSizes.add(e.rewardsMinSize);
        continue;
      }
      if (e.t === 'resolution') {
        resolutions++;
        if (e.yesWon === true) upWon++;
        else if (e.yesWon === false) downWon++;
        continue;
      }

      const m = meta.get(e.tokenId);
      if (!m || m.resolvesAt <= 0) continue;
      const sec = (m.resolvesAt - e.ts) / 1000;
      if (sec < 0 || sec > 300) continue;
      const bi = bucketOf(sec);

      if (e.t === 'book') {
        const bid = e.bid ?? (Array.isArray(e.bids) && e.bids[0] ? e.bids[0][0] : null);
        const ask = e.ask ?? (Array.isArray(e.asks) && e.asks[0] ? e.asks[0][0] : null);
        if (!(bid > 0) || !(ask > 0) || ask <= bid) continue;
        books++;
        const spreadCent = (ask - bid) * 100;
        const mid = (bid + ask) / 2;
        const aA = aggFor(byAsset, m.asset);
        aA.bookSamples++;
        aA.spreadCentSum += spreadCent;
        if (bi >= 0) {
          byBucket[bi].bookSamples++;
          byBucket[bi].spreadCentSum += spreadCent;
        }
        spreadHist.set(Math.round(spreadCent), (spreadHist.get(Math.round(spreadCent)) ?? 0) + 1);
        let ash = assetSpreadHist.get(m.asset);
        if (!ash) {
          ash = new Map();
          assetSpreadHist.set(m.asset, ash);
        }
        ash.set(Math.round(spreadCent), (ash.get(Math.round(spreadCent)) ?? 0) + 1);

        // Competing liquidity within the reward band (needs depth + reward param).
        if (Array.isArray(e.bids) && Array.isArray(e.asks) && m.rewardsMaxSpread) {
          const band = m.rewardsMaxSpread / 100;
          let bidSh = 0;
          let askSh = 0;
          for (const [p, sz] of e.bids) if (p >= mid - band) bidSh += sz;
          for (const [p, sz] of e.asks) if (p <= mid + band) askSh += sz;
          aA.bandBidSum += bidSh;
          aA.bandAskSum += askSh;
          aA.bandSamples++;
          if (bi >= 0) {
            byBucket[bi].bandBidSum += bidSh;
            byBucket[bi].bandAskSum += askSh;
            byBucket[bi].bandSamples++;
          }
        }
        continue;
      }

      if (e.t === 'trade') {
        const p = e.price ?? 0;
        const sz = e.size ?? 0;
        if (p <= 0 || sz <= 0) continue;
        trades++;
        const aA = aggFor(byAsset, m.asset);
        aA.trades++;
        aA.tradeShares += sz;
        aA.tradeNotional += p * sz;
        if (bi >= 0) {
          byBucket[bi].trades++;
          byBucket[bi].tradeShares += sz;
          byBucket[bi].tradeNotional += p * sz;
        }
        perWindowTrades.set(e.tokenId, (perWindowTrades.get(e.tokenId) ?? 0) + 1);
        if (!assetWindows.has(m.asset)) assetWindows.set(m.asset, new Set());
        assetWindows.get(m.asset)!.add(e.tokenId);
        const szb = sz < 5 ? '<5' : sz < 20 ? '5-20' : sz < 50 ? '20-50' : sz < 100 ? '50-100' : '100+';
        tradeSizeHist.set(szb, (tradeSizeHist.get(szb) ?? 0) + 1);
        if (m.rewardsMinSize) {
          tradesWithMinKnown++;
          if (sz >= m.rewardsMinSize) tradesGteMin++;
        }
        continue;
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const hrs = (maxTs - minTs) / 3_600_000;
  console.log(`\n========== TAPE STUDY (no simulation) ==========`);
  console.log(`tapes        : ${paths.length}`);
  console.log(`span         : ${fmtTs(minTs)} -> ${fmtTs(maxTs)}  (${hrs.toFixed(1)}h)`);
  console.log(`markets seen : ${meta.size}   books: ${books}   trades: ${trades}`);
  console.log(`resolutions  : ${resolutions}  (Up ${upWon} / Down ${downWon}` +
    `${resolutions ? `, ${((100 * upWon) / (upWon + downWon || 1)).toFixed(0)}% Up` : ''})`);
  console.log(`reward config: maxSpread ${[...rewardSpreads].join('/') || '?'}c  minSize ${[...rewardMinSizes].join('/') || '?'} sh`);
  if (tradesWithMinKnown)
    console.log(`trades >= reward minSize: ${tradesGteMin}/${tradesWithMinKnown} (${pct(tradesGteMin, tradesWithMinKnown)})`);

  console.log(`\n-- Real spread (cents) & reward-band depth by asset --`);
  console.log(
    `  ${'asset'.padEnd(6)}${'medSpread'.padStart(10)}${'p90Spread'.padStart(10)}${'avgSpread'.padStart(10)}` +
      `${'bandBid(sh)'.padStart(12)}${'bandAsk(sh)'.padStart(12)}${'trades'.padStart(8)}${'vol(sh)'.padStart(10)}`,
  );
  for (const [asset, a] of [...byAsset.entries()].sort()) {
    const avgSpread = a.bookSamples ? a.spreadCentSum / a.bookSamples : 0;
    const bb = a.bandSamples ? a.bandBidSum / a.bandSamples : 0;
    const ba = a.bandSamples ? a.bandAskSum / a.bandSamples : 0;
    const ash = assetSpreadHist.get(asset);
    const med = ash ? percentile(ash, 0.5) : 0;
    const p90 = ash ? percentile(ash, 0.9) : 0;
    console.log(
      `  ${asset.padEnd(6)}${med.toFixed(0).padStart(10)}${p90.toFixed(0).padStart(10)}${avgSpread.toFixed(2).padStart(10)}` +
        `${bb.toFixed(0).padStart(12)}${ba.toFixed(0).padStart(12)}${String(a.trades).padStart(8)}${a.tradeShares.toFixed(0).padStart(10)}`,
    );
  }
  console.log(`  (avg is skewed high by extreme one-sided books near resolution; median is the typical spread)`);

  console.log(`\n-- Reward-share estimate with a 50-share quote (50/(50+avg competing band depth)) --`);
  for (const [asset, a] of [...byAsset.entries()].sort()) {
    if (!a.bandSamples) continue;
    const bb = a.bandBidSum / a.bandSamples;
    const ba = a.bandAskSum / a.bandSamples;
    console.log(
      `  ${asset.padEnd(6)} bid-side ~${pct(50, 50 + bb)}   ask-side ~${pct(50, 50 + ba)}` +
        `   (competing bid ${bb.toFixed(0)}sh / ask ${ba.toFixed(0)}sh)`,
    );
  }

  console.log(`\n-- Within-window dynamics by time-to-resolve --`);
  console.log(`  ${'bucket'.padEnd(12)}${'avgSpread(c)'.padStart(12)}${'bandDepth(sh)'.padStart(14)}${'trades'.padStart(8)}${'vol(sh)'.padStart(10)}`);
  for (let i = 0; i < BUCKETS.length; i++) {
    const a = byBucket[i];
    const avgSpread = a.bookSamples ? a.spreadCentSum / a.bookSamples : 0;
    const band = a.bandSamples ? (a.bandBidSum + a.bandAskSum) / a.bandSamples : 0;
    console.log(
      `  ${BUCKETS[i].label.padEnd(12)}${avgSpread.toFixed(2).padStart(12)}${band.toFixed(0).padStart(14)}` +
        `${String(a.trades).padStart(8)}${a.tradeShares.toFixed(0).padStart(10)}`,
    );
  }

  console.log(`\n-- Spread distribution (cents, all assets) --`);
  for (const c of [...spreadHist.keys()].sort((x, y) => x - y)) {
    const n = spreadHist.get(c)!;
    const bar = '#'.repeat(Math.round((40 * n) / books));
    console.log(`  ${String(c).padStart(3)}c ${String(n).padStart(8)}  ${bar}`);
  }

  console.log(`\n-- Trade size distribution --`);
  for (const k of ['<5', '5-20', '20-50', '50-100', '100+']) {
    const n = tradeSizeHist.get(k) ?? 0;
    console.log(`  ${k.padEnd(8)} ${String(n).padStart(8)} (${pct(n, trades)})`);
  }

  // Trades-per-window distribution.
  const counts = [...perWindowTrades.values()].sort((a, b) => a - b);
  if (counts.length) {
    const med = counts[Math.floor(counts.length / 2)];
    const mean = counts.reduce((s, x) => s + x, 0) / counts.length;
    console.log(`\n-- Trades per window --  windows-with-trades ${counts.length}, mean ${mean.toFixed(0)}, median ${med}, max ${counts[counts.length - 1]}`);
  }

  console.log(`\n================================================\n`);
}

/** Percentile from an integer-keyed count histogram. */
function percentile(hist: Map<number, number>, q: number): number {
  const total = [...hist.values()].reduce((s, x) => s + x, 0);
  if (total === 0) return 0;
  const target = q * total;
  let cum = 0;
  for (const k of [...hist.keys()].sort((a, b) => a - b)) {
    cum += hist.get(k)!;
    if (cum >= target) return k;
  }
  return 0;
}

function fmtTs(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '?';
}
function pct(a: number, b: number): string {
  return b > 0 ? `${((100 * a) / b).toFixed(1)}%` : 'n/a';
}

main().catch((err) => {
  console.error('analyze fatal:', err?.message ?? err);
  process.exit(1);
});
