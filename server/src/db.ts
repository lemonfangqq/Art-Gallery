import { Pool } from 'pg';
import dns from 'dns';

dns.setDefaultResultOrder('ipv4first');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Please configure it in Render environment variables.');
}

const fixedUrl = DATABASE_URL.replace(/:5432\//, ':6543/');
export const pool = new Pool({
  connectionString: fixedUrl,
  ssl: { rejectUnauthorized: false },
});

// ─── Schema ───
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bio TEXT DEFAULT '',
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    desc TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artworks (
    id TEXT PRIMARY KEY,
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    date TEXT DEFAULT '',
    compressed_file TEXT NOT NULL,
    original_file TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
`;

export async function initDb(): Promise<void> {
  await pool.query(SCHEMA);
  console.log('PostgreSQL tables created/verified.');
}
