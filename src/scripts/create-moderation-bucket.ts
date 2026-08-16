import 'dotenv/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { CONTAINER } from '../s3';

/**
 * Create the moderation snapshot bucket.
 *
 * Report evidence is cloned/uploaded to a bucket that nothing else creates, so
 * on a fresh account every snapshot fails with `NoSuchBucket` and moderators
 * get reports with no picture behind them. The upload path swallows that
 * failure by design (a report must never fail because its evidence didn't
 * upload), which is exactly why it went unnoticed.
 *
 * The bucket is PRIVATE and stays private: it holds material that was reported
 * as abusive, read only through short-lived signed URLs on the dashboard.
 *
 *   pnpm moderation:bucket           # create if missing
 *   pnpm moderation:bucket --check   # report status, change nothing
 */

const REGION = process.env.AWS_REGION;
const BUCKET = CONTAINER.moderation_snapshots;
const CHECK_ONLY = process.argv.includes('--check');
/** Evidence outlives the report it belongs to, but not indefinitely. */
const RETENTION_DAYS = 365;

async function main() {
  if (!REGION || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('Missing AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY');
    process.exit(1);
  }

  const s3 = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  const exists = await bucketExists(s3);
  if (exists) {
    console.log(`✔ ${BUCKET} already exists in ${REGION}`);
    if (CHECK_ONLY) return;
  } else if (CHECK_ONLY) {
    console.log(`✘ ${BUCKET} does NOT exist in ${REGION} — run without --check to create it`);
    return;
  } else {
    await s3.send(
      new CreateBucketCommand({
        Bucket: BUCKET,
        // us-east-1 rejects an explicit location constraint.
        ...(REGION === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: REGION as any } })
      })
    );
    console.log(`✔ created ${BUCKET} in ${REGION}`);
  }

  // Idempotent, and applied even when the bucket already existed: this is the
  // setting that must never drift.
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: BUCKET,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true
      }
    })
  );
  console.log('✔ public access blocked');

  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: BUCKET,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-moderation-snapshots',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            Expiration: { Days: RETENTION_DAYS }
          }
        ]
      }
    })
  );
  console.log(`✔ lifecycle rule set (${RETENTION_DAYS} day expiry)`);
}

async function bucketExists(s3: S3Client): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return true;
  } catch (e: any) {
    const status = e?.$metadata?.httpStatusCode;
    if (status === 404 || e?.name === 'NotFound' || e?.Code === 'NoSuchBucket') return false;
    throw e;
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Bucket setup failed:', e);
    process.exit(1);
  });
