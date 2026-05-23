import * as admin from 'firebase-admin';
import { user_model } from '../models/user.model';

export const requireAuth = async (ctx: any, next: () => Promise<any>) => {
  const authHeader = ctx.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized: Missing or invalid token' };
    return;
  }

  const idToken = authHeader.split('Bearer ')[1];
  let decodedToken;

  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch (error) {
    console.error('Firebase Auth Error:', error);
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized: Token expired or invalid' };
    return; // Stop execution here
  }

  try {
    const user = await user_model
      .findOne({ auth_id: decodedToken.uid })
      .select('_id restriction strike_summary subscription_tier img name')
      .lean();

    if (!user) {
      ctx.status = 404;
      ctx.body = { error: 'User not found in database' };
      return;
    }

    ctx.state.user = {
      ...user,
      restriction: user.restriction || {
        level: 0,
        blocked_capabilities: []
      },
      strike_summary: user.strike_summary || {
        active_strikes: 0,
        total_strikes: 0
      }
    };
  } catch (dbError) {
    console.error('Database Auth Error:', dbError);
    ctx.status = 500;
    ctx.body = { error: 'Internal Server Error during authentication' };
    return;
  }

  await next();
};