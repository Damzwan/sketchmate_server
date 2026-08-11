import * as admin from 'firebase-admin';
import { Context, Next } from 'koa';
import { user_model } from '../models/user.model';

export const requireAdminAuth = async (ctx: Context, next: Next) => {
  const authHeader = ctx.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return ctx.throw(401, 'Unauthorized: Missing or invalid token');
  }

  const idToken = authHeader.split('Bearer ')[1];

  let decodedToken: admin.auth.DecodedIdToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(idToken, true);
  } catch {
    return ctx.throw(401, 'Unauthorized: Token expired, revoked, or invalid');
  }

  // Firebase owns the platform entitlement. The MongoDB flag remains a second,
  // independently revocable guard for destructive production operations.
  if (decodedToken.sketchmate_admin !== true) {
    return ctx.throw(403, 'Forbidden: sketchmate_admin entitlement required');
  }

  const user = await user_model
    .findOne({ auth_id: decodedToken.uid })
    .select('_id name img is_admin restriction strike_summary')
    .lean();

  if (!user) return ctx.throw(404, 'Sketchmate administrator profile not found');
  if (!user.is_admin) return ctx.throw(403, 'Forbidden: administrator access has been revoked');

  ctx.state.user = {
    ...user,
    restriction: user.restriction || { level: 0 },
    strike_summary: user.strike_summary || { active_strikes: 0, total_strikes: 0 }
  };

  await next();
};
