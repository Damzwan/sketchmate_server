import mongoose, { Schema } from 'mongoose';

const artistHighlightQuestionSchema = new Schema({
  question: { type: String, required: true, trim: true, maxlength: 140 },
  answer: { type: String, required: true, trim: true, maxlength: 400 }
}, { _id: true });

const artistHighlightEntrySchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'users', required: true },
  questions: {
    type: [artistHighlightQuestionSchema],
    default: [],
    validate: {
      validator: (questions: unknown[]) => questions.length >= 1 && questions.length <= 6,
      message: 'Add between 1 and 6 questions'
    }
  },
  // Read compatibility for highlights created before multiple Q&As existed.
  // The next dashboard save rewrites these into `questions`.
  question: { type: String, required: false, trim: true, maxlength: 140 },
  answer: { type: String, required: false, trim: true, maxlength: 600 },
  post_ids: {
    type: [{ type: Schema.Types.ObjectId, ref: 'posts' }],
    validate: {
      validator: (ids: unknown[]) => ids.length >= 1 && ids.length <= 4,
      message: 'Choose between 1 and 4 drawings'
    }
  }
}, { _id: true });

const artistHighlightHistorySchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'users', required: true },
  first_featured_at: { type: Date, required: true },
  last_featured_at: { type: Date, required: true },
  times_featured: { type: Number, min: 1, default: 1 }
}, { _id: false });

const artistHighlightConfigSchema = new Schema({
  key: { type: String, required: true, unique: true, default: 'community' },
  enabled: { type: Boolean, default: false },
  title: { type: String, trim: true, maxlength: 60, default: 'Meet the artists' },
  subtitle: {
    type: String,
    trim: true,
    maxlength: 140,
    default: 'A little studio visit with people who make SketchMate special.'
  },
  visible_count: { type: Number, min: 1, max: 12, default: 3 },
  artists: { type: [artistHighlightEntrySchema], default: [] },
  history: { type: [artistHighlightHistorySchema], default: [] },
  updated_by: { type: Schema.Types.ObjectId, ref: 'users', required: false }
}, { timestamps: true });

export const artist_highlight_config_model = mongoose.model(
  'artist_highlight_configs',
  artistHighlightConfigSchema
);
