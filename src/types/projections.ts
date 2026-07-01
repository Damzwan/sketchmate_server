export const PUBLIC_USER_FIELDS = [
  '_id',
  'name',
  'img',
  'description', // ADDED: Prevents bio pop-in
  'last_seen_version',
  'stats',
  'customization.themeId',
  'customization.fontId',
  'customization.fontEffectId',
  'customization.effectId',
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