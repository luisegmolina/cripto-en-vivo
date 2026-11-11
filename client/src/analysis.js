// Análisis técnico de PRUEBA EDUCATIVA — no es recomendación de inversión.
// Reglas clásicas y públicas (RSI, MACD, EMA, Bollinger, patrones de velas).
// Ningún indicador predice el precio: solo resume lo que ya pasó en el gráfico.

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}
export function macd(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  if (e12 == null || e26 == null) return null;
  const line = e12 - e26;
  // Histograma aproximado con la serie de líneas MACD de las últimas 9 velas
  const lines = [];
  for (let n = 26; n <= closes.length; n++) {
    const a = ema(closes.slice(0, n), 12), b = ema(closes.slice(0, n), 26);
    if (a != null && b != null) lines.push(a - b);
  }
  const signal = lines.length >= 9 ? ema(lines.slice(-9), 9) ?? lines[lines.length - 1] : line;
  return { line, signal, histogram: line - signal };
}
export function bollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const s = closes.slice(-period);
  const mean = s.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const last = closes[closes.length - 1];
  return { middle: mean, upper: mean + 2 * sd, lower: mean - 2 * sd, pctB: sd ? (last - (mean - 2 * sd)) / (4 * sd) : 0.5 };
}

// Patrones de velas sobre las últimas velas. Devuelve lista {name, dir, time, text}
export function detectPatterns(candles) {
  const out = [];
  if (candles.length < 3) return out;
  const c = candles[candles.length - 1], p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open), range = c.high - c.low || 1;
  const upper = c.high - Math.max(c.open, c.close), lower = Math.min(c.open, c.close) - c.low;
  const bullish = c.close > c.open, bearish = c.close < c.open;
  // Martillo: cuerpo pequeño, mecha inferior larga, tras caída
  if (body <= range * 0.35 && lower >= body * 2 && upper <= body) out.push({ name: 'Martillo', dir: 'up', time: c.time, text: 'Cuerpo pequeño con mecha larga abajo: los compradores defendieron el precio. Posible rebote, no seguro.' });
  // Estrella fugaz: cuerpo pequeño, mecha superior larga
  if (body <= range * 0.35 && upper >= body * 2 && lower <= body) out.push({ name: 'Estrella fugaz', dir: 'down', time: c.time, text: 'Cuerpo pequeño con mecha larga arriba: los vendedores frenaron la subida. Posible bajada, no seguro.' });
  // Envolvente
  if (p.close < p.open && bullish && c.open <= p.close && c.close >= p.open) out.push({ name: 'Envolvente alcista', dir: 'up', time: c.time, text: 'La vela verde cubre por completo a la roja anterior: cambio de fuerza hacia arriba.' });
  if (p.close > p.open && bearish && c.open >= p.close && c.close <= p.open) out.push({ name: 'Envolvente bajista', dir: 'down', time: c.time, text: 'La vela roja cubre por completo a la verde anterior: cambio de fuerza hacia abajo.' });
  // Doji: apertura casi igual al cierre
  if (body <= range * 0.1) out.push({ name: 'Doji', dir: 'neutral', time: c.time, text: 'Apertura y cierre casi iguales: indecisión entre compradores y vendedores.' });
  return out;
}

// Serie EMA completa (un valor por vela, null hasta tener suficientes
// datos) para dibujarla como línea en el gráfico.
export function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// Serie Bollinger completa (un {upper, middle, lower} por vela, null
// hasta tener 20 velas) para dibujar las bandas como líneas.
export function bollingerSeries(closes, period = 20) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  for (let i = period - 1; i < closes.length; i++) {
    const s = closes.slice(i - period + 1, i + 1);
    const mean = s.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    out[i] = { middle: mean, upper: mean + 2 * sd, lower: mean - 2 * sd };
  }
  return out;
}

// Serie RSI completa (un valor por vela, null hasta tener 15 velas)
// para dibujarla como panel inferior del gráfico.
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) out[i] = rsi(closes.slice(0, i + 1), period);
  return out;
}

export function analyze(candles) {
  if (!candles || candles.length < 30) return { score: 0, label: 'Sin señal clara', detail: 'Faltan velas para calcular los indicadores.', rsi: null, macd: null, ema20: null, ema50: null, bollinger: null, patterns: [] };
  const closes = candles.map((c) => c.close);
  const r = rsi(closes), m = macd(closes);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const b = bollinger(closes);
  const patterns = detectPatterns(candles);
  let score = 0; const parts = [];
  if (e20 != null && e50 != null) { const s = e20 > e50 ? 20 : -20; score += s; parts.push(`Tendencia EMA 20/50: ${s}`); }
  if (m) { const s = m.histogram > 0 ? 10 : -10; score += s; parts.push(`MACD: ${s}`); }
  if (r != null) { const s = r < 30 ? 15 : r > 70 ? -15 : Math.round((50 - r) / 5); score += s; parts.push(`RSI ${r.toFixed(1)}: ${s}`); }
  if (b) { const s = b.pctB < 0.2 ? 5 : b.pctB > 0.8 ? -5 : 0; score += s; parts.push(`Bollinger: ${s}`); }
  for (const p of patterns) { const s = p.dir === 'up' ? 12 : p.dir === 'down' ? -12 : 0; score += s; parts.push(`${p.name}: ${s}`); }
  score = Math.max(-100, Math.min(100, score));
  const label = score >= 25 ? 'Posible subida' : score <= -25 ? 'Posible bajada' : 'Sin señal clara';
  const strength = Math.abs(score) >= 60 ? 'Fuerte' : Math.abs(score) >= 25 ? 'Moderada' : 'Débil';
  return { score, label, strength, detail: parts.join(' · '), rsi: r, macd: m, ema20: e20, ema50: e50, bollinger: b, patterns };
}
