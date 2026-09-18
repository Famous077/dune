/**
 * Source files for the drawer, read back from the snapshot the indexer uploaded to S3.
 */

import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

/** The file's text, or null when the snapshot has no such object. */
export async function readSnapshotFile(repoId: string, path: string): Promise<string | null> {
  const bucket = process.env['REPO_BUCKET'];
  if (bucket === undefined || bucket === '') throw new Error('REPO_BUCKET is not set');

  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${repoId}/${path}` }));
    return (await object.Body?.transformToString('utf-8')) ?? null;
  } catch (err) {
    if (err instanceof NoSuchKey) return null;
    throw err;
  }
}
