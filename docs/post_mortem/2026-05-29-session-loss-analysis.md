# Post-mortem: Sesión 2026-05-29 — Pérdida de $15.20

**Activo:** XRP  
**Duración:** 18:54–19:51 UTC (57 min, 4 runs, 10 windows resueltos)  
**PnL interno (realizado):** +$22.25 (10 windows × resultado contabilizado)  
**PnL real (wallet):** **−$15.20**  
**Discrepancia:** $37.45

---

## 1. Progresión del balance

| Run | Hora inicio (UTC) | Balance USDC | Cambio |
|-----|-------------------|-------------|--------|
| 1 | 18:54:34 | $113.53 | — |
| 2 | 18:55:21 | $109.58 | −$3.95 |
| 3 | 19:21:50 | $112.50 | +$2.92 |
| 4 (último) | 19:51:34 | **$98.33** | **−$14.17** |

El run 3 es el más dañino: la contabilidad interna reportó `realizedSessionUsd: +$5.41` pero el balance cayó $14.17. Al cierre del run 3, `markGapUsd: 17.88` confirmaba que el mark interno divergía $17.88 de la realidad on-chain.

---

## 2. Causa raíz #1 — Reconcile con `avgPrice=0` destruye el hedge ceiling

### Qué pasó

El reconciliador on-chain (`reconcile_every_sec: 8`, `reconcile_correct: true`) detecta diferencias entre shares trackeadas y shares on-chain. Cuando la diferencia es positiva (hay **más** shares on-chain de las que el bot trackea), ajusta el account con el `avgPrice` que devuelve el endpoint `/positions`.

**Cuando ese `avgPrice` es `0`** (posición recién abierta, fill no indexado todavía por la API), el ajuste de cashUsd es nulo:

```
cashUsd_new = cashUsd_old - drift * 0 = cashUsd_old
```

Las shares aumentan pero `cashUsd` no cambia → el account queda con shares "gratis" (coste $0).

### Impacto en el hedge ceiling

El quoter calcula el techo dinámico del hedge-BUY así:

```typescript
// src/engine/quoter.ts
const otherLegAvgCost =
  otherLeg && otherLeg.account.shares > 0.5
    ? -otherLeg.account.cashUsd / otherLeg.account.shares
    : undefined;

if (hedgeRoom > 0 && input.otherLegAvgCost != null && input.otherLegAvgCost > 0) {
  dynamicHedgeCeiling = Math.min(
    HEDGE_BUY_PRICE_CEILING,            // 0.85
    1.0 - input.otherLegAvgCost - minProfit,
  );
}
// Si avgCost = 0 → la condición "> 0" falla → fallback a 0.85
```

Cuando el otro leg tiene shares con `cashUsd=0` (snap sin precio), `otherLegAvgCost = 0`. La condición `> 0` falla y el ceiling **cae al máximo hardcoded de 0.85**, ignorando completamente la garantía `min_pair_profit_per_share`.

### Evidencia en el log

```
19:07:12 — NO  tracked:  0.00 → onchain: 10.00  avgPrice: 0   ← snap sin coste
19:07:21 — NO  tracked: 25.00 → onchain: 15.00  avgPrice: 0.31
19:07:29 — YES tracked:  0.00 → onchain:  5.00  avgPrice: 0   ← snap sin coste
19:07:37 — YES tracked:  5.00 → onchain: 20.00  avgPrice: 0   ← snap sin coste
19:07:54 — YES tracked: 40.00 → onchain: 10.00  avgPrice: 0.7174
```

Inmediatamente después del snap de NO a 10 shares con `avgPrice=0`:
- `NO.cashUsd = 0`, `NO.shares = 10` → `avgCost = 0`
- `otherLegAvgCost = 0` → ceiling = **0.85**
- El bot posta BUY YES al precio de mercado (~0.77)

Resultado de fills a las 19:07:49:
```
BUY YES 0.66  5 shares  $3.30   (orden colocada 19:07:33)
BUY YES 0.69  5 shares  $3.45   (orden colocada 19:07:30)
BUY YES 0.75  5 shares  $3.75   (orden colocada 19:07:30)  ← sobre el ceiling real 0.71
BUY YES 0.77  5 shares  $3.85   (orden colocada 19:07:21)  ← sobre el ceiling real 0.71
```

El ceiling **real** (con NO avgCost=0.267) habría sido `1 - 0.267 - 0.02 = 0.713`. Los fills de 0.75 y 0.77 están **6–8 ticks por encima**.

**Par formado:**
- YES avg: 0.717 + NO avg: 0.267 = **0.984** → margen $0.016/share (target: $0.02)
- Con taker fees a la resolución: margen negativo.

El mismo bug se repite en todos los windows de la sesión (68 correcciones en 57 minutos).

---

## 3. Causa raíz #2 — Double-counting de fills (`deriveTradeId` bug)

### Qué pasó

La API `/activity` devuelve a veces el mismo fill con IDs ligeramente distintos (documentado en bot.yml desde 2026-05-28). El deduplicador usa `a.seen.has(t.id)`, pero si el ID varía, el mismo fill se aplica dos veces.

### Patrón observado

```
19:07:21 — NO tracked: 25.00 → onchain: 15.00  drift: -10.00   (double-count de 10 shares)
19:17:32 — NO tracked: 30.00 → onchain: 15.00  drift: -15.00   (double-count de 15 shares)
19:23:33 — NO tracked: 52.75 → onchain: 28.88  drift: -23.88   (double-count de ~24 shares)
19:36:58 — NO tracked: 30.52 → onchain: 15.26  drift: -15.26   (double-count exacto ×2)
```

Cada window sufre al menos un episodio de double-count seguido de corrección.

### Impacto en decisiones

Con el account inflado:
- `otherLegShares` es el doble del real → `hedgeRoom` falso y grande
- El bot cree que necesita hedge agresivo cuando en realidad ya está hedgeado
- Se colocan más órdenes BUY en el otro leg de las necesarias
- El `spendBlocksBuy` y `hedgeBlocksBuy` trabajan sobre cuentas incorrectas

La frecuencia (>1 corrección/minuto) es inaceptable e indica que el fix de `deriveTradeId` **no está funcionando** para todos los casos en producción.

---

## 4. Causa raíz #3 — Oscilación de shares crea posiciones fantasma

### El ciclo destructivo

En la ventana de 8 segundos entre reconciles, el account oscila porque:
1. `/activity` devuelve fills double-counted → shares sube a N×2
2. Reconciler baja a on-chain truth
3. `/activity` siguiente tick vuelve a double-contar → shares sube de nuevo

La oscilación más extrema de la sesión (Window 3, YES):
```
tracked:  0 → 5 → 20 → 40 → 10 → 0 → 10
           en 56 segundos (19:07:29 a 19:08:25)
```

Con `YES tracked=40` y `onchain=10`:
- El bot intenta SELL YES para reducir la posición inflada a 40
- Esas órdenes SELL van al mercado y pueden rellenar (o parcialmente)
- Cuando el reconciler baja a 10, las SELL que ya rellenaron han vendido shares reales a precios de mercado
- Esto genera pérdidas en el leg YES que el accounting posterior no captura correctamente

Además, a las 19:08:21:
```
YES tracked:  0.00 → onchain: 10.00  avgPrice: 0.7174  ← corrección de 10 shares a $0.71 avg
NO  tracked: 10.87 → onchain:  7.93  avgPrice: 0.3049
```
El bot ya había comprado esas 10 YES a ~$7.17 de coste real, pero el tracking las "olvidó" entre correcciones.

---

## 5. Causa raíz #4 — `take_profit_halt` se disparó con PnL ilusorio

### Qué pasó

```json
{
  "kind": "take_profit_halt",
  "realizedSessionUsd": 16.841,
  "threshold": 10
}
```

Al momento del halt (19:21:24 UTC, run 2):
- Windows 4 y 5 habían resuelto: +$16.84 realizado
- Windows 1, 2 y 3 tenían `unresolvedDeferredUsd: $19.36` aún abiertos

El `realizedSessionUsd` no descuenta el capital comprometido en posiciones deferred. El bot paró creyendo que había ganado $16.84 cuando en realidad:
- Run 2 empezó en $109.58
- Run 3 empezó en $112.50 (+$2.92 real, no +$16.84)
- La diferencia ($13.92) son las pérdidas netas de los windows 1–3 deferred al resolver

### Riesgo del halt prematuro

Al parar con deferred abiertos, el bot no puede cerrar posiciones si van en contra. Esas posiciones resuelven solas en el mercado sin ninguna gestión activa.

---

## 6. Causa raíz #5 — Hedge NO a precios prohibitivos (Window 12)

En el último window activo (19:46–19:50 ET), el mismo ciclo de reconcile/snap produjo:

```
19:47:08 — BUY NO 0.71  1.30 shares  $0.92
19:47:08 — BUY NO 0.71  3.69 shares  $2.62
19:47:08 — BUY NO 0.78  5.00 shares  $3.90
```

YES avg de ese window ≈ $0.36 (fills a 0.29, 0.35, 0.44):
- Par cost = 0.36 + 0.745 = **$1.105**
- **Pérdida garantizada de $0.105/share** independientemente del resultado
- 10 shares × $0.105 = **−$1.05 locked-in** antes de relleno completo

---

## 7. Resumen de pérdidas por causa

| Causa | Mecanismo | Pérdida estimada |
|-------|-----------|-----------------|
| Hedge ceiling roto (avgPrice=0 snap) | BUY YES/NO a precios sobre el real ceiling | ~$6–8 |
| Double-count → phantom SELLs | Vender shares que no existen → pérdida de inventario | ~$3–5 |
| take_profit_halt con deferred abiertos | Windows 1–3 resuelven sin gestión activa | ~$3–5 |
| NO buys a 0.71–0.78 (W12) | Par cost > $1, pérdida garantizada | ~$2–3 |
| **Total** | | **~$14–21** |

---

## 8. Fixes requeridos

### Fix 1 (CRÍTICO) — No crear shares "gratis" en reconcile snap

**Archivo:** `src/live/accounting.ts` → `reconcileAccount`

Cuando `drift > 0` y `avgPrice === 0`, el reconciliador no puede calcular el coste real de las shares descubiertas. En lugar de snapear y dejar `cashUsd` incorrecto, debe **no aplicar la corrección** (o usar el precio del libro como proxy):

```typescript
export function reconcileAccount(
  a: Account,
  onchainShares: number,
  avgPrice: number,
  toleranceShares = 0.5,
): ReconcileResult {
  const drift = onchainShares - a.shares;
  if (Math.abs(drift) <= toleranceShares) {
    return { account: a, drift, corrected: false };
  }

  // BUG FIX: si drift > 0 (shares on-chain que no trackeamos) y avgPrice = 0,
  // no podemos calcular el coste real. Snapear con coste 0 crea shares "gratis"
  // que destruyen el hedge ceiling. Devolver sin corregir y logear la anomalía.
  if (drift > 0 && avgPrice === 0) {
    return { account: a, drift, corrected: false };
  }

  const account: Account = {
    shares: onchainShares,
    cashUsd: a.cashUsd - drift * avgPrice,
    seen: a.seen,
  };
  return { account, drift, corrected: true };
}
```

**Efecto:** El hedge ceiling nunca cae al fallback de 0.85 por shares con coste $0.

### Fix 2 (CRÍTICO) — Defender el hedge ceiling contra avgCost=0 en el quoter

**Archivo:** `src/engine/quoter.ts`

Como segunda línea de defensa (en caso de que el reconcile no se parchee de inmediato), la condición del hedge ceiling debe también bloquear `avgCost < minPairProfit`:

```typescript
// Antes:
if (hedgeRoom > 0 && input.otherLegAvgCost != null && input.otherLegAvgCost > 0) {

// Después (también bloquea avgCost efectivamente 0 o irrealmente bajo):
const minViableAvgCost = 0.02; // si el otro leg "costó" menos de 2c, el dato es corrupto
if (hedgeRoom > 0 && input.otherLegAvgCost != null && input.otherLegAvgCost >= minViableAvgCost) {
```

**Efecto:** Cuando el reconcile crea shares gratis (avgCost=0), el ceiling no cae a 0.85 sino que se mantiene en `cfg.maxBuyPrice` (0.50).

### Fix 3 (ALTA PRIORIDAD) — Investigar y reparar deriveTradeId

**Archivo:** `src/clob/trades.ts` (o donde se genere el ID de trade)

68 reconcile corrections en 57 minutos indica que el bug de double-counting sigue activo. Verificar:

1. ¿El ID derivado incluye todos los campos que lo hacen único (token, side, price, shares, timestamp)?
2. ¿Los fills de la API a veces varían el timestamp en ±1ms? Si es así, el ID debe ser insensible al timestamp o usar el ID nativo de la API.
3. Loggear el `raw_id` de la API junto al `derived_id` para detectar colisiones.

Métrica de validación: tras el fix, `reconcile_corrections_per_hour` debe caer a < 5 (solo drift de latencia, no double-count).

### Fix 4 (MEDIA PRIORIDAD) — `take_profit_halt` debe esperar a que no haya deferred

**Archivo:** `src/index.ts` — lógica del `take_profit_halt`

```typescript
// Antes:
if (cfg.live.sessionTakeProfitUsd > 0 && realizedSessionUsd >= cfg.live.sessionTakeProfitUsd) {
  // halt

// Después: solo haltear si no hay capital atascado en deferred
const hasOpenDeferred = /* windows con resolved=false y shares > 0 */;
if (cfg.live.sessionTakeProfitUsd > 0
    && realizedSessionUsd >= cfg.live.sessionTakeProfitUsd
    && !hasOpenDeferred) {
  // halt
}
```

O alternativamente: el threshold del halt debe incluir `unresolvedDeferredUsd` como pasivo:
```typescript
const effectivePnl = realizedSessionUsd - unresolvedDeferredMarkdownUsd;
```

### Fix 5 (MEDIA PRIORIDAD) — Reducir `reconcile_every_sec` o añadir cooldown entre correcciones

Con correcciones cada 8s y fills que llegan con lag, la ventana de "estado corrupto" es demasiado larga. Opciones:
- Bajar a `reconcile_every_sec: 4` (más correcciones, cada una con menor drift acumulado)
- O añadir un cooldown: si se hizo una corrección en el último ciclo, no colocar órdenes hasta el siguiente ciclo limpio

---

## 9. Métricas de diagnóstico a añadir

Para detectar estos bugs en tiempo real en futuros runs:

```yaml
# bot.yml — alertas recomendadas
monitoring:
  alert_reconcile_corrections_per_min: 2    # >2/min = doble-count activo
  alert_avg_cost_zero_snap: true            # cualquier snap con avgPrice=0 = alerta
  alert_ceiling_fallback_to_085: true       # hedge ceiling cayó al fallback hardcoded
  alert_pair_cost_above: 0.98              # par formado con coste > $0.98
```

---

## 10. Conclusión

El bot **sí tiene edge teórico** (10 windows con +$22.25 PnL combinado). La pérdida de $15 no vino de una mala estrategia sino de **bugs de contabilidad en el reconciliador** que corrompían el account state, haciendo que el hedge ceiling colapsara al máximo (0.85) y el bot comprara legs a precios que garantizan pérdidas.

**Prioridad de fixes:** Fix 1 y Fix 2 son los más urgentes — juntos eliminan el mecanismo primario de pérdida. Fix 3 elimina la causa raíz del doble-count que desencadena todo. Los fixes 4 y 5 son mejoras de robustez secundarias.

**No lanzar otro run hasta que Fix 1 esté implementado y testeado.**
