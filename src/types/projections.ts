export const PUBLIC_USER_FIELDS = [
  '_id',
  'name',
  'img',
  'last_seen_version',
  'subscription_tier',
  'stats',
  'customization.themeId',
  'customization.fontId',
  'customization.fontEffectId',
  'customization.decorationId',
  'customization.effectId',
  'customization.titleId'
].join(' ');


export const FULL_USER_FIELDS = [
  PUBLIC_USER_FIELDS,
  'description',
  'customization.signaturePath',
  'customization.signatureViewBox'
].join(' ');