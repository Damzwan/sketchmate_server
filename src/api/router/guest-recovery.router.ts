import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as admin from 'firebase-admin';
import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { guest_recovery_model } from '../../models/guest-recovery.model';
import { user_model } from '../../models/user.model';

export const guestRecoveryRouter = new Router();

const hashSecret = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');

guestRecoveryRouter.post('/register', requireAuth, async (ctx) => {
  if (ctx.state.sign_in_provider !== 'anonymous' || !ctx.state.user) {
    return ctx.throw(403, 'Guest account required');
  }

  const credentialId = randomBytes(18).toString('base64url');
  const secret = randomBytes(32).toString('base64url');

  // A guest identity is device-bound. Rotating here makes a lost response or
  // re-enrollment self-healing without accumulating permanent bearer secrets.
  await guest_recovery_model.deleteMany({ auth_id: ctx.state.auth_id });
  await guest_recovery_model.create({
    credential_id: credentialId,
    auth_id: ctx.state.auth_id,
    secret_hash: hashSecret(secret),
  });

  ctx.set('Cache-Control', 'no-store');
  ctx.body = {
    credentialId,
    secret,
    guestUid: ctx.state.auth_id,
    profileName: ctx.state.user.name,
  };
});

guestRecoveryRouter.post('/redeem', async (ctx) => {
  const credentialId = String(ctx.request.body?.credentialId ?? '');
  const secret = String(ctx.request.body?.secret ?? '');

  if (!credentialId || !secret || credentialId.length > 128 || secret.length > 256) {
    ctx.status = 401;
    ctx.body = { error: 'Guest recovery failed' };
    return;
  }

  const credential = await guest_recovery_model.findOne({ credential_id: credentialId });
  const suppliedHash = Buffer.from(hashSecret(secret), 'hex');
  const storedHash = credential ? Buffer.from(credential.secret_hash, 'hex') : Buffer.alloc(32);
  const matches = storedHash.length === suppliedHash.length && timingSafeEqual(storedHash, suppliedHash);

  if (!credential || !matches) {
    ctx.status = 401;
    ctx.body = { error: 'Guest recovery failed' };
    return;
  }

  const user = await user_model.findOne({ auth_id: credential.auth_id }).select('_id name').lean();
  if (!user) {
    ctx.status = 401;
    ctx.body = { error: 'Guest recovery failed' };
    return;
  }

  const customToken = await admin.auth().createCustomToken(credential.auth_id);
  credential.last_used_at = new Date();
  await credential.save();

  ctx.set('Cache-Control', 'no-store');
  ctx.body = {
    customToken,
    guestUid: credential.auth_id,
    profileName: user.name,
  };
});

guestRecoveryRouter.delete('/:credentialId', requireAuth, async (ctx) => {
  await guest_recovery_model.deleteOne({
    credential_id: ctx.params.credentialId,
    auth_id: ctx.state.auth_id,
  });
  ctx.status = 204;
});
