// Tarjeta para compartir por WhatsApp — todo local, sin servidor.
// Genera (1) un texto listo para pegar en WhatsApp con tu P&L virtual
// de la semana, tu puesto en la liga y tu mejor operación, con el enlace
// a la app, y (2) una imagen PNG descargable dibujada con canvas.
// El texto se comparte con navigator.share si existe, si no se copia al
// portapapeles. Nada sale de tu navegador salvo lo que tú compartas.

export const APP_URL = 'https://cripto-en-vivo.onrender.com';

export function shareText({ nickname, pnl, pnlPct, rank, leagueSize, weekLabel, bestTrade, currencySym = '$' }) {
  const who = nickname ? nickname : 'Yo';
  const pnlLine = pnl >= 0
    ? `🟢 ${who} va +${currencySym}${Math.abs(pnl).toLocaleString('es-US', { maximumFractionDigits: 0 })} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) en virtual esta semana`
    : `🔴 ${who} va ${currencySym}${Math.abs(pnl).toLocaleString('es-US', { maximumFractionDigits: 0 })} (${pnlPct.toFixed(2)}%) en virtual esta semana`;
  const rankLine = rank != null && leagueSize
    ? `🏆 Puesto ${rank} de ${leagueSize} en la liga semanal (${weekLabel})`
    : '';
  const bestLine = bestTrade ? `💰 Mejor operación: ${bestTrade}` : '';
  return [
    '₿ Cripto en Vivo — mi semana en virtual',
    pnlLine,
    rankLine,
    bestLine,
    '',
    'Dinero VIRTUAL, prueba educativa. Nada de esto es dinero real.',
    `Juega tú también: ${APP_URL}`,
  ].filter(Boolean).join('\n');
}

export function whatsappUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// Dibuja la tarjeta 1080×1080 en el canvas dado. Devuelve el canvas.
export function drawShareCard(canvas, { nickname, pnl, pnlPct, rank, leagueSize, weekLabel, bestTrade, currencySym = '$' }) {
  const W = 1080, H = 1080;
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  c.fillStyle = '#0b0f14'; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#f59e0b'; c.lineWidth = 10; c.strokeRect(20, 20, W - 40, H - 40);
  c.fillStyle = '#f59e0b'; c.font = 'bold 64px system-ui, sans-serif'; c.textAlign = 'center';
  c.fillText('₿ Cripto en Vivo', W / 2, 140);
  c.fillStyle = '#e2e8f0'; c.font = 'bold 56px system-ui, sans-serif';
  c.fillText(nickname ? nickname : 'Mi semana en virtual', W / 2, 230);
  c.fillStyle = '#94a3b8'; c.font = '28px system-ui, sans-serif';
  c.fillText(`Liga semanal · ${weekLabel || ''}`, W / 2, 280);
  const up = pnl >= 0;
  c.fillStyle = up ? '#22c55e' : '#ef4444'; c.font = 'bold 110px system-ui, sans-serif';
  c.fillText(`${up ? '+' : '−'}${currencySym}${Math.abs(pnl).toLocaleString('es-US', { maximumFractionDigits: 0 })}`, W / 2, 430);
  c.font = 'bold 56px system-ui, sans-serif';
  c.fillText(`${up ? '+' : ''}${pnlPct.toFixed(2)}% en virtual`, W / 2, 510);
  c.fillStyle = '#e2e8f0'; c.font = 'bold 52px system-ui, sans-serif';
  if (rank != null && leagueSize) c.fillText(`🏆 Puesto ${rank} de ${leagueSize} en la liga`, W / 2, 620);
  c.fillStyle = '#94a3b8'; c.font = '32px system-ui, sans-serif';
  if (bestTrade) {
    const lines = wrapText(c, `Mejor operación: ${bestTrade}`, W - 160);
    lines.forEach((ln, i) => c.fillText(ln, W / 2, 700 + i * 44));
  }
  c.fillStyle = '#f59e0b'; c.font = 'bold 34px system-ui, sans-serif';
  c.fillText('Dinero VIRTUAL · Prueba educativa', W / 2, 880);
  c.fillStyle = '#94a3b8'; c.font = '30px system-ui, sans-serif';
  c.fillText('Nada de esto es dinero real ni recomendación de inversión.', W / 2, 930);
  c.fillStyle = '#e2e8f0'; c.font = 'bold 36px system-ui, sans-serif';
  c.fillText(APP_URL.replace('https://', ''), W / 2, 1000);
  return canvas;
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}
