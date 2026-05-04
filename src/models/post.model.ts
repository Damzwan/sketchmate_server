import mongoose, { Schema } from 'mongoose';

const post_schema = new Schema({
  author_id: { type: String, required: true, index: true },
  drawing_url: { type: String, required: true },
  image_url: { type: String, required: true },
  thumbnail_url: { type: String, required: true },
  aspect_ratio: { type: Number, required: true },
  description: { type: String, required: false },
  reactions: { type: Map, of: [String], default: {} },

  comment_count: { type: Number, default: 0 },
  reports_count: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'under_review', 'removed'], default: 'active' }

}, { timestamps: true }); // Automatically adds createdAt and updatedAt

// Index for the feed query (finding active posts by specific authors quickly)
post_schema.index({ author_id: 1, status: 1, createdAt: -1 });


const post_comment_schema = new Schema({
  post_id: { type: String, required: true, index: true },
  author_id: { type: String, required: true },
  message: { type: String, required: true }
}, { timestamps: true });

export const post_model = mongoose.model('posts', post_schema);
export const post_comment_model = mongoose.model('post_comments', post_comment_schema);