import { conversation_model } from '../../models/conversation.model';
import { requireAuth } from '../../middleware/auth';
import Router from 'koa-router';
import { message_model } from '../../models/message.model'; // Adjust path

export const chatRouter = new Router();

chatRouter.use(requireAuth);

chatRouter.get('/active', async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  ctx.body = await conversation_model.find({
    participants: user_id,
    status: 'active'
  })
    .populate('last_message')
    .populate('participants', 'name img _id')
    .sort({ updatedAt: -1 })
    .lean();
});

chatRouter.get('/requests', async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  try {
    const requests = await conversation_model.find({
      participants: user_id,
      status: 'pending'
    })
      .populate('last_message')
      .populate('participants', 'name img _id')
      .sort({ updatedAt: -1 })
      .lean();

    ctx.body = requests;
  } catch (error) {
    console.error('Failed to fetch chat requests:', error);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});

chatRouter.get('/:id/messages', async (ctx) => {
  const { id } = ctx.params;
  const { before } = ctx.query; // A timestamp to fetch messages older than this

  const query: any = { conversation_id: id };
  if (before) {
    query.createdAt = { $lt: new Date(before as string) };
  }

  const messages = await message_model
    .find(query)
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  ctx.body = messages.reverse();
});


// POST /chats/:id/read
chatRouter.post('/:id/read', async (ctx) => {
  const user_id = ctx.state.user._id.toString();
  const conversation_id = ctx.params.id;

  await conversation_model.updateOne(
    { _id: conversation_id },
    { $set: { [`unread_counts.${user_id}`]: 0 } }
  );

  ctx.status = 204;
});