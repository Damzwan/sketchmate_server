import { FBNotification } from '../types/notification.type';
import { NotificationType } from '../types/types';

export const matchNotification = (mateName: string): FBNotification => {
  return {
    notification: {
      title: `You are matched to ${mateName}`,
      body: 'Start drawing now!'
    },
    android: {
      notification: {}
    },
    data: {
      type: NotificationType.match
    }
  };
};

export const unmatchNotification = (mateName: string, mate_id: string, unmatcher: string): FBNotification => {
  return {
    notification: {
      title: `${mateName} unmatched you`,
      body: 'Connect to a new mate'
    },
    android: {
      notification: {}
    },
    data: {
      type: NotificationType.unmatch,
      mate_id,
      unmatcher
    }
  };
};

export const drawingReceivedNotification = (mate_id: string, mateName: string, drawingImg: string, inbox_id: string): FBNotification => {
  return {
    notification: {
      title: `${mateName} sent you a drawing`,
      body: 'Tap to view',
      imageUrl: drawingImg
    },
    data: {
      type: NotificationType.message,
      inbox_id: inbox_id,
      image_url: drawingImg,
      mate_id
    }
  };
};

export const commentReceivedNotification = (mateName: string, inbox_id: string): FBNotification => {
  return {
    notification: {
      title: `${mateName} commented on a drawing`,
      body: 'Tap to view'
    },
    android: {
      notification: {}
    },
    data: {
      type: NotificationType.comment,
      inbox_id: inbox_id
    }
  };
};

export const sendFriendRequestNotification = (senderName: string): FBNotification => {
  return {
    notification: {
      title: `${senderName} sent you a friend request`,
      body: 'Tap to view'
    },
    android: {
      notification: {}
    },
    data: {
      type: NotificationType.friend_request
    }
  };
};
