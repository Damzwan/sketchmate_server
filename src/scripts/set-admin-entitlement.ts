import 'dotenv/config';
import * as admin from 'firebase-admin';
import { loadServiceAccount } from '../firebase-credential';

const args = process.argv.slice(2);
const selector = args[0];
const explicitSelector = selector === '--uid' || selector === '--email';
const identifier = (explicitSelector ? args[1] : args[0])?.trim();
const action = (explicitSelector ? args[2] : args[1])?.trim() || 'grant';
const lookup = selector === '--email'
  ? 'email'
  : selector === '--uid'
    ? 'uid'
    : identifier?.includes('@')
      ? 'email'
      : 'uid';

if (!identifier || !['grant', 'revoke'].includes(action)) {
  console.error([
    'Usage:',
    '  pnpm admin:entitle --uid <firebase-auth-uid> [grant|revoke]',
    '  pnpm admin:entitle --email <firebase-email> [grant|revoke]',
    '  pnpm admin:entitle <firebase-uid-or-email> [grant|revoke]'
  ].join('\n'));
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount() as any)
});

async function main() {
  const auth = admin.auth();
  const record = lookup === 'email'
    ? await auth.getUserByEmail(identifier!)
    : await auth.getUser(identifier!);

  const claims = { ...(record.customClaims || {}) };
  if (action === 'grant') claims.sketchmate_admin = true;
  else delete claims.sketchmate_admin;

  await auth.setCustomUserClaims(record.uid, claims);
  console.log(`${action === 'grant' ? 'Granted' : 'Revoked'} sketchmate_admin.`);
  console.log(`Firebase UID: ${record.uid}`);
  console.log(`Email: ${record.email || 'none'}`);
  console.log('Existing browser sessions must refresh their ID token or sign in again.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => admin.app().delete());
