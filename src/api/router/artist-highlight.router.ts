import Router from 'koa-router';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/auth';
import { artist_highlight_config_model } from '../../models/artist-highlight.model';
import { post_model, post_reaction_model } from '../../models/post.model';
import { user_model } from '../../models/user.model';
import { requireAdultAccount } from '../services/parental.service';

export const artistHighlightRouter = new Router();

const AGE_MESSAGE = 'Artist highlights are available from age 13.';

artistHighlightRouter.get(
  '/',
  requireAuth,
  requireAdultAccount(AGE_MESSAGE),
  async (ctx) => {
    const config = await artist_highlight_config_model
      .findOne({ key: 'community', enabled: true })
      .lean() as any;

    if (!config) {
      ctx.body = null;
      return;
    }

    const curated = (config.artists ?? []).slice(0, config.visible_count);
    const userIds = curated.map((entry: any) => entry.user_id);
    const postIds = curated.flatMap((entry: any) => entry.post_ids ?? []);
    const viewerId = ctx.state.user._id;

    const [users, posts, reactions] = await Promise.all([
      user_model.find({ _id: { $in: userIds } }).select(
        '_id name img customization.themeId customization.fontId customization.fontEffectId ' +
        'customization.worldId customization.effectId customization.decorationId customization.titleId ' +
        'customization.signaturePath customization.signatureViewBox'
      ).lean(),
      post_model.find({ _id: { $in: postIds }, status: 'active' }).lean(),
      post_reaction_model.find({ post_id: { $in: postIds }, user_id: viewerId }).lean()
    ]);

    const usersById = new Map(users.map((user: any) => [user._id.toString(), user]));
    const postsById = new Map(posts.map((post: any) => [post._id.toString(), post]));
    const reactionsByPost = new Map(
      reactions.map((reaction: any) => [reaction.post_id.toString(), reaction.reaction_type])
    );

    const artists = curated.flatMap((entry: any) => {
      const user = usersById.get(entry.user_id.toString()) as any;
      if (!user) return [];

      const author = {
        _id: user._id.toString(),
        name: user.name,
        img: user.img,
        customization: user.customization
      };
      const selectedPosts = (entry.post_ids ?? []).flatMap((postId: Types.ObjectId) => {
        const post = postsById.get(postId.toString()) as any;
        if (!post) return [];

        return [{
          ...post,
          _id: post._id.toString(),
          author_id: post.author_id.toString(),
          author,
          reaction_counts: post.reaction_counts instanceof Map
            ? Object.fromEntries(post.reaction_counts)
            : post.reaction_counts ?? {},
          user_reaction: reactionsByPost.get(post._id.toString()) ?? null,
          comments: [],
          enable_comments: post.enable_comments ?? true,
          enable_remix: post.enable_remix ?? true,
          createdAt: new Date(post.createdAt).toISOString(),
          updatedAt: new Date(post.updatedAt).toISOString()
        }];
      });

      if (!selectedPosts.length) return [];
      const questions = entry.questions?.length
        ? entry.questions.map((item: any) => ({
            _id: item._id.toString(),
            question: item.question,
            answer: item.answer
          }))
        : entry.question && entry.answer
          ? [{ _id: `${entry._id.toString()}-legacy`, question: entry.question, answer: entry.answer }]
          : [];
      if (!questions.length) return [];
      return [{
        _id: entry._id.toString(),
        questions,
        artist: author,
        posts: selectedPosts
      }];
    });

    ctx.set('Cache-Control', 'private, max-age=60');
    ctx.body = {
      title: config.title,
      subtitle: config.subtitle,
      updated_at: config.updatedAt,
      artists
    };
  }
);

artistHighlightRouter.put('/preferences', requireAuth, async (ctx) => {
  const body = ctx.request.body as { enabled?: unknown; snoozed_until?: unknown };
  const update: Record<string, unknown> = {};

  if (typeof body.enabled === 'boolean') {
    update['artist_highlights.enabled'] = body.enabled;
    if (body.enabled) update['artist_highlights.snoozed_until'] = null;
  }

  if (body.snoozed_until === null) {
    update['artist_highlights.snoozed_until'] = null;
  } else if (typeof body.snoozed_until === 'string') {
    const date = new Date(body.snoozed_until);
    const max = Date.now() + 8 * 24 * 60 * 60 * 1000;
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now() || date.getTime() > max) {
      return ctx.throw(400, 'Invalid snooze date');
    }
    update['artist_highlights.snoozed_until'] = date;
  }

  if (!Object.keys(update).length) return ctx.throw(400, 'No valid preference supplied');
  await user_model.updateOne({ _id: ctx.state.user._id }, { $set: update });
  ctx.body = { success: true };
});

export default artistHighlightRouter;
