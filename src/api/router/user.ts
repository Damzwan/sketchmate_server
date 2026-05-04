import { router } from './router';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';

router.put('/user/follow/:target_id', requireAuth, async (ctx) => {
  const followerId = ctx.state.user._id;
  const targetId = ctx.params.target_id;

  if (followerId === targetId) {
    ctx.status = 400;
    ctx.body = { error: 'You can\'t follow yourself' };
    return;
  }

  // Use a transaction or Promise.all to update both users
  // $addToSet ensures no duplicates if they click twice
  await Promise.all([
    user_model.updateOne({ _id: followerId }, { $addToSet: { following: targetId } }),
    user_model.updateOne({ _id: targetId }, { $addToSet: { followers: followerId } })
  ]);

  ctx.status = 200;
  ctx.body = { success: true };
});