import { FBNotification } from '../types/notification.type';
import { NotificationType } from '../types/types';

export const matchNotification = (mateName: string): FBNotification => {
  return {
    notification: {
      title: `You became friends with ${mateName}`,
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
