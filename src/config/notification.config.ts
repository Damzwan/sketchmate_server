import { FBNotification } from '../types/notification.type';
import { NotificationType } from '../types/types';

// ============================================================
// CURRENT NOTIFICATIONS
// ============================================================
export const balloonMatchNotificationV2 = (
  mateName: string,
  conversation_id: string
): FBNotification => {
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
      type: NotificationType.balloon_match,
      conversation_id
    }
  };
};

export const drawingReceivedNotification = (
  mate_id: string,
  mateName: string,
  drawingImg: string,
  inbox_id: string,
  img?: string,
) => ({
  // A `notification` block is REQUIRED for the OS to display this while the app
  // is backgrounded/killed. Data-only messages are silently dropped by the
  // Capacitor push plugin when the app isn't running, which is why these
  // "sometimes don't trigger" after closing the app. The `data` payload is kept
  // so tap-routing (pushNotificationActionPerformed → data.type) still works.
  notification: {
    title: `${mateName} sent you a drawing`,
    body: 'Tap to view',
    imageUrl: drawingImg
  },
  android: {
    priority: 'high',
    notification: { priority: 'max', channelId: '1' }
  },
  data: {
    type: NotificationType.drawing_received,
    conversation_id: inbox_id,
    sender_name: mateName,
    sender_img: img ?? '',
    image_url: drawingImg,
    message_body: '🎨 Sent a drawing'
  }
});


export const lobbyInvitationNotification = (
  mateName: string,
  mateImg: string,
  lobby_id: string
): FBNotification => ({
  notification: {
    title: `${mateName} invited you to draw`,
    body: 'Tap to join the lobby'
  },
  android: {
    priority: 'high',
    notification: { priority: 'max', channelId: '1' }
  },
  data: {
    type: NotificationType.lobby_invitation,
    lobby_id,
    sender_name: mateName,
    sender_img: mateImg
  }
});

export const dmPushNotification = (
  senderId: string,
  senderName: string,
  content: string,
  senderImg: string,
  conversationId: string
) => ({
  notification: {
    title: senderName,
    body: content
  },
  android: {
    priority: 'high',
    notification: { priority: 'max', channelId: '1' }
  },
  data: {
    type: NotificationType.dm_message,
    sender_id: senderId,
    conversation_id: conversationId,
    sender_name: senderName,
    sender_img: senderImg,
    message_body: content
  }
});

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

export const mateRequestPushNotification = (
  senderId: string,
  senderName: string,
  senderImg: string,
  conversation_id: string
) => ({
  notification: {
    title: `${senderName} wants to be your mate`,
    body: 'Tap to view'
  },
  android: {
    priority: 'high',
    notification: { priority: 'max', channelId: '1' }
  },
  data: {
    type: NotificationType.mate_request,
    sender_id: senderId,
    conversation_id,
    sender_name: senderName,
    sender_img: senderImg,
    message_body: 'wants to be your mate'
  }
});

export const requestAcceptedPushNotification = (
  mateName: string,
  mateImg: string,
  conversation_id: string
) => ({
  notification: {
    title: `${mateName} accepted your request`,
    body: 'You have 24 hours to see if you vibe.'
  },
  android: {
    priority: 'high',
    notification: { priority: 'max', channelId: '1' }
  },
  data: {
    type: NotificationType.request_accepted,
    conversation_id,
    sender_name: mateName,
    sender_img: mateImg,
    message_body: 'accepted your request! You have 24 hours to see if you vibe.'
  }
});

// ============================================================
// LEGACY NOTIFICATIONS — to be removed
// ============================================================

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

export const drawingReceivedNotificationV1 = (mate_id: string, mateName: string, drawingImg: string, inbox_id: string): FBNotification => {
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
      type: NotificationType.balloon_match
    }
  };
};