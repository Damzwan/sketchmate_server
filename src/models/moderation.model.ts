import mongoose, { Schema, Types } from 'mongoose';


const report_schema = new Schema({
  reporter_id: { type: Types.ObjectId, ref: 'users', required: true, index: true },

  // What was reported
  target_id: { type: Types.ObjectId, required: true, index: true },
  target_type: { type: String, required: true, index: true },  // ReportableType
  target_author_id: { type: Types.ObjectId, ref: 'users', required: true, index: true },

  reason: { type: String, required: true },   // ReportReason
  details: { type: String, maxlength: 500 },   // optional free-text

  status: {
    type: String,
    enum: ['pending', 'auto_actioned', 'upheld', 'dismissed'],
    default: 'pending',
    index: true
  },
  resolved_at: Date,
  resolved_by: { type: Types.ObjectId, ref: 'users' },  // null = automated

  content_snapshot: { type: Schema.Types.Mixed }
}, { timestamps: true });

report_schema.index(
  { reporter_id: 1, target_id: 1, target_type: 1 },
  { unique: true }
);

// Mod queue: pending reports newest first
report_schema.index({ status: 1, createdAt: -1 });

// Author lookup: "how many upheld reports does this user have"
report_schema.index({ target_author_id: 1, status: 1, createdAt: -1 });

// Mod queue grouping: the dashboard groups open reports by reported user, and
// resolving one report closes every open report on the same content.
report_schema.index({ status: 1, target_author_id: 1 });
report_schema.index({ target_id: 1, target_type: 1, status: 1 });

export const report_model = mongoose.model('reports', report_schema);


const moderation_action_schema = new Schema({
  user_id: { type: Types.ObjectId, ref: 'users', required: true, index: true },

  action_type: {
    type: String,
    enum: [
      'strike_applied',       // upheld report → +1 strike
      'strike_decayed',       // strike crossed decay window
      'restriction_applied',  // level escalation
      'restriction_lifted',   // duration expired or appeal granted
      'manual_suspension',    // admin pulled the lever directly
      'appeal_granted',
      'appeal_denied',
      // Free-text context an admin attached to an action. MUST NOT be
      // 'strike_applied': recomputeStrikeSummary counts that type, so a note
      // logged under it silently becomes an extra strike.
      'admin_note'
    ],
    required: true
  },

  // For strike_applied / restriction_applied
  level: { type: Number },                     // strike level after this action
  reason: { type: String },                    // ReportReason that triggered it
  source_report_id: { type: Types.ObjectId, ref: 'reports' },

  // For restriction_applied
  expires_at: Date,                            // when the restriction lifts (null = manual review)
  blocked_capabilities: [{ type: String }],    // Capability[] frozen at time of action

  // For manual_suspension / appeal_*
  admin_id: { type: Types.ObjectId, ref: 'users' },
  notes: { type: String, maxlength: 1000 },

  // Set on a strike_applied row when an admin forgives it ahead of the normal
  // 90-day decay. The row is NOT deleted and NOT retyped: the history must keep
  // reading "a strike was applied on this date, for this reason, and was later
  // forgiven". recomputeStrikeSummary excludes forgiven rows from the ACTIVE
  // count only — lifetime total_strikes still counts them, so a repeat offender
  // who has been forgiven twice is still visibly a repeat offender.
  forgiven_at: { type: Date }
}, { timestamps: true });

moderation_action_schema.index({ user_id: 1, createdAt: -1 });
moderation_action_schema.index({ user_id: 1, action_type: 1, createdAt: -1 });

export const moderation_action_model = mongoose.model('moderation_actions', moderation_action_schema);