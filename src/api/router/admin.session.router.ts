import Router from 'koa-router';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';

export const adminSessionRouter = new Router();

adminSessionRouter.use(requireAdminAuth);

adminSessionRouter.get('/', async (ctx) => {
  ctx.body = {
    user: {
      _id: ctx.state.user._id.toString(),
      name: ctx.state.user.name,
      img: ctx.state.user.img
    }
  };
});

export default adminSessionRouter;
