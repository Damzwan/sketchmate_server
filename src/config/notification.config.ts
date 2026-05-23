import { FBNotification } from '../types/notification.type';
import { NotificationType } from '../types/types';

export const matchNotification = (mateName: string): FBNotification => {
  return {
    notification: {
      title: `You became mates with ${mateName}`,
      body: ''
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.match
    }
  };
};

export const balloonMatchNotification = (mateName: string): FBNotification => {
  return {
    notification: {
      title: `${mateName} accepted your balloon request!`,
      body: 'You can now send drawings to each other'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.match
    }
  };
};

export const balloonAcceptNotification = (): FBNotification => {
  return {
    notification: {
      title: `A stranger accepted your balloon request!`,
      body: 'Accept their balloon to send drawings to each other'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.balloon
    }
  };
};

export const balloonReceivedNotification = (): FBNotification => {
  return {
    notification: {
      title: `You have received a balloon from a stranger`,
      body: 'Open it to become mates'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.balloon
    }
  };
};

export const balloonMatchExpiredNotification = (): FBNotification => {
  return {
    notification: {
      title: `Your balloon has expired`,
      body: 'We will try to match you with someone else'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.balloon
    }
  };
};

export const balloonExpiredNotification = (): FBNotification => {
  return {
    notification: {
      title: `Your balloon has expired`,
      body: 'Please create another one'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.balloon
    }
  };
};

export const otherBalloonExpiredNotification = (): FBNotification => {
  return {
    notification: {
      title: `Your match expired`,
      body: `The other person’s balloon expired, but don’t worry—we’ll pair you with someone new soon!`
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.balloon
    }
  };
};


export const balloonRejectNotification = (): FBNotification => {
  return {
    notification: {
      title: `Someone rejected your balloon request!`,
      body: 'We will try to match you with someone else'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.balloon
    }
  };
};

export const unmatchNotification = (mateName: string, mate_id: string, unmatcher: string): FBNotification => {
  return {
    notification: {
      title: `${mateName} unmatched you`,
      body: ''
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'

      }
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
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
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
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
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
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.friend_request
    }
  };
};

export const lobbyInvitationNotification = (mateName: string, lobby_id: string): FBNotification => {
  return {
    notification: {
      title: `${mateName} invited you to draw together`,
      body: 'Tap to join'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.lobby_invitation,
      lobby_id: lobby_id
    }
  };
};

export const dmPushNotification = (
  senderName: string,
  content: string,
  senderImg: string,
  conversationId: string
): FBNotification => {
  return {
    notification: {
      title: senderName,
      body: content
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.message,
      conversation_id: conversationId,
      sender_name: senderName,
      sender_img: senderImg
    }
  };
};

export const moderationStrikePushNotification = (
  levelName: string,
  description: string
): FBNotification => ({
  notification: {
    title: levelName,
    body: description.slice(0, 140)
  },
  android: {
    priority: 'high',
    notification: { priority: 'max', channelId: '1' }
  },
  data: { type: NotificationType.moderation_strike }
});


export const moderationLiftedPushNotification = (): FBNotification => {
  return {
    notification: {
      title: 'Restriction Lifted',
      body: 'Your account is back in good standing. Welcome back to sketching!'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.moderation_lifted
    }
  };
};

export const requestAcceptedPushNotification = (mateName: string): FBNotification => {
  return {
    notification: {
      title: `${mateName} accepted your request`,
      body: 'You have 24 hours to see if you vibe!'
    },
    android: {
      priority: 'high',
      notification: {
        priority: 'max',
        channelId: '1'
      }
    },
    data: {
      type: NotificationType.message
    }
  };
};

export const mateRequestPushNotification = (senderName: string): FBNotification => ({
  notification: {
    title: senderName,
    body: 'wants to be your mate'
  },
  android: {
    priority: 'high',
    notification: { priority: 'max', channelId: '1' }
  },
  data: { type: NotificationType.friend_request }
});