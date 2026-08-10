import Router from 'koa-router';
import { Types } from 'mongoose';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';
import { artist_highlight_config_model } from '../../models/artist-highlight.model';
import { post_model } from '../../models/post.model';
import { user_model } from '../../models/user.model';

export const adminArtistHighlightRouter = new Router();
adminArtistHighlightRouter.use(requireAdminAuth);

const userFields = '_id name img description customization';
const postFields = '_id author_id image_url thumbnail_url aspect_ratio description status createdAt';

async function hydratedConfig() {
  const config = await artist_highlight_config_model.findOne({ key: 'community' }).lean() as any;
  if (!config) {
    return {
      enabled: false,
      title: 'Meet the artists',
      subtitle: 'A little studio visit with people who make SketchMate special.',
      visible_count: 3,
      artists: []
    };
  }
  const userIds = config.artists.flatMap((entry: any) => entry.user_id ? [entry.user_id] : []);
  const postIds = config.artists.flatMap((entry: any) => entry.post_ids ?? []);
  const [users, posts] = await Promise.all([
    user_model.find({ _id: { $in: userIds } }).select(userFields).lean(),
    post_model.find({ _id: { $in: postIds } }).select(postFields).lean()
  ]);
  const usersById = new Map(users.map((user: any) => [user._id.toString(), user]));
  const postsById = new Map(posts.map((post: any) => [post._id.toString(), post]));
  return {
    ...config,
    _id: config._id.toString(),
    artists: config.artists.map((entry: any) => ({
      _id: entry._id.toString(),
      user_id: entry.user_id.toString(),
      questions: entry.questions?.length
        ? entry.questions.map((item: any) => ({
            _id: item._id.toString(),
            question: item.question,
            answer: item.answer
          }))
        : entry.question && entry.answer
          ? [{ _id: `${entry._id.toString()}-legacy`, question: entry.question, answer: entry.answer }]
          : [],
      post_ids: entry.post_ids.map((id: Types.ObjectId) => id.toString()),
      user: usersById.get(entry.user_id.toString()) ?? null,
      posts: entry.post_ids.flatMap((id: Types.ObjectId) => {
        const post = postsById.get(id.toString());
        return post ? [post] : [];
      })
    }))
  };
}

adminArtistHighlightRouter.get('/', async (ctx) => {
  ctx.body = { config: await hydratedConfig() };
});

adminArtistHighlightRouter.get('/users', async (ctx) => {
  const query = String(ctx.query.q ?? '').trim();
  if (query.length < 2) {
    ctx.body = { users: [] };
    return;
  }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const users = await user_model
    .find({ name: { $regex: escaped, $options: 'i' } })
    .select(userFields)
    .sort({ 'stats.posts': -1 })
    .limit(20)
    .lean();
  ctx.body = { users };
});

adminArtistHighlightRouter.get('/users/:user_id/posts', async (ctx) => {
  if (!Types.ObjectId.isValid(ctx.params.user_id)) return ctx.throw(400, 'Invalid user id');
  const posts = await post_model
    .find({ author_id: ctx.params.user_id, status: 'active' })
    .select(postFields)
    .sort({ total_reactions: -1, views: -1, createdAt: -1 })
    .limit(50)
    .lean();
  ctx.body = { posts };
});

adminArtistHighlightRouter.put('/', async (ctx) => {
  const body = ctx.request.body as any;
  const artists = Array.isArray(body.artists) ? body.artists : [];
  const visibleCount = Number(body.visible_count);

  if (!Number.isInteger(visibleCount) || visibleCount < 1 || visibleCount > 12) {
    return ctx.throw(400, 'Visible count must be between 1 and 12');
  }
  if (artists.length > 12) return ctx.throw(400, 'At most 12 artists can be curated');

  const cleanArtists = artists.map((entry: any) => ({
    user_id: String(entry.user_id ?? ''),
    questions: (Array.isArray(entry.questions) ? entry.questions : []).map((item: any) => ({
      question: String(item.question ?? '').trim(),
      answer: String(item.answer ?? '').trim()
    })),
    post_ids: [...new Set((entry.post_ids ?? []).map(String))]
  }));

  for (const entry of cleanArtists) {
    if (!Types.ObjectId.isValid(entry.user_id)) return ctx.throw(400, 'Invalid artist id');
    if (entry.questions.length < 1 || entry.questions.length > 6) return ctx.throw(400, 'Add 1–6 questions for every artist');
    if (entry.questions.some((item: any) => !item.question || item.question.length > 140)) {
      return ctx.throw(400, 'Questions must be 1–140 characters');
    }
    if (entry.questions.some((item: any) => !item.answer || item.answer.length > 400)) {
      return ctx.throw(400, 'Answers must be 1–400 characters');
    }
    if (entry.post_ids.length < 1 || entry.post_ids.length > 4 || entry.post_ids.some((id: string) => !Types.ObjectId.isValid(id))) {
      return ctx.throw(400, 'Choose 1–4 valid drawings for every artist');
    }
    const validPosts = await post_model.countDocuments({
      _id: { $in: entry.post_ids },
      author_id: entry.user_id,
      status: 'active'
    });
    if (validPosts !== entry.post_ids.length) return ctx.throw(400, 'Every drawing must belong to its artist and be active');
  }

  if (body.enabled && artists.length < visibleCount) {
    return ctx.throw(400, 'Add at least as many artists as the visible count before publishing');
  }

  await artist_highlight_config_model.findOneAndUpdate(
    { key: 'community' },
    {
      $set: {
        enabled: Boolean(body.enabled),
        title: String(body.title ?? '').trim().slice(0, 60) || 'Meet the artists',
        subtitle: String(body.subtitle ?? '').trim().slice(0, 140),
        visible_count: visibleCount,
        artists: cleanArtists,
        updated_by: ctx.state.user._id
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  ctx.body = { config: await hydratedConfig() };
});

export default adminArtistHighlightRouter;
