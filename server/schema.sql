-- Cripto en Vivo v12 — esquema de usuarios + Kalshi (solo lectura)
-- Base separada para cripto-en-vivo en Neon (NO tocar las tablas de
-- Mercado Cuba). El servidor también ejecuta estas sentencias solo
-- (CREATE TABLE IF NOT EXISTS) al arrancar si DATABASE_URL está puesta.
-- Sin DATABASE_URL, el servidor usa un archivo local JSON (modo dev).

CREATE TABLE IF NOT EXISTS cev_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cev_kalshi_connections (
  user_id INTEGER PRIMARY KEY REFERENCES cev_users(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at TIMESTAMPTZ
);

-- Datos de usuario guardados en la cuenta (cartera virtual y alertas,
-- que en v7-v11 vivían solo en localStorage). JSON por usuario.
CREATE TABLE IF NOT EXISTS cev_user_data (
  user_id INTEGER NOT NULL REFERENCES cev_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('portfolio', 'alerts')),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind)
);

CREATE INDEX IF NOT EXISTS cev_users_email_idx ON cev_users (email);
