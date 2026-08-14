// Conexión a Neon (Postgres serverless) + creación automática de tablas.
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

let ready = null;
function ensureTables() {
  if (ready) return ready;
  ready = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      items JSONB NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'nuevo',
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

module.exports = { sql, ensureTables };
