import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { pool, initDb } from './db';
import { uploadToR2, deleteFromR2, signR2Url, r2KeyFromUrl } from './r2';

// ─── Config ───
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Helpers ───
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
import path from 'path';
import fs from 'fs';
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

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

// ════════════════════════════════════════
// ARTISTS
// ════════════════════════════════════════

app.get('/api/artists', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM artists ORDER BY created_at DESC');
  res.json(rows);
});

app.get('/api/artists/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM artists WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.post('/api/artists', async (req, res) => {
  const { name, bio, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = uid();
  await pool.query(
    'INSERT INTO artists (id, name, bio, color, created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, name.trim(), (bio || '').trim(), color || '#D4A373', now()]
  );
  const { rows } = await pool.query('SELECT * FROM artists WHERE id = $1', [id]);
  res.json(rows[0]);
});

app.put('/api/artists/:id', async (req, res) => {
  const { name, bio, color } = req.body;
  const { rows: existingRows } = await pool.query('SELECT * FROM artists WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' });
  const existing = existingRows[0];
  await pool.query(
    'UPDATE artists SET name=$1, bio=$2, color=$3 WHERE id=$4',
    [
      (name || existing.name).trim(),
      bio !== undefined ? bio.trim() : existing.bio,
      color || existing.color,
      req.params.id,
    ]
  );
  const { rows } = await pool.query('SELECT * FROM artists WHERE id = $1', [req.params.id]);
  res.json(rows[0]);
});

app.delete('/api/artists/:id', async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT * FROM artists WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' });
  // Delete R2 images for all artworks by this artist
  const { rows: artworks } = await pool.query(
    'SELECT compressed_file, original_file FROM artworks WHERE artist_id = $1',
    [req.params.id]
  );
  for (const a of artworks) {
    if (a.compressed_file) await deleteFromR2(a.compressed_file);
    if (a.original_file) await deleteFromR2(a.original_file);
  }
  // CASCADE handles albums + artworks rows
  await pool.query('DELETE FROM artists WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ════════════════════════════════════════
// ALBUMS
// ════════════════════════════════════════

app.get('/api/albums', async (req, res) => {
  const { artistId } = req.query;
  let result;
  if (artistId) {
    result = await pool.query('SELECT * FROM albums WHERE artist_id = $1 ORDER BY created_at DESC', [artistId]);
  } else {
    result = await pool.query('SELECT * FROM albums ORDER BY created_at DESC');
  }
  res.json(result.rows);
});

app.post('/api/albums', async (req, res) => {
  const { artistId, name, desc } = req.body;
  if (!artistId || !name?.trim()) return res.status(400).json({ error: 'Artist and name required' });
  const id = uid();
  await pool.query(
    'INSERT INTO albums (id, artist_id, name, "desc", created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, artistId, name.trim(), (desc || '').trim(), now()]
  );
  const { rows } = await pool.query('SELECT * FROM albums WHERE id = $1', [id]);
  res.json(rows[0]);
});

app.put('/api/albums/:id', async (req, res) => {
  const { name, desc } = req.body;
  const { rows: existingRows } = await pool.query('SELECT * FROM albums WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' });
  const existing = existingRows[0];
  await pool.query(
    'UPDATE albums SET name=$1, "desc"=$2 WHERE id=$3',
    [
      (name || existing.name).trim(),
      desc !== undefined ? desc.trim() : existing.desc,
      req.params.id,
    ]
  );
  const { rows } = await pool.query('SELECT * FROM albums WHERE id = $1', [req.params.id]);
  res.json(rows[0]);
});

app.delete('/api/albums/:id', async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT * FROM albums WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' });
  // Delete R2 images for artworks in this album
  const { rows: artworks } = await pool.query(
    'SELECT compressed_file, original_file FROM artworks WHERE album_id = $1',
    [req.params.id]
  );
  for (const a of artworks) {
    if (a.compressed_file) await deleteFromR2(a.compressed_file);
    if (a.original_file) await deleteFromR2(a.original_file);
  }
  // CASCADE handles artworks rows
  await pool.query('DELETE FROM albums WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ════════════════════════════════════════
// ARTWORKS
// ════════════════════════════════════════

app.get('/api/artworks', async (req, res) => {
  const { albumId, artistId } = req.query;
  let result;
  if (albumId) {
    result = await pool.query('SELECT * FROM artworks WHERE album_id = $1 ORDER BY created_at DESC', [albumId]);
  } else if (artistId) {
    result = await pool.query('SELECT * FROM artworks WHERE artist_id = $1 ORDER BY created_at DESC', [artistId]);
  } else {
    result = await pool.query('SELECT * FROM artworks ORDER BY created_at DESC');
  }
  res.json(result.rows);
});

// Serve R2 images via temporary signed URLs (bucket stays private)
app.get('/api/artworks/:id/image', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT compressed_file, original_file FROM artworks WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const key = r2KeyFromUrl(rows[0].compressed_file);
    if (!key) return res.status(404).json({ error: 'Not an R2 object' });
    const url = await signR2Url(key);
    res.redirect(url);
  } catch (err: any) {
    console.error('Signed URL error:', err);
    res.status(500).json({ error: err.message });
  }
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
    const compressedKey = `compressed_${id}.jpg`;
    const originalKey = `original_${id}.${ext}`;
    console.log(`[Upload] ext=${ext} size=${file.size} name=${file.originalname}`);

    // HEIC/HEIF: try sharp first (system libheif with HEVC plugin may work),
    // fall back to ffmpeg (which has its own HEVC decoder).
    let compressed: Buffer;
    let originalBuffer: Buffer;
    const isHeif = ext === 'heic' || ext === 'heif';
    if (isHeif) {
      try {
        console.log(`[Sharp] Trying system libheif for ${ext} file...`);
        compressed = await sharp(file.buffer, { sequentialRead: true })
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        originalBuffer = file.buffer;
        console.log(`[Sharp] HEIF decoded OK via system, compressed=${compressed.length} bytes`);
      } catch (sharpErr: any) {
        console.log(`[Sharp] libheif failed (${sharpErr.message}), trying ffmpeg...`);
        const tmpInput = `/tmp/heic_${id}.heic`;
        const tmpOutput = `/tmp/heic_${id}.jpg`;
        try {
          await writeFile(tmpInput, file.buffer);
          const execFileAsync = promisify(execFile);
          await execFileAsync('ffmpeg', [
            '-y', '-i', tmpInput,
            '-q:v', '5',
            '-frames:v', '1',
            tmpOutput,
          ], { timeout: 30000 });
          compressed = await readFile(tmpOutput);
          originalBuffer = file.buffer;
          console.log(`[FFmpeg] HEIF converted OK, output=${compressed.length} bytes`);
        } catch (ffErr: any) {
          console.error(`[FFmpeg] conversion failed: ${ffErr.message}`);
          throw new Error('HEIC/HEIF not supported server-side. Convert to JPEG before uploading, or use the web interface which converts automatically.');
        } finally {
          unlink(tmpInput).catch(() => {});
          unlink(tmpOutput).catch(() => {});
        }
      }
    } else {
      originalBuffer = file.buffer;
      console.log(`[Sharp] Compressing ${file.buffer.length} bytes buffer`);
      compressed = await sharp(file.buffer, { sequentialRead: true })
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      console.log(`[Sharp] Compressed OK, output=${compressed.length} bytes`);
    }

    // Upload both to R2
    let compressedUrl, originalUrl;
    try {
      console.log(`[R2] Uploading compressed=${compressed.length} bytes, original=${originalBuffer.length} bytes`);
      [compressedUrl, originalUrl] = await Promise.all([
        uploadToR2(compressedKey, compressed, 'image/jpeg'),
        uploadToR2(originalKey, originalBuffer, 'image/jpeg'),
      ]);
      console.log(`[R2] Upload OK`);
    } catch (r2Err: any) {
      console.error('[R2] Upload failed:', r2Err.message || r2Err);
      throw new Error(`R2 upload failed: ${r2Err.message || 'unknown error'}`);
    }

    await pool.query(
      'INSERT INTO artworks (id, album_id, artist_id, title, description, date, compressed_file, original_file, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, albumId, artistId, title.trim(), (description || '').trim(), todayCN(), compressedUrl, originalUrl, now()]
    );

    const { rows } = await pool.query('SELECT * FROM artworks WHERE id = $1', [id]);
    res.json(rows[0]);
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/artworks/:id', async (req, res) => {
  const { title, description } = req.body;
  const { rows: existingRows } = await pool.query('SELECT * FROM artworks WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' });
  const existing = existingRows[0];
  await pool.query(
    'UPDATE artworks SET title=$1, description=$2 WHERE id=$3',
    [
      (title || existing.title).trim(),
      description !== undefined ? description.trim() : existing.description,
      req.params.id,
    ]
  );
  const { rows } = await pool.query('SELECT * FROM artworks WHERE id = $1', [req.params.id]);
  res.json(rows[0]);
});

app.delete('/api/artworks/:id', async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT * FROM artworks WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' });
  const existing = existingRows[0];
  if (existing.compressed_file) await deleteFromR2(existing.compressed_file);
  if (existing.original_file) await deleteFromR2(existing.original_file);
  await pool.query('DELETE FROM artworks WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ════════════════════════════════════════
// MIGRATION: Import from GitHub data.json
// ════════════════════════════════════════

app.post('/api/migrate', async (req, res) => {
  const client = await pool.connect();
  try {
    const { dataUrl } = req.body;
    const resp = await fetch(dataUrl || 'https://raw.githubusercontent.com/lemonfangqq/Art-Gallery/main/data.json');
    const data = await resp.json() as { a?: any[]; b?: any[]; w?: any[] };

    await client.query('BEGIN');

    for (const a of (data.a || [])) {
      await client.query(
        'INSERT INTO artists (id, name, bio, color, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
        [a.id, a.n, a.b || '', a.c, a.at || now()]
      );
    }
    for (const b of (data.b || [])) {
      await client.query(
        'INSERT INTO albums (id, artist_id, name, "desc", created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
        [b.id, b.aid, b.n, b.desc || '', b.at || now()]
      );
    }
    for (const w of (data.w || [])) {
      const imgUrl = typeof w.i === 'string' ? w.i : (w.i?._url || '');
      await client.query(
        'INSERT INTO artworks (id, album_id, artist_id, title, description, date, compressed_file, original_file, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING',
        [w.id, w.bid, w.aid, w.t, w.desc || '', w.d || '', imgUrl, w.io || '', w.at || now()]
      );
    }

    await client.query('COMMIT');
    res.json({
      artists: (data.a || []).length,
      albums: (data.b || []).length,
      artworks: (data.w || []).length,
      message: 'Data imported to PostgreSQL. Images still served via CDN URLs.',
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── Start ───
async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Art Gallery server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
