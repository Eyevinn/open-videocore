// Result store on an S3-compatible bucket (the OSC object-storage service is MinIO). Same keys as the file
// store: results/by-commit/<commit>.json and results/latest.json, which the promote workflow reads.
// Contract: @aws-sdk/client-s3 3.1147.0 exports S3Client, GetObjectCommand, PutObjectCommand
// (checked with `typeof` on the installed package). A missing key surfaces as name "NoSuchKey" / HTTP 404.
import { assertCommit } from '../lib/commit.mjs';

/**
 * @param {{ bucket: string, endpoint?: string, region?: string, accessKeyId?: string, secretAccessKey?: string, client?: { send(cmd: any): Promise<any> }, sdk?: any }} opts
 */
export async function s3Store({ bucket, endpoint, region = 'us-east-1', accessKeyId, secretAccessKey, client, sdk }) {
  const mod = sdk ?? await import('@aws-sdk/client-s3');
  const s3 = client ?? new mod.S3Client({
    region,
    endpoint,
    forcePathStyle: true, // MinIO and other S3-compatible stores address buckets by path
    credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
  });
  const key = (commit) => `results/by-commit/${assertCommit(commit)}.json`;
  const put = (Key, record) => s3.send(new mod.PutObjectCommand({ Bucket: bucket, Key, Body: JSON.stringify(record, null, 2), ContentType: 'application/json' }));
  return {
    async get(commit) {
      try {
        const out = await s3.send(new mod.GetObjectCommand({ Bucket: bucket, Key: key(commit) }));
        return JSON.parse(await out.Body.transformToString());
      } catch (e) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return undefined;
        throw e;
      }
    },
    async put(commit, record) {
      await put(key(commit), record);
      await put('results/latest.json', record);
    },
  };
}
