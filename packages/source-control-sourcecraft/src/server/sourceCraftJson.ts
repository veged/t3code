import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestLabel,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestState,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { changeRequestUrl, WEB_HOST } from "../shared/definition.ts";

const User = Schema.Struct({ slug: Schema.String, id: Schema.optional(Schema.String) });
const Ref = Schema.Struct({
  /** `organization/repository:branch`, which names the fork a head lives in. */
  label: Schema.optional(Schema.String),
  sha: Schema.optional(Schema.String),
});

export const PullRequestSchema = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  author: Schema.optional(Schema.NullOr(User)),
  source_branch: Schema.String,
  target_branch: Schema.String,
  source: Schema.optional(Schema.NullOr(Ref)),
  created_at: Schema.String,
  updated_at: Schema.String,
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          color: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ slug: Schema.String, organization: Schema.Struct({ slug: Schema.String }) }),
    ),
  ),
});

export const PullRequestListSchema = Schema.Struct({
  pull_requests: Schema.optional(Schema.NullOr(Schema.Array(PullRequestSchema))),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
});

export const MergeChecksSchema = Schema.Struct({
  code_review: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        /** `failure` also while a comment awaits resolution, whatever the approval count. */
        status: Schema.optional(Schema.String),
        total_approves: Schema.optional(Schema.Number),
        need_approves: Schema.optional(Schema.Number),
      }),
    ),
  ),
  conflicts: Schema.optional(Schema.NullOr(Schema.Struct({ status: Schema.String }))),
  ci_workflows: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          status: Schema.String,
          disabled: Schema.optional(Schema.Boolean),
          run_slug: Schema.optional(Schema.String),
          workflow_slug: Schema.String,
        }),
      ),
    ),
  ),
});

export const CommentSchema = Schema.Struct({
  id: Schema.String,
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(User)),
  body: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  is_resolved: Schema.optional(Schema.Boolean),
  is_outdated: Schema.optional(Schema.Boolean),
  is_deleted: Schema.optional(Schema.Boolean),
  anchor: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.String,
        position: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              to: Schema.optional(Schema.Number),
              side: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
});

export const CommentListSchema = Schema.Struct({
  pull_request_comments: Schema.optional(Schema.NullOr(Schema.Array(CommentSchema))),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
});

/** The API counts lines as decimal strings. */
const Count = Schema.optional(Schema.Union([Schema.String, Schema.Number]));

export const FilesSchema = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
      status: Schema.String,
      additions: Count,
      deletions: Count,
      /** Hunks only, without a file header. Absent for a binary or oversized file. */
      patch: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ReviewersSchema = Schema.Struct({
  reviewers: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          user: User,
          /** `approve`, `trust`, `block`, or `abstain`; absent until the reviewer decides. */
          review_decision: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

export const UserSchema = Schema.Struct({ username: Schema.String });

export const RepositorySchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  slug: Schema.String,
  organization: Schema.Struct({ slug: Schema.String }),
  clone_url: Schema.Struct({ https: Schema.String, ssh: Schema.String }),
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});

export const AuthStatusSchema = Schema.Struct({
  authenticated: Schema.optional(Schema.Boolean),
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface SourceCraftPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headSha: string | undefined;
  /** Null when the response does not name the repository the head is in. */
  readonly headRepository: string | null;
  readonly baseBranch: string;
  readonly repository: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: ReadonlyArray<PullRequestLabel>;
}

/** SourceCraft reports people by slug alone, with no display name or avatar. */
export const actor = (
  user: { readonly slug: string } | null | undefined,
): PullRequestActor | null =>
  user?.slug.trim() ? { login: user.slug.trim(), name: null, avatarUrl: null } : null;

/** `merging` is still open until the merge lands; `none` and unknown values read as open. */
const stateOf = (status: string): PullRequestState =>
  status === "merged" ? "merged" : status === "discarded" ? "closed" : "open";

/** `repository` is the one asked about, for a response that omits its own. */
export function toPullRequest(
  raw: typeof PullRequestSchema.Type,
  repository: string,
): SourceCraftPullRequest | null {
  const number = Number(raw.slug);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const owner = raw.repository
    ? `${raw.repository.organization.slug}/${raw.repository.slug}`
    : repository;
  const label = raw.source?.label ?? "";
  return {
    number,
    title: raw.title,
    body: raw.description ?? "",
    url: changeRequestUrl(owner, number),
    state: stateOf(raw.status),
    isDraft: raw.status === "draft",
    author: actor(raw.author),
    headBranch: raw.source_branch,
    headSha: raw.source?.sha?.trim() || undefined,
    headRepository: label.includes(":") ? label.slice(0, label.indexOf(":")) : null,
    baseBranch: raw.target_branch,
    repository: owner,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    labels: (raw.labels ?? []).flatMap((entry) =>
      entry.name.trim() ? [{ name: entry.name.trim(), color: entry.color ?? null }] : [],
    ),
  };
}

function checkStatus(status: string): PullRequestCheck["status"] {
  switch (status.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "failed":
    case "error":
      return "failure";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      // A status this build does not know is not yet a verdict.
      return "pending";
  }
}

export function toChecks(
  raw: typeof MergeChecksSchema.Type,
  repository: string,
): ReadonlyArray<PullRequestCheck> {
  return (raw.ci_workflows ?? []).flatMap((workflow) =>
    workflow.disabled || !workflow.workflow_slug.trim()
      ? []
      : [
          {
            name: workflow.workflow_slug.trim(),
            status: checkStatus(workflow.status),
            description: null,
            url: workflow.run_slug
              ? `https://${WEB_HOST}/${repository}/cicd/runs/${workflow.run_slug}`
              : null,
          },
        ],
  );
}

export function checksState(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  if (checks.length === 0) return null;
  if (checks.some((check) => check.status === "failure" || check.status === "cancelled"))
    return "failing";
  return checks.some((check) => check.status === "pending") ? "pending" : "passing";
}

export function mergeability(raw: typeof MergeChecksSchema.Type): PullRequestMergeability {
  const status = raw.conflicts?.status.toLowerCase();
  return status === "success" ? "mergeable" : status === "failure" ? "conflicting" : "unknown";
}

/**
 * A reviewer's `block` stands until withdrawn, whatever the approval count says. A repository
 * that requires no approvals still shows one that was given, and an approval does not count
 * while the review check fails.
 */
export function reviewDecision(
  raw: typeof MergeChecksSchema.Type,
  reviewers: typeof ReviewersSchema.Type = {},
): PullRequestReviewDecision | null {
  const decisions = (reviewers.reviewers ?? []).map((reviewer) => reviewer.review_decision);
  if (decisions.includes("block")) return "changes-requested";
  const needed = raw.code_review?.need_approves ?? 0;
  const approved = decisions.includes("approve") || decisions.includes("trust");
  if (needed <= 0 && !approved) return null;
  return raw.code_review?.status === "success" && (raw.code_review.total_approves ?? 0) >= needed
    ? "approved"
    : "review-required";
}

const count = (value: string | number | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
};

export function fileStats(raw: typeof FilesSchema.Type) {
  return raw.files.map((file) => ({
    path: file.filename,
    additions: count(file.additions),
    deletions: count(file.deletions),
  }));
}

/** SourceCraft returns each file's hunks alone, so the git headers are rebuilt around them. */
export function toPatch(raw: typeof FilesSchema.Type): string {
  return raw.files
    .flatMap((file) => {
      const oldPath = file.previous_filename || file.filename;
      const header = [`diff --git a/${oldPath} b/${file.filename}`];
      if (file.status === "added") header.push("new file mode 100644");
      if (file.status === "removed") header.push("deleted file mode 100644");
      if (oldPath !== file.filename)
        header.push(`rename from ${oldPath}`, `rename to ${file.filename}`);
      if (!file.patch) return oldPath === file.filename ? [] : [header.join("\n")];
      header.push(
        `--- ${file.status === "added" ? "/dev/null" : `a/${oldPath}`}`,
        `+++ ${file.status === "removed" ? "/dev/null" : `b/${file.filename}`}`,
      );
      return [`${header.join("\n")}\n${file.patch.replace(/\n?$/u, "")}`];
    })
    .map((file) => `${file}\n`)
    .join("");
}

type RawComment = typeof CommentSchema.Type;

const threadComment = (comment: RawComment): PullRequestThreadComment => ({
  id: comment.id,
  author: actor(comment.author),
  body: comment.body,
  createdAt: comment.created_at,
  editedAt:
    comment.updated_at && comment.updated_at !== comment.created_at ? comment.updated_at : null,
  url: null,
});

/**
 * A comment anchored to a line starts a review thread and its replies join it. Everything else
 * is conversation, in the order it was written.
 */
export function toActivity(raw: ReadonlyArray<RawComment>): {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
} {
  const live = raw
    .filter((comment) => !comment.is_deleted && comment.id.trim())
    .toSorted((left, right) => left.created_at.localeCompare(right.created_at));
  const byId = new Map(live.map((comment) => [comment.id, comment]));
  const rootOf = (comment: RawComment): RawComment => {
    let root = comment;
    // Bounded by the number of comments, so a parent cycle cannot spin.
    for (let depth = 0; depth < live.length && root.parent_id; depth += 1) {
      const parent = byId.get(root.parent_id);
      if (!parent) break;
      root = parent;
    }
    return root;
  };
  const threads = new Map<string, RawComment[]>();
  const comments: PullRequestComment[] = [];
  for (const comment of live) {
    const root = rootOf(comment);
    if (root.anchor?.path.trim()) {
      threads.set(root.id, [...(threads.get(root.id) ?? []), comment]);
      continue;
    }
    comments.push({
      ...threadComment(comment),
      kind: "issue-comment",
      path: null,
      reviewState: null,
    });
  }
  return {
    comments,
    reviewThreads: [...threads].flatMap(([id, entries]) => {
      const root = byId.get(id);
      const path = root?.anchor?.path.trim();
      if (!root || !path) return [];
      const line = root.anchor?.position?.to;
      return [
        {
          id,
          path,
          line: line !== undefined && Number.isSafeInteger(line) && line > 0 ? line : null,
          side: root.anchor?.position?.side === "target" ? ("left" as const) : ("right" as const),
          isResolved: root.is_resolved === true,
          isOutdated: root.is_outdated === true,
          comments: entries.map(threadComment),
        },
      ];
    }),
  };
}
