import fs from 'fs';
import path from 'path';
import { ServiceAccount } from 'firebase-admin';

/**
 * Resolves the Firebase admin service account without the key ever living in
 * this repository.
 *
 * It used to be a plain `import serviceAccount from '../fcm.json'`, which meant
 * the private key had to be committed for a deploy to boot. It was — and it sat
 * in public history for years before being purged. `fcm.json` is now gitignored,
 * so a build from a fresh clone has no such file and that import would crash on
 * startup.
 *
 * Resolution order:
 *   1. FIREBASE_SERVICE_ACCOUNT       — the JSON itself, or base64 of it.
 *   2. GOOGLE_APPLICATION_CREDENTIALS — path to a key file (Google's standard).
 *   3. ./fcm.json next to the repo root — local dev convenience only.
 *
 * On Heroku, set (1). Base64 avoids the newline mangling that plain JSON in a
 * config var is prone to:
 *
 *   base64 -i fcm.json | pbcopy
 *   heroku config:set FIREBASE_SERVICE_ACCOUNT="<paste>" -a <app>
 */
export function loadServiceAccount(): ServiceAccount {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) {
    const raw = inline.trim().startsWith('{')
      ? inline
      : Buffer.from(inline, 'base64').toString('utf8');
    return parse(raw, 'FIREBASE_SERVICE_ACCOUNT');
  }

  const fromPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fromPath) {
    return parse(fs.readFileSync(fromPath, 'utf8'), fromPath);
  }

  // Two candidates because __dirname differs between ts-node (src/) and the
  // compiled build (dist/src/); both should land on the repo root.
  for (const candidate of [
    path.resolve(__dirname, '../fcm.json'),
    path.resolve(__dirname, '../../fcm.json')
  ]) {
    if (fs.existsSync(candidate)) {
      console.warn('Firebase credential loaded from local fcm.json — fine for dev, never for deploys.');
      return parse(fs.readFileSync(candidate, 'utf8'), candidate);
    }
  }

  throw new Error(
    'No Firebase service account found. Set FIREBASE_SERVICE_ACCOUNT (raw JSON or base64), ' +
    'or GOOGLE_APPLICATION_CREDENTIALS, or place fcm.json at the repo root for local dev.'
  );
}

function parse(raw: string, source: string): ServiceAccount {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Firebase service account from ${source} is not valid JSON.`);
  }

  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (!parsed[field]) {
      throw new Error(`Firebase service account from ${source} is missing "${field}".`);
    }
  }

  // Config vars often arrive with "\n" as two literal characters. cert() needs
  // real newlines in the PEM or the OAuth exchange fails with a signature error.
  parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');

  return parsed as ServiceAccount;
}
