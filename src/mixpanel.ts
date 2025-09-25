import { isDev } from './main';

import Mixpanel from 'mixpanel';

export enum mixpanelEvents {
  login = 'login',
  create_account = 'login',
  balloon_create = 'balloon_match',
  balloon_pair = 'balloon_pair',
  balloon_unpaired = 'balloon_unpaired',
  balloon_expired = 'balloon_expired',
  balloon_cancel = 'balloon_cancel',
  balloon_refuse = 'balloon_refuse',
  balloon_accept = 'balloon_accept',
  balloon_match = 'balloon_match',
  drawing_sent = 'drawing_sent',
  drawing_comment = 'drawing_comment',
  drawing_deleted = 'drawing_deleted',
  match = 'match',
  unMatch = 'unmatch'
}

// const mp = Mixpanel.init(process.env.mixpanel_token!, {
//   host: 'api-eu.mixpanel.com'
// });


export function trackEvent(user_id: string, event: mixpanelEvents, params?: any): Promise<void> {
  return new Promise((resolve) => resolve());
  // return new Promise((resolve, reject) => {
  //   if (isDev) return;
  //
  //
  //   mp.track(event, { distinct_id: user_id, ...params }, (err) => {
  //     if (err) {
  //       console.error('Mixpanel tracking error:', err);
  //       reject(err);
  //     } else {
  //       console.log('Mixpanel event tracked:', event);
  //       resolve();
  //     }
  //   });
  // });
}
