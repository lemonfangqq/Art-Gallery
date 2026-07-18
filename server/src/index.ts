import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import Database from 'better-sqlite3';

// ─── Config ───
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'gallery.db');
const IMAGES_DIR = process.env.IMAGES_PATH || path.join(DATA_DIR, 'images');

fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ─── Database ───
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
`);

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function now(): string {
  return new Date().toISOString();
}
function todayCN(): string {
  return new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── Express ───
const app = express();
app.use(cors());
app.use(express.json());

// ─── Static files (frontend) ───
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// ─── Multer (image upload) ───
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.originalname.match(/\.(heic|heif)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  },
});

// ─── Image serving ───
app.use('/images', express.static(IMAGES_DIR));

// ════════════════════════════════════════
// ARTISTS
// ════════════════════════════════════════

app.get('/api/artists', (_req, res) => {
  const rows = db.prepare('SELECT * FROM artists ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/api/artists/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/artists', (req, res) => {
  const { name, bio, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = uid();
  db.prepare('INSERT INTO artists (id, name, bio, color, created_at) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), (bio || '').trim(), color || '#D4A373', now());
  res.json(db.prepare('SELECT * FROM artists WHERE id = ?').get(id));
});

app.put('/api/artists/:id', (req, res) => {
  const { name, bio, color } = req.body;
  const existing = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE artists SET name=?, bio=?, color=? WHERE id=?')
    .run(
      (name || existing.name).trim(),
      bio !== undefined ? bio.trim() : existing.bio,
      color || existing.color,
      req.params.id
    );
  res.json(db.prepare('SELECT * FROM artists WHERE id = ?').get(req.params.id));
});

app.delete('/api/artists/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // Delete all associated image files
  const artworks = db.prepare('SELECT compressed_file, original_file FROM artworks WHERE artist_id = ?').all(req.params.id) as any[];
  for (const a of artworks) {
    try { if (a.compressed_file) fs.unlinkSync(path.join(IMAGES_DIR, a.compressed_file)); } catch {}
    try { if (a.original_file) fs.unlinkSync(path.join(IMAGES_DIR, a.original_file)); } catch {}
  }
  db.prepare('DELETE FROM artists WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ════════════════════════════════════════
// ALBUMS
// ════════════════════════════════════════

app.get('/api/albums', (req, res) => {
  const { artistId } = req.query;
  let rows;
  if (artistId) {
    rows = db.prepare('SELECT * FROM albums WHERE artist_id = ? ORDER BY created_at DESC').all(artistId);
  } else {
    rows = db.prepare('SELECT * FROM albums ORDER BY created_at DESC').all();
  }
  res.json(rows);
});

app.post('/api/albums', (req, res) => {
  const { artistId, name, desc } = req.body;
  if (!artistId || !name?.trim()) return res.status(400).json({ error: 'Artist and name required' });
  const id = uid();
  db.prepare('INSERT INTO albums (id, artist_id, name, desc, created_at) VALUES (?,?,?,?,?)')
    .run(id, artistId, name.trim(), (desc || '').trim(), now());
  res.json(db.prepare('SELECT * FROM albums WHERE id = ?').get(id));
});

app.put('/api/albums/:id', (req, res) => {
  const { name, desc } = req.body;
  const existing = db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE albums SET name=?, desc=? WHERE id=?')
    .run(
      (name || existing.name).trim(),
      desc !== undefined ? desc.trim() : existing.desc,
      req.params.id
    );
  res.json(db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id));
});

app.delete('/api/albums/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const artworks = db.prepare('SELECT compressed_file, original_file FROM artworks WHERE album_id = ?').all(req.params.id) as any[];
  for (const a of artworks) {
    try { if (a.compressed_file) fs.unlinkSync(path.join(IMAGES_DIR, a.compressed_file)); } catch {}
    try { if (a.original_file) fs.unlinkSync(path.join(IMAGES_DIR, a.original_file)); } catch {}
  }
  db.prepare('DELETE FROM albums WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ════════════════════════════════════════
// ARTWORKS
// ════════════════════════════════════════

app.get('/api/artworks', (req, res) => {
  const { albumId, artistId } = req.query;
  let rows;
  if (albumId) {
    rows = db.prepare('SELECT * FROM artworks WHERE album_id = ? ORDER BY created_at DESC').all(albumId);
  } else if (artistId) {
    rows = db.prepare('SELECT * FROM artworks WHERE artist_id = ? ORDER BY created_at DESC').all(artistId);
  } else {
    rows = db.prepare('SELECT * FROM artworks ORDER BY created_at DESC').all();
  }
  res.json(rows);
});

app.post('/api/artworks', upload.single('image'), async (req, res) => {
  try {
    const { albumId, artistId, title, description } = req.body;
    if (!albumId || !artistId || !title?.trim() || !req.file) {
      return res.status(400).json({ error: 'albumId, artistId, title and image required' });
    }

    const file = req.file;
    const ext = file.originalname.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg';
    const id = uid();
    const compressedName = `compressed_${id}.jpg`;
    const originalName = `original_${id}.${ext}`;

    // Save original
    await fs.promises.writeFile(path.join(IMAGES_DIR, originalName), file.buffer);

    // Compress with sharp (max 1200px, JPEG quality 85)
    const compressed = await sharp(file.buffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    await fs.promises.writeFile(path.join(IMAGES_DIR, compressedName), compressed);

    db.prepare(
      'INSERT INTO artworks (id, album_id, artist_id, title, description, date, compressed_file, original_file, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, albumId, artistId, title.trim(), (description || '').trim(), todayCN(), compressedName, originalName, now());

    res.json(db.prepare('SELECT * FROM artworks WHERE id = ?').get(id));
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/artworks/:id', (req, res) => {
  const { title, description } = req.body;
  const existing = db.prepare('SELECT * FROM artworks WHERE id = ?').get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE artworks SET title=?, description=? WHERE id=?')
    .run(
      (title || existing.title).trim(),
      description !== undefined ? description.trim() : existing.description,
      req.params.id
    );
  res.json(db.prepare('SELECT * FROM artworks WHERE id = ?').get(req.params.id));
});

app.delete('/api/artworks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM artworks WHERE id = ?').get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  try { if (existing.compressed_file) fs.unlinkSync(path.join(IMAGES_DIR, existing.compressed_file)); } catch {}
  try { if (existing.original_file) fs.unlinkSync(path.join(IMAGES_DIR, existing.original_file)); } catch {}
  db.prepare('DELETE FROM artworks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ════════════════════════════════════════
// MIGRATION: Import from GitHub data.json
// ════════════════════════════════════════

app.post('/api/migrate', async (req, res) => {
  try {
    const { dataUrl } = req.body;
    // Fetch data.json
    const resp = await fetch(dataUrl || 'https://raw.githubusercontent.com/lemonfangqq/Art-Gallery/main/data.json');
    const data = await resp.json() as { a?: any[]; b?: any[]; w?: any[] };

    const insertArtist = db.prepare('INSERT OR IGNORE INTO artists (id, name, bio, color, created_at) VALUES (?,?,?,?,?)');
    const insertAlbum = db.prepare('INSERT OR IGNORE INTO albums (id, artist_id, name, desc, created_at) VALUES (?,?,?,?,?)');
    const insertArtwork = db.prepare('INSERT OR IGNORE INTO artworks (id, album_id, artist_id, title, description, date, compressed_file, original_file, created_at) VALUES (?,?,?,?,?,?,?,?,?)');

    const tx = db.transaction(() => {
      for (const a of (data.a || [])) {
        insertArtist.run(a.id, a.n, a.b || '', a.c, a.at || now());
      }
      for (const b of (data.b || [])) {
        insertAlbum.run(b.id, b.aid, b.n, b.desc || '', b.at || now());
      }
      for (const w of (data.w || [])) {
        const imgUrl = typeof w.i === 'string' ? w.i : (w.i?._url || '');
        insertArtwork.run(w.id, w.bid, w.aid, w.t, w.desc || '', w.d || '', imgUrl, w.io || '', w.at || now());
      }
    });
    tx();

    res.json({
      artists: (data.a || []).length,
      albums: (data.b || []).length,
      artworks: (data.w || []).length,
      message: 'Data imported. Images are still served via CDN URLs.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`Art Gallery server running on http://localhost:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Images dir: ${IMAGES_DIR}`);
});
