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

function historyFor(config: any) {
  if (config?.history?.length) return config.history;
  const featuredAt = config?.updatedAt ?? config?.createdAt ?? new Date();
  return (config?.artists ?? []).flatMap((entry: any) => entry.user_id ? [{
    user_id: entry.user_id,
    first_featured_at: featuredAt,
    last_featured_at: featuredAt,
    times_featured: 1
  }] : []);
}

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
  const history = historyFor(config);
  const userIds = [
    ...config.artists.flatMap((entry: any) => entry.user_id ? [entry.user_id] : []),
    ...history.map((entry: any) => entry.user_id)
  ];
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
    history: history
      .map((entry: any) => ({
        user_id: entry.user_id.toString(),
        first_featured_at: entry.first_featured_at,
        last_featured_at: entry.last_featured_at,
        times_featured: entry.times_featured ?? 1,
        user: usersById.get(entry.user_id.toString()) ?? null
      }))
      .sort((a: any, b: any) => new Date(b.last_featured_at).getTime() - new Date(a.last_featured_at).getTime()),
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
  const [users, config] = await Promise.all([
    user_model
    .find({ name: { $regex: escaped, $options: 'i' } })
    .select(userFields)
    .sort({ 'stats.posts': -1 })
    .limit(20)
    .lean(),
    artist_highlight_config_model.findOne({ key: 'community' }).select('artists history').lean() as any
  ]);
  const featuredIds = new Set(historyFor(config).map((entry: any) => entry.user_id.toString()));
  ctx.body = {
    users: users.map((user: any) => ({
      ...user,
      previously_featured: featuredIds.has(user._id.toString())
    }))
  };
});

adminArtistHighlightRouter.get('/suggestions', async (ctx) => {
  const days = Math.min(Math.max(Number(ctx.query.days) || 90, 14), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const config = await artist_highlight_config_model.findOne({ key: 'community' }).select('artists history').lean() as any;
  const currentIds = new Set<string>((config?.artists ?? []).map((entry: any) => entry.user_id.toString()));
  const featuredIds = new Set<string>(historyFor(config).map((entry: any) => entry.user_id.toString()));
  const excludedIds = [...new Set<string>([...currentIds, ...featuredIds])].map((id) => new Types.ObjectId(id));

  const activity = await post_model.aggregate([
    {
      $match: {
        status: 'active',
        createdAt: { $gte: since },
        ...(excludedIds.length ? { author_id: { $nin: excludedIds } } : {})
      }
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$author_id',
        recent_posts: { $sum: 1 },
        reactions: { $sum: { $ifNull: ['$total_reactions', 0] } },
        views: { $sum: { $ifNull: ['$views', 0] } },
        latest_post_at: { $first: '$createdAt' },
        preview_posts: {
          $push: {
            _id: '$_id',
            thumbnail_url: '$thumbnail_url',
            image_url: '$image_url'
          }
        }
      }
    },
    {
      $addFields: {
        preview_posts: { $slice: ['$preview_posts', 3] },
        discovery_score: {
          $add: [
            { $multiply: ['$recent_posts', 12] },
            { $multiply: ['$reactions', 3] },
            { $min: [{ $divide: ['$views', 20] }, 100] }
          ]
        }
      }
    },
    { $sort: { discovery_score: -1, latest_post_at: -1 } },
    { $limit: 36 }
  ]);

  const users = await user_model
    .find({ _id: { $in: activity.map((item: any) => item._id) } })
    .select(userFields)
    .lean();
  const usersById = new Map(users.map((user: any) => [user._id.toString(), user]));

  ctx.body = {
    days,
    suggestions: activity.flatMap((item: any) => {
      const user = usersById.get(item._id.toString());
      return user ? [{
        ...user,
        recent_posts: item.recent_posts,
        reactions: item.reactions,
        views: item.views,
        latest_post_at: item.latest_post_at,
        preview_posts: item.preview_posts
      }] : [];
    })
  };
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
  if (new Set(cleanArtists.map((entry: any) => entry.user_id)).size !== cleanArtists.length) {
    return ctx.throw(400, 'An artist can only appear once in the current highlight');
  }

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

  const existing = await artist_highlight_config_model.findOne({ key: 'community' }).lean() as any;
  const previousCurrentIds = new Set((existing?.artists ?? []).map((entry: any) => entry.user_id.toString()));
  const now = new Date();
  const history: any[] = historyFor(existing).map((entry: any) => ({
    user_id: entry.user_id,
    first_featured_at: entry.first_featured_at,
    last_featured_at: entry.last_featured_at,
    times_featured: entry.times_featured ?? 1
  }));
  const historyById = new Map<string, any>(history.map((entry: any) => [entry.user_id.toString(), entry]));
  for (const entry of cleanArtists) {
    if (previousCurrentIds.has(entry.user_id)) continue;
    const previous = historyById.get(entry.user_id);
    if (previous) {
      previous.last_featured_at = now;
      previous.times_featured += 1;
    } else {
      const historyEntry = {
        user_id: new Types.ObjectId(entry.user_id),
        first_featured_at: now,
        last_featured_at: now,
        times_featured: 1
      };
      history.push(historyEntry);
      historyById.set(entry.user_id, historyEntry);
    }
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
        history,
        updated_by: ctx.state.user._id
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  ctx.body = { config: await hydratedConfig() };
});

export default adminArtistHighlightRouter;
