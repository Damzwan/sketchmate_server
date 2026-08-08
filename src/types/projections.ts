export const PUBLIC_USER_FIELDS = [
  '_id',
  'name',
  'img',
  'description', // ADDED: Prevents bio pop-in
  'last_seen_version',
  'stats',
  // Competition wins are a public flex — the trophy row on ProfileCard and the
  // winner badge both read it, so it must ride along with every author payload.
  'competition.wins',
  'customization.themeId',
  'customization.fontId',
  'customization.fontEffectId',
  'customization.effectId',
  'customization.worldId',
  'customization.decorationId',
  'customization.titleId',
  'customization.signaturePath',
  'customization.signatureViewBox'
].join(' ');

export const COMPLETE_PUBLIC_USER_FIELDS = [
  '_id',
  'name',
  'img',
  'description', // ADDED: Prevents bio pop-in
  'last_seen_version',
  'stats',
  'competition.wins',
  'customization.themeId',
  'customization.fontId',
  'customization.fontEffectId',
  'customization.effectId',
  'customization.worldId',
  'customization.decorationId',
  'customization.titleId',
  'customization.signaturePath',
  'customization.signatureViewBox',
  'customization.backgroundSketchPath',
  'customization.backgroundSketchViewBox'
].join(' ');