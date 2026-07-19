import Mixpanel from 'mixpanel';
import { isDev } from './config/app.config';

export enum mixpanelEvents {
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
  unMatch = 'unmatch',
  joinLobby = 'join_lobby',
  inviteLobby = 'invite_lobby',
  messageLobby = 'message_lobby',
  canvasSize = 'canvas_size',
  widget = 'widget',

  // Balloon v2 (Hot Potato) Events
  balloon_v2_receive = 'balloon_v2_receive',   // Triggered when a balloon floats onto a screen
  balloon_v2_refuse = 'balloon_v2_refuse',
  balloon_v2_accept = 'balloon_v2_accept',
  balloon_v2_miss = 'balloon_v2_miss',         // timer expired
  balloon_v2_stop = 'balloon_v2_stop',         // User clicked "Stop receiving balloons"
  balloon_v2_create = 'balloon_v2_create',
  balloon_v2_cancel = 'balloon_v2_cancel',

  // --- v2 Social: Posts ---
  post_v2_publish = 'post_v2_publish',
  post_v2_react = 'post_v2_react',
  post_v2_react_removed = 'post_v2_react_removed',
  post_v2_comment = 'post_v2_comment',
  post_v2_comment_deleted = 'post_v2_comment_deleted',
  post_v2_delete = 'post_v2_delete',

  // --- v2 Social: Relationships ---
  follow_v2 = 'follow_v2',
  unfollow_v2 = 'unfollow_v2',
  mate_request_v2 = 'mate_request_v2',          // sent an upgrade-to-mate request
  mate_request_cancel_v2 = 'mate_request_cancel_v2',
  mate_respond_v2 = 'mate_respond_v2',          // accepted / declined a mate request
  unfriend_v2 = 'unfriend_v2',
  block_v2 = 'block_v2',
}

const mp = Mixpanel.init(process.env.mixpanel_token!, {
  host: 'api-eu.mixpanel.com'
});


export function trackEvent(user_id: string, event: mixpanelEvents, params?: any): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isDev) return;


    mp.track(event, { distinct_id: user_id, ...params }, (err) => {
      if (err) {
        console.error('Mixpanel tracking error:', err);
        reject(err);
      } else {
        console.log('Mixpanel event tracked:', event);
        resolve();
      }
    });
  });
}
