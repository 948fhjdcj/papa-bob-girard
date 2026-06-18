import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = 'papa-bob-photos';

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('\nMissing environment variables. Set these before running:\n');
  console.error('  export R2_ACCOUNT_ID=your_account_id');
  console.error('  export R2_ACCESS_KEY_ID=your_r2_access_key');
  console.error('  export R2_SECRET_ACCESS_KEY=your_r2_secret_key');
  console.error('\nFind these at: Cloudflare Dashboard > R2 > Manage R2 API Tokens > Create Token\n');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fixRotation(key) {
  try {
    const getRes = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    const buffer = await streamToBuffer(getRes.Body);
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const orientation = metadata.orientation || 1;

    if (orientation === 1 || orientation === undefined) {
      console.log(`[SKIP] ${key} (already correct)`);
      return { status: 'skipped' };
    }

    const rotated = await image.rotate().jpeg({ quality: 90 }).toBuffer();
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Body: rotated, ContentType: 'image/jpeg' }));
    console.log(`[FIXED] ${key} (orientation ${orientation} -> corrected)`);
    return { status: 'fixed' };
  } catch (err) {
    console.error(`[ERROR] ${key}: ${err.message}`);
    return { status: 'error', error: err.message };
  }
}

async function main() {
  console.log('Starting EXIF rotation fix for all R2 photos...\n');
  let continuationToken;
  const allKeys = [];

  do {
    const listRes = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, ContinuationToken: continuationToken }));
    for (const obj of listRes.Contents || []) {
      if (obj.Key.match(/\.(jpg|jpeg)$/i)) allKeys.push(obj.Key);
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  console.log(`Found ${allKeys.length} photos to check.\n`);
  const results = { fixed: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < allKeys.length; i += 10) {
    const batch = allKeys.slice(i, i + 10);
    const batchResults = await Promise.all(batch.map(fixRotation));
    for (const r of batchResults) {
      if (r.status === 'fixed') results.fixed++;
      else if (r.status === 'skipped') results.skipped++;
      else results.errors++;
    }
    console.log(`Progress: ${Math.min(i + 10, allKeys.length)} / ${allKeys.length}`);
  }

  console.log('\n=== ROTATION FIX COMPLETE ===');
  console.log(`Fixed:   ${results.fixed}`);
  console.log(`Skipped: ${results.skipped}`);
  console.log(`Errors:  ${results.errors}`);
}

main().catch(console.error);
