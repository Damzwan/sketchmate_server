import 'dotenv/config';
import mongoose from 'mongoose';
import { user_model } from '../models/user.model';

/**
 * One-off: strip `migration_version` from every user so the v1 migration
 * (see migrationGrants in helper.ts) re-runs on their next GET /user.
 *
 *   pnpm ts-node src/scripts/reset-migration-version.ts
 *
 * The `migration_version_1` index stays valid — $unset just leaves those docs
 * with no indexed value (they re-index once the field is re-set by the
 * migration). No need to drop it.
 */
async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');

  await mongoose.connect(url, { dbName: 'prod' });
  console.log('connected');

  const res = await user_model.updateMany(
    { migration_version: { $exists: true } },
    { $unset: { migration_version: '' } }
  );

  console.log(`matched ${res.matchedCount}, cleared ${res.modifiedCount}`);

  await mongoose.disconnect();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
