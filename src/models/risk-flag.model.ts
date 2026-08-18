import mongoose, { Schema } from 'mongoose';

/**
 * RISK FLAGS — output of the nightly behavioural sweep.
 *
 * Deliberately NOT written into `reports`. A report means "a human saw this and
 * objected", and the whole moderation system leans on that: reporter trust is
 * computed from a reporter's history, and the evidence dossier counts
 * `distinct_reporters` as a severity signal. Filing machine output as a report
 * would fabricate a reporter, poison the trust maths, and inflate the very
 * number a moderator uses to judge how many real people complained.
 *
 * So flags live here, in their own queue, and say plainly what they are: a
 * pattern worth a human's attention, not an accusation.
 *
 * Nothing here is enforcement. A flag never restricts anyone — it only decides
 * whose name appears on a list a person reads.
 */
const riskFlagSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'users', required: true, index: true },

    /** Which detector fired. See RULES in services/riskSweep.service.ts. */
    rule: { type: String, required: true },
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },

    /** Human-readable one-liner rendered straight into the admin queue. */
    summary: { type: String, required: true },

    /**
     * The numbers that made the rule fire, frozen at sweep time. Kept because
     * the underlying behaviour keeps moving — without this you cannot tell, a
     * week later, whether a flag was marginal or blatant.
     */
    metrics: { type: Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ['open', 'reviewed', 'dismissed'],
      default: 'open',
      index: true
    },
    resolved_by: { type: Schema.Types.ObjectId, ref: 'users' },
    resolved_at: { type: Date }
  },
  { timestamps: true }
);

// The sweep runs nightly over the same population, so the same account trips
// the same rule night after night. One OPEN flag per user per rule; re-running
// refreshes its metrics instead of stacking duplicates.
riskFlagSchema.index(
  { user_id: 1, rule: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);
riskFlagSchema.index({ status: 1, severity: 1, createdAt: -1 });

export const risk_flag_model = mongoose.model('risk_flags', riskFlagSchema);
