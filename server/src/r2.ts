import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ─── Config ───
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
export const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/+$/, ''); // strip trailing slashes

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL) {
  console.warn('R2 env vars not fully configured. Image upload to R2 will fail.');
}

// ─── Client ───
export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || '',
  },
});

/**
 * Upload a buffer to R2 and return the public URL.
 */
export async function uploadToR2(key: string, body: Buffer, contentType: string): Promise<string> {
  if (!R2_BUCKET || !R2_PUBLIC_URL) throw new Error('R2 not configured');
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Delete an object from R2 by key. Safe to call with any URL — extracts the key.
 */
export async function deleteFromR2(urlOrKey: string): Promise<void> {
  if (!R2_BUCKET) return;
  // If it's a full URL, strip the public prefix to get the key
  const key = urlOrKey.startsWith(R2_PUBLIC_URL || '___')
    ? urlOrKey.slice((R2_PUBLIC_URL || '').length + 1) // +1 for the slash
    : urlOrKey;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (err) {
    console.warn(`R2 delete failed for ${key}:`, err);
  }
}

/**
 * Generate a temporary signed URL (valid 1 hour) for private R2 objects.
 * Used so the bucket can stay non-public while the browser still loads images.
 */
export async function signR2Url(key: string): Promise<string> {
  if (!R2_BUCKET) throw new Error('R2 not configured');
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return getSignedUrl(r2, cmd, { expiresIn: 3600 });
}

/**
 * Extract the R2 object key from a stored URL (public or signed).
 * Handles: https://pub-xxx.r2.dev/key, https://<bucket>.r2.cloudflarestorage.com/key
 */
export function r2KeyFromUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/(compressed_[^/?]+|original_[^/?]+)(?:\?|$)/);
  return m ? m[1] : null;
}
