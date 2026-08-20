import 'dotenv/config';
import mongoose from 'mongoose';

/**
 * Where the 512 MB went. Read-only, writes nothing.
 *
 *   pnpm ts-node src/scripts/report-storage.ts [--db prod]
 *
 * Prints per collection: document count, data size, storage size on disk, and
 * index size, sorted by what they actually occupy. Then every index with its
 * own size and how many times it has been used since the last server restart,
 * because an unused index on a large collection is the cheapest space there is
 * to reclaim — dropping one frees its file immediately.
 *
 * WHY THE DISTINCTION MATTERS ON A SHARED TIER
 *
 * `storageSize` is what Atlas bills and blocks on, `size` is the logical data.
 * When storage is much larger than data, that space is already free INSIDE the
 * files and WiredTiger will reuse it — but it is not given back to the cluster,
 * and `compact` is not available on M0/M2/M5. So on a shared tier, deleting
 * documents does not lift a write block: only dropping a collection or an index
 * (or changing tier) actually returns space.
 */

const argv = process.argv.slice(2);
const DB_NAME = (() => {
  const i = argv.indexOf('--db');
  return i === -1 ? 'prod' : argv[i + 1];
})();

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');
  await mongoose.connect(url, { dbName: DB_NAME, serverSelectionTimeoutMS: 30_000 });
  const db = mongoose.connection.db!;

  const dbStats: any = await db.command({ dbStats: 1, scale: 1 });
  console.log(`\ndb=${DB_NAME}`);
  console.log(`  data:    ${mb(dbStats.dataSize)}`);
  console.log(`  storage: ${mb(dbStats.storageSize)}   <-- what the quota counts`);
  console.log(`  indexes: ${mb(dbStats.indexSize)}`);
  console.log(`  total:   ${mb(dbStats.storageSize + dbStats.indexSize)} of 512 MB`);

  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const rows: any[] = [];

  for (const name of names) {
    try {
      const s: any = await db.command({ collStats: name, scale: 1 });
      rows.push({
        name,
        count: s.count ?? 0,
        size: s.size ?? 0,
        storageSize: s.storageSize ?? 0,
        indexSize: s.totalIndexSize ?? 0,
        indexSizes: s.indexSizes ?? {},
        total: (s.storageSize ?? 0) + (s.totalIndexSize ?? 0)
      });
    } catch {
      // A view, or a collection that vanished mid-run. Not worth failing over.
    }
  }

  rows.sort((a, b) => b.total - a.total);

  console.log('\n── COLLECTIONS (by space on disk) ──');
  console.log(`  ${pad('collection', 28)}${padL('docs', 10)}${padL('data', 12)}${padL('storage', 12)}${padL('indexes', 12)}${padL('total', 12)}`);
  for (const r of rows) {
    console.log(
      `  ${pad(r.name, 28)}${padL(String(r.count), 10)}${padL(mb(r.size), 12)}` +
      `${padL(mb(r.storageSize), 12)}${padL(mb(r.indexSize), 12)}${padL(mb(r.total), 12)}`
    );
  }

  console.log('\n── INDEXES (usage since last restart) ──');
  for (const r of rows) {
    if (r.indexSize < 1024 * 1024) continue; // sub-MB indexes are not the problem
    let usage: any[] = [];
    try {
      usage = await db.collection(r.name).aggregate([{ $indexStats: {} }]).toArray();
    } catch {
      /* $indexStats unavailable — sizes alone still say enough */
    }
    const opsByName = new Map(usage.map((u: any) => [u.name, u.accesses?.ops ?? 0]));

    console.log(`  ${r.name}`);
    for (const [index, bytes] of Object.entries(r.indexSizes as Record<string, number>)) {
      const ops = opsByName.get(index);
      const flag = index !== '_id_' && ops === 0 ? '   <-- never used, droppable' : '';
      console.log(`    ${pad(index, 44)}${padL(mb(bytes), 10)}  ops=${ops ?? '?'}${flag}`);
    }
  }

  console.log('\nread-only — nothing was written.\n');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('\nFAILED:', e);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
