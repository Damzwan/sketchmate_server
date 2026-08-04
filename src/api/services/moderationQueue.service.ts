/**
 * MOD QUEUE — reading it, and acting on it.
 *
 * The dashboard works in groups of reports, not single reports: ten people
 * reporting one balloon is one decision, and a user with six reported posts is
 * one person to judge. Both routers (`/v2/moderation`, `/dev/moderation`) call
 * into here so the queue a moderator sees and the effect of the buttons they
 * press can never drift apart again.
 *
 * Two rules the old per-report endpoints broke:
 *
 *  1. Resolving a report resolves every open report on the SAME content. It was
 *     possible to uphold a report, strike the author, remove the post — and then
 *     find the nine duplicate reports of that same post still sitting in the
 *     queue, each one able to apply another strike for the same offence.
 *
 *  2. A strike is per DECISION, not per report. Bulk-clearing an author applies
 *     exactly one strike, at the severity of their worst report.
 */
import { Types } from 'mongoose';
import { report_model } from '../../models/moderation.model';
import { REPORT_REASONS, ReportReason } from '../../types/moderation.policy';
import { s3Creator } from '../../mongodb';
import {
  applyStrike,
  notifyContentModeration,
  removeContent,
  restoreContent
} from './moderation.service';

// Statuses that mean "still needs a human". Everything else is history.
export const OPEN_STATUSES = ['pending', 'auto_actioned'];

export type ResolveAction = 'uphold' | 'remove_only' | 'dismiss';
export type QueueSort = 'newest' | 'oldest' | 'most_reports' | 'severity';

const MAX_LIMIT = 50;

// reason → weight, as a $switch, so Mongo can rank groups by "worst report in
// the group" without pulling every report into Node first.
const REASON_WEIGHT_BRANCH = {
  $switch: {
    branches: Object.entries(REPORT_REASONS).map(([reason, cfg]) => ({
      case: { $eq: ['$reason', reason] },
      then: cfg.weight
    })),
    default: 0.5
  }
};

const SORT_STAGES: Record<QueueSort, Record<string, 1 | -1>> = {
  newest: { latest_report_at: -1 },
  oldest: { first_report_at: 1 },
  most_reports: { report_count: -1, latest_report_at: -1 },
  severity: { max_weight: -1, report_count: -1, latest_report_at: -1 }
};

export interface QueueParams {
  statuses?: string[];
  page?: number;         // 1-based, pages of AUTHORS — a group is never split
  limit?: number;        // authors per page
  reason?: string;
  targetType?: string;
  search?: string;       // author id
  sort?: QueueSort;
}

/**
 * Query string → QueueParams. Lives here so both routers read the same params;
 * anything unrecognised falls back to the default rather than 400-ing a
 * moderator out of their own dashboard.
 */
export function parseQueueQuery(query: Record<string, any>): QueueParams {
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  return {
    statuses: str(query.status)?.split(',').map(s => s.trim()).filter(Boolean),
    page: Number(query.page) || 1,
    limit: Number(query.limit) || 10,
    reason: str(query.reason),
    targetType: str(query.type),
    search: str(query.author_id),
    sort: str(query.sort) as QueueSort | undefined
  };
}

/**
 * One page of the queue, already grouped by author.
 *
 * Pagination counts AUTHORS, not reports. Paging by report would cut a user's
 * group across a page boundary, which is exactly the context a moderator needs
 * in one place to make a fair call.
 */
export async function getModerationQueue(params: QueueParams) {
  const statuses = params.statuses?.length ? params.statuses : OPEN_STATUSES;
  const page = Math.max(1, Math.floor(params.page || 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(params.limit || 10)));
  const sort = SORT_STAGES[params.sort as QueueSort] ? params.sort as QueueSort : 'newest';

  const match: Record<string, any> = { status: { $in: statuses } };
  if (params.reason) match.reason = params.reason;
  if (params.targetType) match.target_type = params.targetType;
  if (params.search && Types.ObjectId.isValid(params.search)) {
    match.target_author_id = new Types.ObjectId(params.search);
  }

  // Pass 1 — which authors are on this page, and their group-level stats.
  const [grouped] = await report_model.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$target_author_id',
        report_count: { $sum: 1 },
        latest_report_at: { $max: '$createdAt' },
        first_report_at: { $min: '$createdAt' },
        max_weight: { $max: REASON_WEIGHT_BRANCH },
        reasons: { $addToSet: '$reason' },
        target_ids: { $addToSet: '$target_id' }
      }
    },
    {
      $facet: {
        rows: [{ $sort: SORT_STAGES[sort] }, { $skip: (page - 1) * limit }, { $limit: limit }],
        meta: [{ $count: 'total_authors' }]
      }
    }
  ]);

  const rows: any[] = grouped?.rows ?? [];
  const totalAuthors: number = grouped?.meta?.[0]?.total_authors ?? 0;

  const [totalReports, facets] = await Promise.all([
    report_model.countDocuments(match),
    getQueueFacets(statuses)
  ]);

  const pagination = {
    page,
    limit,
    total_authors: totalAuthors,
    total_reports: totalReports,
    pages: Math.max(1, Math.ceil(totalAuthors / limit)),
    has_prev: page > 1,
    has_next: page * limit < totalAuthors
  };
  const filters = {
    statuses,
    reason: params.reason ?? null,
    target_type: params.targetType ?? null,
    sort
  };

  if (!rows.length) return { groups: [] as any[], pagination, filters, facets };

  // Pass 2 — the reports themselves, for this page's authors only.
  const authorIds = rows.map(r => r._id).filter(Boolean);
  const reports = await report_model
    .find({ ...match, target_author_id: { $in: authorIds } })
    .sort({ createdAt: -1 })
    .populate('reporter_id', 'name img')
    .populate('target_author_id', 'name img restriction strike_summary createdAt')
    .populate('resolved_by', 'name')
    .lean();

  await signSnapshots(reports);

  const byAuthor = new Map<string, any[]>();
  for (const report of reports as any[]) {
    const key = String(report.target_author_id?._id ?? report.target_author_id ?? 'deleted_user');
    if (!byAuthor.has(key)) byAuthor.set(key, []);
    byAuthor.get(key)!.push(report);
  }

  const groups = rows.map(row => {
    const key = String(row._id);
    const groupReports = byAuthor.get(key) ?? [];
    const author = (groupReports[0] as any)?.target_author_id;

    return {
      author_id: key,
      // A populated ref comes back as null when the account is gone. The group
      // still has to render — those reports are the only record left of it.
      author: author && typeof author === 'object'
        ? author
        : { _id: key, name: 'Deleted account', img: null },
      report_count: row.report_count,
      // Distinct pieces of content, which is what "remove everything" acts on.
      // Not the same number as report_count whenever content was reported twice.
      target_count: (row.target_ids ?? []).length,
      reasons: row.reasons ?? [],
      severity: severityLabel(row.max_weight ?? 0),
      max_weight: row.max_weight ?? 0,
      latest_report_at: row.latest_report_at,
      first_report_at: row.first_report_at,
      reports: groupReports
    };
  });

  return { groups, pagination, filters, facets };
}

/**
 * Counts for the filter chips and the tab badges.
 *
 * Deliberately unfiltered by the current view: a chip that only counts what is
 * already on screen tells the moderator nothing about what they are not seeing —
 * which is how a backlog goes unnoticed in the first place.
 */
export async function getQueueFacets(statuses: string[]) {
  const [byReason, byType, openCount, resolvedCount] = await Promise.all([
    report_model.aggregate([
      { $match: { status: { $in: statuses } } },
      { $group: { _id: '$reason', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    report_model.aggregate([
      { $match: { status: { $in: statuses } } },
      { $group: { _id: '$target_type', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    report_model.countDocuments({ status: { $in: OPEN_STATUSES } }),
    report_model.countDocuments({ status: { $in: ['upheld', 'dismissed'] } })
  ]);

  return {
    reasons: byReason.map(r => ({ key: r._id, count: r.count })),
    target_types: byType.map(r => ({ key: r._id, count: r.count })),
    open_total: openCount,
    resolved_total: resolvedCount
  };
}

/**
 * Resolve one report — and every other open report on the same content.
 *
 * `uphold` strikes once and removes once no matter how many duplicate reports
 * came in; the duplicates close as upheld alongside it. Without this, each
 * duplicate was its own strike, so a popular piece of bad content could ladder
 * an author straight to Banned for a single offence.
 */
export async function resolveReport(params: {
  reportId: string;
  action: ResolveAction;
  adminId: string;
}) {
  const { reportId, action, adminId } = params;

  const report = await report_model.findById(reportId);
  if (!report) return { ok: false as const, error: 'not_found' };
  if (report.status === 'upheld' || report.status === 'dismissed') {
    return { ok: false as const, error: 'already_resolved' };
  }

  const status = action === 'dismiss' ? 'dismissed' : 'upheld';
  const closed = await closeReportsForTarget({
    targetId: report.target_id,
    targetType: report.target_type,
    status,
    adminId
  });

  const outcome = await applyDecision({
    action,
    targetType: report.target_type,
    targetId: report.target_id.toString(),
    authorId: report.target_author_id.toString(),
    reason: report.reason as ReportReason,
    sourceReportId: report._id.toString(),
    adminId
  });

  return { ok: true as const, reports_closed: closed, ...outcome };
}

/**
 * Clear an author's entire open queue in one decision.
 *
 * This is the "I have looked at all six of these and they are all bad" button.
 * One strike, at the severity of their worst report, and every distinct piece of
 * content actioned once.
 */
export async function resolveAuthorReports(params: {
  authorId: string;
  action: ResolveAction;
  adminId: string;
}) {
  const { authorId, action, adminId } = params;
  if (!Types.ObjectId.isValid(authorId)) return { ok: false as const, error: 'not_found' };

  const open = await report_model
    .find({ target_author_id: new Types.ObjectId(authorId), status: { $in: OPEN_STATUSES } })
    .lean() as any[];

  if (!open.length) return { ok: false as const, error: 'nothing_open' };

  const status = action === 'dismiss' ? 'dismissed' : 'upheld';
  await report_model.updateMany(
    { _id: { $in: open.map(r => r._id) } },
    { $set: { status, resolved_at: new Date(), resolved_by: new Types.ObjectId(adminId) } }
  );

  // The strike, if any, is charged once for the whole batch — at the severity of
  // the worst thing in it.
  const worst = open.reduce((acc, r) => {
    const weight = REPORT_REASONS[r.reason as ReportReason]?.weight ?? 0;
    return weight > acc.weight ? { reason: r.reason as ReportReason, weight, id: r._id } : acc;
  }, { reason: 'other' as ReportReason, weight: -1, id: open[0]._id });

  if (action === 'uphold') {
    await applyStrike({
      userId: authorId,
      reason: worst.reason,
      sourceReportId: String(worst.id),
      adminId
    });
  }

  // Content is actioned per distinct target, not per report.
  const targets = dedupeTargets(open);
  let contentActioned = 0;

  for (const target of targets) {
    const changed = await applyContentSide({
      action,
      targetType: target.target_type,
      targetId: target.target_id,
      authorId
    });
    if (changed) contentActioned++;
  }

  return {
    ok: true as const,
    reports_closed: open.length,
    targets_actioned: contentActioned,
    struck: action === 'uphold',
    strike_reason: action === 'uphold' ? worst.reason : null
  };
}

/**
 * Undo a resolution: content goes back, the report reopens as dismissed.
 * The strike is a separate record and is NOT undone here — clearing that is a
 * standing-level decision, made deliberately from the user's standing page.
 */
export async function restoreReport(params: { reportId: string; adminId: string }) {
  const report = await report_model.findById(params.reportId);
  if (!report) return { ok: false as const, error: 'not_found' };

  const restored = report.target_type === 'user'
    ? false
    : await restoreContent(report.target_type, report.target_id.toString());

  report.status = 'dismissed';
  report.resolved_at = new Date();
  report.resolved_by = new Types.ObjectId(params.adminId) as any;
  await report.save();

  if (restored) {
    await notifyContentModeration({
      authorId: report.target_author_id.toString(),
      type: report.target_type,
      targetId: report.target_id.toString(),
      event: 'restored'
    });
  }

  return { ok: true as const, restored };
}

// =============================================================================
// INTERNALS
// =============================================================================

async function closeReportsForTarget(params: {
  // Mongoose types a bare `type: Types.ObjectId` path as the constructor, not an
  // instance, so the document's own field does not satisfy `Types.ObjectId`.
  targetId: any;
  targetType: string;
  status: 'upheld' | 'dismissed';
  adminId: string;
}) {
  const res = await report_model.updateMany(
    {
      target_id: params.targetId,
      target_type: params.targetType,
      status: { $in: OPEN_STATUSES }
    },
    {
      $set: {
        status: params.status,
        resolved_at: new Date(),
        resolved_by: new Types.ObjectId(params.adminId)
      }
    }
  );
  return res.modifiedCount;
}

async function applyDecision(params: {
  action: ResolveAction;
  targetType: string;
  targetId: string;
  authorId: string;
  reason: ReportReason;
  sourceReportId: string;
  adminId: string;
}) {
  if (params.action === 'uphold') {
    await applyStrike({
      userId: params.authorId,
      reason: params.reason,
      sourceReportId: params.sourceReportId,
      adminId: params.adminId
    });
  }

  const changed = await applyContentSide({
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    authorId: params.authorId
  });

  return { struck: params.action === 'uphold', content_changed: changed };
}

/**
 * The content half of a decision, plus the author-facing notice.
 *
 * `user` targets are an account-level flag with no content behind them —
 * removing nothing and announcing nothing is correct there; applyStrike already
 * speaks for itself.
 */
async function applyContentSide(params: {
  action: ResolveAction;
  targetType: string;
  targetId: string;
  authorId: string;
}): Promise<boolean> {
  if (params.targetType === 'user') return false;

  if (params.action === 'dismiss') {
    const restored = await restoreContent(params.targetType, params.targetId);
    // Most dismissals are of content that was never hidden — saying "it's back"
    // when it never left is worse than saying nothing.
    if (restored) {
      await notifyContentModeration({
        authorId: params.authorId,
        type: params.targetType,
        targetId: params.targetId,
        event: 'restored'
      });
    }
    return restored;
  }

  await removeContent(params.targetType, params.targetId);
  await notifyContentModeration({
    authorId: params.authorId,
    type: params.targetType,
    targetId: params.targetId,
    event: 'removed'
  });
  return true;
}

function dedupeTargets(reports: any[]) {
  const seen = new Map<string, { target_id: string; target_type: string }>();
  for (const r of reports) {
    const key = `${r.target_type}:${r.target_id}`;
    if (!seen.has(key)) {
      seen.set(key, { target_id: String(r.target_id), target_type: r.target_type });
    }
  }
  return [...seen.values()];
}

/**
 * The snapshot bucket is private, so URLs are signed at read time only — a
 * dashboard page is the only place they should ever be valid.
 */
async function signSnapshots(reports: any[]) {
  await Promise.all(reports.map(async (r: any) => {
    if (!r.content_snapshot?.snapshot_url) return;
    const signed = await s3Creator.getSnapshotSignedUrl(r.content_snapshot.snapshot_url);
    if (signed) r.content_snapshot.snapshot_signed_url = signed;
  }));
}

function severityLabel(weight: number): 'critical' | 'high' | 'medium' | 'low' {
  if (weight >= 10) return 'critical';
  if (weight >= 1.5) return 'high';
  if (weight >= 1) return 'medium';
  return 'low';
}
