import 'dotenv/config';
import mongoose from 'mongoose';
import { post_model, post_comment_model, post_reaction_model } from '../models/post.model';
import { user_model } from '../models/user.model';
import { s3Creator } from '../mongodb';
import { CONTAINER } from '../s3';

async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');

  await mongoose.connect(url, { dbName: 'prod' });
  console.log('Connected to MongoDB');

  // 1. Clean up S3. Since they are nested under 'public-posts/',
  // we can target everything with that prefix.
  console.log('Cleaning up all assets in S3 under "public-posts/"...');
  try {
    // Note: If your custom s3Creator does not have a recursive directory delete,
    // we use its batch delete with any keys we can gather, or you can leverage AWS SDK
    // to list and bulk-delete. Let's gather all keys from active database posts first to be safe:
    const posts = await post_model.find({}).lean();
    const extractKey = (urlStr?: string) => urlStr ? urlStr.split('/').pop() : null;
    const keysToDelete: string[] = [];

    for (const post of posts) {
      const authorId = post.author_id.toString();
      const drawingKey = extractKey(post.drawing_url);
      const imageKey = extractKey(post.image_url);
      const thumbKey = extractKey(post.thumbnail_url);

      if (drawingKey) keysToDelete.push(`public-posts/${authorId}/${drawingKey}`);
      if (imageKey) keysToDelete.push(`public-posts/${authorId}/${imageKey}`);
      if (thumbKey) keysToDelete.push(`public-posts/${authorId}/${thumbKey}`);
    }

    if (keysToDelete.length > 0) {
      // Chunk deletions if you have more than 1000 keys (S3 limit per DeleteObjects call)
      const chunkSize = 1000;
      for (let i = 0; i < keysToDelete.length; i += chunkSize) {
        const chunk = keysToDelete.slice(i, i + chunkSize);
        console.log(`Deleting S3 chunk ${i / chunkSize + 1} (${chunk.length} items)...`);
        await s3Creator.deleteObjects(chunk, CONTAINER.drawings);
      }
      console.log('Successfully removed target assets from S3.');
    } else {
      console.log('No S3 keys found to delete.');
    }
  } catch (s3Err) {
    console.error('Warning: S3 deletion task had an issue:', s3Err);
  }

  // 2. Drop or delete the database collections
  console.log('Purging MongoDB collections...');
  const [postRes, commentRes, reactionRes, userRes] = await Promise.all([
    post_model.deleteMany({}), // Deletes all posts
    post_comment_model.deleteMany({}), // Deletes all comments
    post_reaction_model.deleteMany({}), // Deletes all reactions
    user_model.updateMany({}, { $set: { 'stats.posts': 0 } }) // Resets all users' post stats
  ]);

  console.log(`Deleted ${postRes.deletedCount} posts.`);
  console.log(`Deleted ${commentRes.deletedCount} comments.`);
  console.log(`Deleted ${reactionRes.deletedCount} reactions.`);
  console.log(`Reset post stats for ${userRes.modifiedCount} users.`);

  await mongoose.disconnect();
  console.log('Database and S3 cleanup complete!');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});