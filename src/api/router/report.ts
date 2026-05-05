import { report_model } from '../../models/report.model';
import { post_model } from '../../models/post.model';
import Router from 'koa-router';

export const reportRouter = new Router();

reportRouter.post('/', async (ctx) => {
  const { target_id, target_type, reason } = ctx.request.body;
  const reporter_id = ctx.state.user._id;

  try {
    // 1. Log the report in the database
    await report_model.create({
      reporter_id,
      target_id,
      target_type,
      reason
    });

    // 2. Auto-moderation logic for Posts
    if (target_type === 'post') {
      // Increment the report count atomically and return the updated document
      const updatedPost = await post_model.findByIdAndUpdate(
        target_id,
        { $inc: { reports_count: 1 } },
        { new: true }
      );

      // The Quarantine Threshold: If 3 unique reports are hit, hide it.
      if (updatedPost && updatedPost.reports_count >= 3 && updatedPost.status === 'active') {
        updatedPost.status = 'under_review';
        await updatedPost.save();

        // Note for your frontend ban logic:
        // You could also emit a socket event here, or increment a 'strikes'
        // counter on the author's User model if you want to ban them entirely.
      }
    }
    // You can add similar logic here if target_type === 'comment'

    ctx.status = 200;
    ctx.body = { success: true, message: 'Report submitted successfully' };
  } catch (error) {
    console.error(error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to process report' };
  }
});