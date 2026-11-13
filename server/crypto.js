// Cifrado de la clave privada de Kalshi (v12, solo lectura).
// AES-256-GCM con una clave maestra de entorno KALSHI_ENCRYPTION_KEY
// (64 caracteres hex = 32 bytes, o base64 de 32 bytes). La clave
// maestra NUNCA se guarda en GitHub ni se devuelve por ninguna API:
// vive como variable de entorno en Render.
// Sin KALSHI_ENCRYPTION_KEY, en local se usa una clave efímera por
// proceso (aviso en consola): la conexión a Kalshi funciona para
// probar, pero no sobrevive a un reinicio. En producción (Render)
// la conexión se rechaza con 503 si no hay clave maestra.
const crypto = require('crypto');

let ephemeralKey = null;
function masterKey() {
  const raw = (process.env.KALSHI_ENCRYPTION_KEY || '').trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return { key: Buffer.from(raw, 'hex'), ephemeral: false };
    try {
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) return { key: b, ephemeral: false };
    } catch {}
    throw new Error('KALSHI_ENCRYPTION_KEY no es válida: usa 64 caracteres hex (32 bytes) o base64 de 32 bytes.');
  }
  if (!ephemeralKey) {
    ephemeralKey = crypto.randomBytes(32);
    console.log('[kalshi] ⚠️ Sin KALSHI_ENCRYPTION_KEY: se usa una clave efímera (las conexiones a Kalshi NO sobreviven a un reinicio). Pon la variable en Render.');
  }
  return { key: ephemeralKey, ephemeral: true };
}

function encrypt(plaintext) {
  const { key } = masterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

function decrypt(blob) {
  const { key } = masterKey();
  if (!String(blob || '').startsWith('v1:')) throw new Error('Formato de clave cifrada no válido.');
  const buf = Buffer.from(String(blob).slice(3), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function isEncrypted(blob) {
  return String(blob || '').startsWith('v1:');
}

module.exports = { masterKey, encrypt, decrypt, isEncrypted };
