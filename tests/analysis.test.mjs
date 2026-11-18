// Tests offline (sin servidor ni red) de los parches v15.2. Uso: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { rsi, rsiSeries, macd, analyze, emaSeries } from '../client/src/analysis.js';
import { wilson95, isCoinFlip } from '../client/src/stats.js';
import { evaluateWindowSignal, backtestWindowSignal } from '../client/src/windowOutcome.js';
import { backtestSignal } from '../client/src/backtest.js';

// Serie clásica de Wilder (Chart School): RSI(14) del último cierre ≈ 70.46
const WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];

test('RSI usa el suavizado de Wilder (valor de referencia)', () => {
  const s = rsiSeries(WILDER, 14);
  assert.ok(Math.abs(s[14] - 70.53) < 0.1, `RSI[14]=${s[14]}`);
  assert.ok(Math.abs(s[15] - 66.32) < 0.1, `RSI[15]=${s[15]}`);
  assert.equal(rsi(WILDER), s[s.length - 1]);
});
test('RSI: casos límite', () => {
  assert.equal(rsi([1, 2, 3]), null);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => i + 1)), 100);
  assert.equal(rsi(new Array(20).fill(5)), 50);
});
test('MACD: null sin 34 velas y consistente con EMA12-EMA26 con datos', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.2);
  assert.equal(macd(closes.slice(0, 33)), null);
  const m = macd(closes);
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  assert.ok(Math.abs(m.line - (e12.at(-1) - e26.at(-1))) < 1e-9);
  assert.ok(Math.abs(m.histogram - (m.line - m.signal)) < 1e-9);
});
test('analyze con 30-33 velas no rompe (MACD ausente)', () => {
  const c = Array.from({ length: 31 }, (_, i) => ({ time: i, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1 }));
  const a = analyze(c);
  assert.equal(a.macd, null);
  assert.ok(Number.isFinite(a.score));
});
test('Wilson 95%: 56 de 100 incluye 50 (equivale a una moneda); 70 de 100 no', () => {
  const a = wilson95(56, 100);
  assert.deepEqual(a, { low: 46, high: 65 });
  assert.equal(isCoinFlip(a), true);
  assert.equal(isCoinFlip(wilson95(70, 100)), false);
  assert.equal(wilson95(0, 0), null);
});

// Sin fuga de información: el resultado de la ventana i no puede cambiar la señal de la ventana i.
function synthetic(n, seed = 7) {
  let x = seed, price = 100; const out = [];
  const rnd = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
  for (let i = 0; i < n; i++) {
    const open = price, close = open * (1 + (rnd() - 0.5) * 0.01);
    out.push({ time: i * 900, open, close, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, volume: 1 });
    price = close;
  }
  return out;
}
test('windowOutcome: la señal no depende del cierre de la propia ventana', () => {
  const base = synthetic(120);
  const a = evaluateWindowSignal(base, 200);
  // Cambiar SOLO el cierre de una ventana pasada no puede cambiar su propia señal.
  const k = base.length - 40;
  const mutated = base.map((c, i) => (i === k ? { ...c, close: c.open * 1.05, high: c.open * 1.06 } : c));
  const b = evaluateWindowSignal(mutated, 200);
  const sa = a.find((h) => h.time === base[k].time), sb = b.find((h) => h.time === base[k].time);
  if (sa && sb) assert.equal(sa.key, sb.key, 'la señal de la ventana cambió al cambiar su propio cierre');
  const r = backtestWindowSignal(base);
  assert.ok(r.ci95 === null || (r.ci95.low <= r.pct && r.pct <= r.ci95.high));
});
test('backtestSignal (1h) devuelve ci95', () => {
  const r = backtestSignal(synthetic(200));
  assert.ok(r.total === 0 || r.ci95);
});
