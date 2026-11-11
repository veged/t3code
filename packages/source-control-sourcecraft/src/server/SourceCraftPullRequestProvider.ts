import {
  resolvePullRequestAuthorFilter,
  SourceControlProviderKind,
  type PullRequestCapabilities,
  type PullRequestReviewCommentDraft,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestSummary,
  type PullRequestProviderApi,
  type PullRequestProviderFailure,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";

import * as SourceCraftCli from "./SourceCraftCli.ts";
import {
  actor,
  checksState,
  CommentListSchema,
  fileStats,
  FilesSchema,
  MergeChecksSchema,
  mergeability,
  PullRequestListSchema,
  PullRequestSchema,
  reviewDecision,
  ReviewersSchema,
  toActivity,
  toChecks,
  toPatch,
  toPullRequest,
  UserSchema,
  type SourceCraftPullRequest,
} from "./sourceCraftJson.ts";

const KIND = SourceControlProviderKind.make("sourcecraft");

/** Requests for one listing stop here; whatever is left is reported as truncated. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: false,
  reactions: false,
  mentions: false,
  referenceSigils: [],
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  // Reviewers are added by user id, and no endpoint lists who a repository could ask.
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: true },
};

const UNAVAILABLE_REQUIREMENT = {
  missing: `SourceCraft needs its CLI on the server. ${SourceCraftCli.INSTALL_HINT}`,
  unauthenticated: "SourceCraft CLI is signed out on the server. Run `src auth login` there.",
};

/** SourceCraft reports no permissions for the reader, and unreported ones are granted. */
const VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: true,
  resolve: true,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: false,
  editChangeRequest: true,
};

function sourceCraftProviderFailure(
  error: SourceCraftCli.SourceCraftCliError,
): PullRequestProviderFailure {
  switch (error.reason) {
    case "missing-cli":
      return { reason: "missing-tool" };
    case "authentication":
      return { reason: "unauthenticated" };
    case "forbidden":
      return { reason: "forbidden" };
    case "not-found":
      return { reason: "not-found" };
    default:
      return { reason: "failed" };
  }
}

/** The filter language has no grouping, so each state is spelled as one flat expression. */
export function statusFilter(
  state: "all" | "open" | "closed" | "merged",
  draft?: "only" | "hide",
): string | null {
  if (state === "merged") return draft === "only" ? "status=none" : "status=merged";
  if (state === "closed") return draft === "only" ? "status=none" : "status=discarded";
  if (draft === "only") return "status=draft";
  if (state === "open")
    return draft === "hide"
      ? "status=open or status=merging"
      : "status=open or status=draft or status=merging";
  return null;
}

/** A line of the head is on the `source` side and a line only the base has on `target`. */
function anchorPosition(position: PullRequestReviewCommentDraft["position"]) {
  if (position.kind === "added") return { line: position.newLine, side: "source" as const };
  if (position.kind === "deleted") return { line: position.oldLine, side: "target" as const };
  return position.side === "left"
    ? { line: position.oldLine, side: "target" as const }
    : { line: position.newLine, side: "source" as const };
}

export function commentAnchor(draft: PullRequestReviewCommentDraft) {
  const end = anchorPosition(draft.position);
  const start = draft.startPosition === undefined ? end : anchorPosition(draft.startPosition);
  return {
    path: draft.path,
    // A range must stay on one side; one that does not is anchored to its last line.
    position: {
      from: start.side === end.side ? start.line : end.line,
      to: end.line,
      side: end.side,
    },
  };
}

function toChangeRequest(pullRequest: SourceCraftPullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    ...(pullRequest.headRepository === null
      ? {}
      : { headRepositoryNameWithOwner: pullRequest.headRepository }),
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    // A listing carries neither conflict state nor line counts.
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: [],
    labels: pullRequest.labels,
  };
}

function toSummary(pullRequest: SourceCraftPullRequest): ProviderChangeRequestSummary {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    updatedAt: pullRequest.updatedAt,
    ...(pullRequest.headSha ? { headSha: pullRequest.headSha } : {}),
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* SourceCraftCli.SourceCraftCli;

  const fail = (operation: string) => (error: SourceCraftCli.SourceCraftCliError) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      ...sourceCraftProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  const unsupported = (operation: string, detail: string) =>
    Effect.fail(
      new PullRequestProviderError({ provider: KIND, operation, reason: "failed", detail }),
    );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    input: SourceCraftCli.SourceCraftApiInput,
    schema: S,
  ) => cli.api(input).pipe(Effect.flatMap(SourceCraftCli.decode(input.cwd, schema)));

  interface Target {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }
  const pullPath = (input: Target) =>
    `${SourceCraftCli.repositoryPath(input.repository)}/pulls/${input.number}`;

  const getPullRequest = Effect.fn("SourceCraftPullRequestProvider.getPullRequest")(function* (
    input: Target,
    request: Pick<SourceCraftCli.SourceCraftApiInput, "method" | "body"> & {
      readonly route?: string;
    } = {},
  ) {
    const raw = yield* read(
      {
        cwd: input.cwd,
        path: `${pullPath(input)}${request.route ?? ""}`,
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.body === undefined ? {} : { body: request.body }),
      },
      PullRequestSchema,
    );
    const pullRequest = toPullRequest(raw, input.repository);
    if (pullRequest === null)
      return yield* new SourceCraftCli.SourceCraftCliError({
        cwd: input.cwd,
        reason: "invalid-response",
        detail: "SourceCraft returned an invalid response.",
      });
    return pullRequest;
  });

  /** Follows `next_page_token` from `path`, which already carries its other parameters. */
  const readPages = Effect.fn("SourceCraftPullRequestProvider.readPages")(function* <
    S extends Schema.Codec<unknown, unknown, never, never>,
  >(
    cwd: string,
    path: string,
    schema: S,
    nextToken: (page: S["Type"]) => string | null | undefined,
  ) {
    const pages: Array<S["Type"]> = [];
    let token: string | null | undefined;
    do {
      const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (token) query.set("page_token", token);
      const page = yield* read({ cwd, path: `${path}?${query}` }, schema);
      pages.push(page);
      token = nextToken(page);
    } while (token && pages.length < MAX_PAGES);
    return { pages, truncated: Boolean(token) };
  });

  const getFiles = (input: Target) =>
    readPages(
      input.cwd,
      `${pullPath(input)}/files`,
      FilesSchema,
      (page) => page.next_page_token,
    ).pipe(
      Effect.map(({ pages, truncated }) => ({
        files: { files: pages.flatMap((page) => page.files) },
        truncated,
      })),
    );

  const getComments = (input: Target) =>
    readPages(
      input.cwd,
      `${pullPath(input)}/comments`,
      CommentListSchema,
      (page) => page.next_page_token,
    ).pipe(
      Effect.map(({ pages, truncated }) => ({
        ...toActivity(pages.flatMap((page) => page.pull_request_comments ?? [])),
        truncated,
      })),
    );

  const getMergeChecks = (input: Target) =>
    read({ cwd: input.cwd, path: `${pullPath(input)}/merge-checks` }, MergeChecksSchema);

  const getReviewers = (input: Target) =>
    read(
      { cwd: input.cwd, path: `${pullPath(input)}/reviewers?page_size=${PAGE_SIZE}` },
      ReviewersSchema,
    );

  /** For a read the view can do without. A sign-in or missing-CLI failure still fails. */
  const optional = <A>(effect: Effect.Effect<A, SourceCraftCli.SourceCraftCliError>, fallback: A) =>
    Effect.catchIf(
      effect,
      (error) => error.reason !== "authentication" && error.reason !== "missing-cli",
      () => Effect.succeed(fallback),
    );

  const createComment = (input: Target, body: Record<string, unknown>) =>
    cli
      .api({ cwd: input.cwd, method: "POST", path: `${pullPath(input)}/comments`, body })
      .pipe(Effect.asVoid);

  const updateComment = (cwd: string, id: string, body: Record<string, unknown>) =>
    cli
      .api({ cwd, method: "PATCH", path: `pull_comments/id:${encodeURIComponent(id)}`, body })
      .pipe(Effect.asVoid);

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    // `src` signs in once for the whole host, and every request names its repository.
    readsPublicHostWithoutCheckout: true,

    getViewer: (input) =>
      read({ cwd: input.cwd, path: "user" }, UserSchema).pipe(
        Effect.map((user) => user.username),
        Effect.mapError(fail("getViewer")),
      ),

    listChangeRequests: Effect.fn("SourceCraftPullRequestProvider.listChangeRequests")(
      function (input) {
        const query = new URLSearchParams({
          sort_by: "-updated_at",
          page_size: String(input.limit),
        });
        const filter = statusFilter(input.state, input.filters?.draft);
        if (filter !== null) query.set("filter", filter);
        if (input.cursor?.resumeAfter) query.set("page_token", input.cursor.resumeAfter);
        // Only an author id can be filtered on, so authorship is matched on the rows instead.
        const author =
          input.filters?.author === undefined
            ? input.involvement === "authored"
              ? input.viewer
              : undefined
            : resolvePullRequestAuthorFilter(input.filters.author, input.viewer);
        return read(
          {
            cwd: input.cwd,
            path: `${SourceCraftCli.repositoryPath(input.repository)}/pulls?${query}`,
          },
          PullRequestListSchema,
        ).pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((page) => ({
            items: (page.pull_requests ?? [])
              .flatMap((raw) => toPullRequest(raw, input.repository) ?? [])
              .filter(
                (item) =>
                  author === undefined || item.author?.login.toLowerCase() === author.toLowerCase(),
              )
              .map(toChangeRequest),
            truncated: Boolean(page.next_page_token),
            continues: true,
            ...(page.next_page_token ? { resumeAfter: page.next_page_token } : {}),
          })),
        );
      },
    ),

    getChangeRequestChecks: (input) =>
      Effect.all([getPullRequest(input), getMergeChecks(input)], { concurrency: 2 }).pipe(
        Effect.map(([pullRequest, checks]) => ({
          state: pullRequest.state,
          checks: [...toChecks(checks, input.repository)],
        })),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    getChangeRequestSummary: (input) =>
      getPullRequest(input).pipe(
        Effect.map(toSummary),
        Effect.mapError(fail("getChangeRequestSummary")),
      ),

    getChangeRequest: (input) =>
      Effect.all(
        [
          getPullRequest(input),
          optional(getMergeChecks(input), {}),
          optional(getFiles(input), { files: { files: [] }, truncated: true }),
          optional(getReviewers(input), {}),
        ],
        { concurrency: 4 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(([pullRequest, mergeChecks, { files }, reviewers]) => {
          const stats = fileStats(files);
          const checks = toChecks(mergeChecks, input.repository);
          return {
            ...toChangeRequest(pullRequest),
            headSha: pullRequest.headSha ?? null,
            mergeability: mergeability(mergeChecks),
            additions: stats.reduce((sum, file) => sum + file.additions, 0),
            deletions: stats.reduce((sum, file) => sum + file.deletions, 0),
            changedFiles: stats.length,
            body: pullRequest.body,
            // SourceCraft reports no merge or close time.
            mergedAt: null,
            closedAt: null,
            reviewers: (reviewers.reviewers ?? []).flatMap((entry) => actor(entry.user) ?? []),
            reviewRequestLogins: (reviewers.reviewers ?? []).flatMap((entry) =>
              entry.review_decision || !entry.user.slug.trim() ? [] : [entry.user.slug.trim()],
            ),
            reviewDecision: reviewDecision(mergeChecks, reviewers),
            checks: [...checks],
            checksState: checksState(checks),
            // Which strategies a repository allows is not reported; a refused one fails at merge.
            mergeCapabilities: { merge: true, squash: true, rebase: true },
            viewerPermissions: VIEWER_PERMISSIONS,
          };
        }),
      ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          optional(getComments(input), { comments: [], reviewThreads: [], truncated: true }),
          optional(getReviewers(input), {}),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([activity, reviewers]) => ({
          reviewers: (reviewers.reviewers ?? []).flatMap((entry) => actor(entry.user) ?? []),
          comments: activity.comments,
          commentCount: activity.comments.length,
          commentsTruncated: activity.truncated,
          reviewThreads: activity.reviewThreads,
          reviewThreadsTruncated: activity.truncated,
          // No endpoint lists a pull request's commits.
          commits: [],
        })),
      ),

    getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

    getDiff: (input) =>
      input.commit === undefined
        ? getFiles(input).pipe(
            Effect.mapError(fail("getDiff")),
            Effect.map(({ files, truncated }) => ({
              patch: toPatch(files),
              truncated,
              nextCursor: null,
            })),
          )
        : unsupported("getDiff", "SourceCraft does not serve the diff of one commit."),

    getFileStats: (input) =>
      getFiles(input).pipe(
        Effect.mapError(fail("getFileStats")),
        Effect.map(({ files, truncated }) => ({ files: fileStats(files), truncated })),
      ),

    runAction: (input) => {
      if (input.action === "merge")
        // A merge is queued, and only the CLI waits for the queue to finish it.
        return cli
          .run({
            cwd: input.cwd,
            args: [
              "pr",
              "merge",
              String(input.number),
              "--repo",
              input.repository,
              ...(input.mergeMethod === "squash" ? ["--squash"] : []),
              ...(input.mergeMethod === "rebase" ? ["--rebase"] : []),
              "--wait",
            ],
            timeoutMs: 330_000,
          })
          .pipe(Effect.asVoid, Effect.mapError(fail("runAction")));
      const route = (
        { close: "/discard", reopen: "/reopen", ready: "/publish", draft: "/draft" } as const
      )[input.action as "close" | "reopen" | "ready" | "draft"];
      if (route === undefined)
        return unsupported("runAction", `SourceCraft does not support ${input.action}.`);
      return getPullRequest(input, { route, method: "POST", body: {} }).pipe(
        Effect.map(toSummary),
        Effect.mapError(fail("runAction")),
      );
    },

    updateChangeRequest: (input) =>
      cli
        .api({
          cwd: input.cwd,
          method: "PATCH",
          path: pullPath(input),
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { description: input.body }),
          },
        })
        .pipe(Effect.asVoid, Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) =>
      createComment(input, { body: input.body }).pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) =>
      updateComment(input.cwd, input.commentId, { body: input.body }).pipe(
        Effect.mapError(fail("updateComment")),
      ),

    submitReview: Effect.fn("SourceCraftPullRequestProvider.submitReview")(
      function* (input) {
        for (const draft of input.comments)
          yield* createComment(input, { body: draft.body, anchor: commentAnchor(draft) });
        if (input.body.trim()) yield* createComment(input, { body: input.body });
        if (input.verdict !== "comment")
          yield* cli.api({
            cwd: input.cwd,
            method: "POST",
            path: `${pullPath(input)}/decision`,
            body: { review_decision: input.verdict === "approve" ? "approve" : "block" },
          });
      },
      Effect.mapError(fail("submitReview")),
    ),

    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),

    setReviewerRequest: () =>
      unsupported("setReviewerRequest", "SourceCraft reviewers cannot be requested from here."),

    replyToThread: (input) =>
      createComment(input, { body: input.body, parent_id: input.threadId }).pipe(
        Effect.mapError(fail("replyToThread")),
      ),

    setReaction: () => unsupported("setReaction", "SourceCraft reactions are not supported."),

    setThreadResolution: (input) =>
      // A comment that never asked for resolution cannot go straight to resolved.
      updateComment(input.cwd, input.threadId, { resolution_state: "awaiting_resolution" }).pipe(
        input.resolved
          ? Effect.flatMap(() =>
              updateComment(input.cwd, input.threadId, { resolution_state: "resolved" }),
            )
          : (effect) => effect,
        Effect.mapError(fail("setThreadResolution")),
      ),
  };

  return provider;
});
