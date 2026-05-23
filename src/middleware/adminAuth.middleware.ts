import * as admin from 'firebase-admin';
import { Context, Next } from 'koa';
import { user_model } from '../models/user.model';

export const requireAdminAuth = async (ctx: Context, next: Next) => {
  const authHeader = ctx.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return ctx.throw(401, 'Unauthorized: Missing or invalid token');
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    const user = await user_model
      .findOne({ auth_id: decodedToken.uid })
      .select('_id is_admin restriction strike_summary')
      .lean();

    if (!user) return ctx.throw(404, 'User not found');
    if (!user.is_admin) return ctx.throw(403, 'Forbidden: Admin access required');

    // Attach to context for use in routers
    ctx.state.user = {
      ...user,
      restriction: user.restriction || { level: 0 },
      strike_summary: user.strike_summary || { active_strikes: 0, total_strikes: 0 }
    };

    await next();
  } catch (error) {
    ctx.throw(401, 'Unauthorized: Token expired or invalid');
  }
};