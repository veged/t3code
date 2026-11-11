import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { parseSourceCraftFailure } from "./SourceCraftCli.ts";
import { commentAnchor, statusFilter } from "./SourceCraftPullRequestProvider.ts";
import { parseReference, repositoryFromRemoteUrl } from "./SourceCraftSourceControlProvider.ts";
import {
  CommentSchema,
  FilesSchema,
  MergeChecksSchema,
  mergeability,
  PullRequestSchema,
  reviewDecision,
  checksState,
  fileStats,
  toActivity,
  toChecks,
  toPatch,
  toPullRequest,
} from "./sourceCraftJson.ts";

const decodePullRequest = Schema.decodeUnknownEffect(PullRequestSchema);
const decodeMergeChecks = Schema.decodeUnknownEffect(MergeChecksSchema);
const decodeFiles = Schema.decodeEffect(FilesSchema);
const decodeComments = Schema.decodeEffect(Schema.Array(CommentSchema));

const pullRequest = (fields: Record<string, unknown> = {}) => ({
  slug: "50",
  title: "Greeting",
  description: "Body",
  status: "open",
  author: { id: "u1", slug: "maria" },
  source_branch: "greeting",
  target_branch: "main",
  source: { label: "team/repo:greeting", ref: "greeting", sha: "abc" },
  created_at: "2026-10-14T15:41:14Z",
  updated_at: "2026-11-08T11:22:20Z",
  labels: [],
  repository: { id: "r1", slug: "repo", organization: { id: "o1", slug: "team" } },
  ...fields,
});

it.effect("reads a pull request's state, draft flag, and the repository its head is in", () =>
  Effect.gen(function* () {
    const read = (fields: Record<string, unknown>) =>
      decodePullRequest(pullRequest(fields)).pipe(
        Effect.map((raw) => toPullRequest(raw, "asked/repo")),
      );

    expect(yield* read({})).toMatchObject({
      number: 50,
      url: "https://sourcecraft.dev/team/repo/pr/50",
      state: "open",
      isDraft: false,
      author: { login: "maria", name: null, avatarUrl: null },
      headSha: "abc",
      headRepository: "team/repo",
      repository: "team/repo",
    });
    for (const [status, state, isDraft] of [
      ["draft", "open", true],
      ["merging", "open", false],
      ["merged", "merged", false],
      ["discarded", "closed", false],
    ] as const)
      expect(yield* read({ status })).toMatchObject({ state, isDraft });
    expect(
      yield* read({ source: { label: "fork/repo:greeting" }, repository: null }),
    ).toMatchObject({ headRepository: "fork/repo", repository: "asked/repo" });
    expect(yield* read({ slug: "not-a-number" })).toBeNull();
  }),
);

it.effect("turns merge checks into checks, mergeability, and a review decision", () =>
  Effect.gen(function* () {
    const checks = yield* decodeMergeChecks({
      status: "failure",
      code_review: { status: "failure", total_approves: 1, need_approves: 2, rules: [] },
      conflicts: { status: "failure", conflicts: ["a.ts"] },
      ci_workflows: [
        { status: "success", run_slug: "135", workflow_slug: "tests" },
        { status: "failed", run_slug: "135", workflow_slug: "lint" },
        { status: "in_progress", run_slug: "", workflow_slug: "deploy" },
        { status: "success", disabled: true, workflow_slug: "off" },
      ],
    });
    const list = toChecks(checks, "team/repo");
    expect(list).toEqual([
      {
        name: "tests",
        status: "success",
        description: null,
        url: "https://sourcecraft.dev/team/repo/cicd/runs/135",
      },
      {
        name: "lint",
        status: "failure",
        description: null,
        url: "https://sourcecraft.dev/team/repo/cicd/runs/135",
      },
      { name: "deploy", status: "pending", description: null, url: null },
    ]);
    expect(checksState(list)).toBe("failing");
    expect(checksState([])).toBeNull();
    expect(mergeability(checks)).toBe("conflicting");
    expect(mergeability({})).toBe("unknown");
    expect(reviewDecision(checks)).toBe("review-required");
    expect(
      reviewDecision({ code_review: { status: "success", total_approves: 2, need_approves: 2 } }),
    ).toBe("approved");
    expect(reviewDecision({})).toBeNull();
    const approval = { reviewers: [{ user: { slug: "bilal" }, review_decision: "approve" }] };
    expect(reviewDecision({ code_review: { status: "success" } }, approval)).toBe("approved");
    // An open thread fails the review check even with the approval given.
    expect(reviewDecision({ code_review: { status: "failure" } }, approval)).toBe(
      "review-required",
    );
    // A block outweighs enough approvals.
    expect(
      reviewDecision(
        { code_review: { status: "success", total_approves: 2, need_approves: 2 } },
        { reviewers: [{ user: { slug: "bilal" }, review_decision: "block" }] },
      ),
    ).toBe("changes-requested");
  }),
);

it.effect("rebuilds git file headers around hunks and counts string line totals", () =>
  Effect.gen(function* () {
    const files = yield* decodeFiles({
      files: [
        {
          filename: "a.ts",
          status: "modified",
          additions: "1",
          deletions: "1",
          patch: "@@ -1 +1 @@\n-a\n+b",
        },
        {
          filename: "new.ts",
          status: "added",
          additions: "1",
          deletions: "0",
          patch: "@@ -0,0 +1 @@\n+x\n",
        },
        {
          filename: "gone.ts",
          status: "removed",
          additions: "0",
          deletions: "1",
          patch: "@@ -1 +0,0 @@\n-x",
        },
        {
          filename: "to.ts",
          previous_filename: "from.ts",
          status: "renamed",
          additions: "0",
          deletions: "0",
        },
        { filename: "image.png", status: "modified", patch: null },
      ],
      next_page_token: "",
    });
    expect(toPatch(files)).toBe(
      [
        "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
        "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n",
        "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
        "diff --git a/from.ts b/to.ts\nrename from from.ts\nrename to to.ts\n",
      ].join(""),
    );
    expect(fileStats(files).slice(0, 2)).toEqual([
      { path: "a.ts", additions: 1, deletions: 1 },
      { path: "new.ts", additions: 1, deletions: 0 },
    ]);
  }),
);

it.effect("threads replies under an anchored comment and leaves the rest as conversation", () =>
  Effect.gen(function* () {
    const comment = (id: string, minute: number, fields: Record<string, unknown> = {}) => ({
      id,
      parent_id: null,
      author: { slug: "maria" },
      body: id,
      created_at: `2026-11-01T10:0${minute}:00Z`,
      updated_at: `2026-11-01T10:0${minute}:00Z`,
      ...fields,
    });
    const activity = toActivity(
      yield* decodeComments([
        comment("reply-2", 4, { parent_id: "reply-1" }),
        comment("inline", 1, {
          is_resolved: true,
          anchor: { path: "a.ts", position: { from: 48, to: 50, side: "target" } },
        }),
        comment("reply-1", 2, { parent_id: "inline", updated_at: "2026-11-01T11:00:00Z" }),
        comment("general", 3),
        comment("general-reply", 5, { parent_id: "general" }),
        comment("deleted", 6, { is_deleted: true }),
        comment("orphan", 7, { parent_id: "missing" }),
      ]),
    );
    expect(activity.reviewThreads).toMatchObject([
      {
        id: "inline",
        path: "a.ts",
        line: 50,
        side: "left",
        isResolved: true,
        isOutdated: false,
        comments: [
          { id: "inline", editedAt: null },
          { id: "reply-1", editedAt: "2026-11-01T11:00:00Z" },
          { id: "reply-2" },
        ],
      },
    ]);
    expect(activity.comments.map((entry) => entry.id)).toEqual([
      "general",
      "general-reply",
      "orphan",
    ]);
  }),
);

it("reads failures src prints for its API and its own commands", () => {
  const failure = (stderr: string, exitCode = 1) =>
    parseSourceCraftFailure({ cwd: "/repo", exitCode, stderr });
  expect(
    failure("src: HTTP 404: entity pull_requests#9 does not exist (request_id: abc)\n").reason,
  ).toBe("not-found");
  expect(failure("src: HTTP 403: forbidden").reason).toBe("forbidden");
  expect(failure("src: HTTP 401: unauthorized").reason).toBe("authentication");
  expect(failure("OPERATION FAILED: Authentication required\n", 4).reason).toBe("authentication");
  expect(failure("OPERATION FAILED: gone\n---\nStatus code: 404 \n", 255).reason).toBe("not-found");
  const refused = failure("src: HTTP 400: branch is protected (request_id: abc)");
  expect(refused.reason).toBeUndefined();
  expect(refused.detail).toBe("SourceCraft request failed: branch is protected");
});

it("maps list states, review positions, references, and remotes onto what the API takes", () => {
  expect(statusFilter("open")).toBe("status=open or status=draft or status=merging");
  expect(statusFilter("open", "hide")).toBe("status=open or status=merging");
  expect(statusFilter("all", "only")).toBe("status=draft");
  expect(statusFilter("closed")).toBe("status=discarded");
  expect(statusFilter("all")).toBeNull();

  expect(
    commentAnchor({ path: "a.ts", body: "x", position: { kind: "added", newLine: 7 } }),
  ).toEqual({ path: "a.ts", position: { from: 7, to: 7, side: "source" } });
  expect(
    commentAnchor({
      path: "a.ts",
      body: "x",
      startPosition: { kind: "deleted", oldLine: 3 },
      position: { kind: "context", oldLine: 5, newLine: 9, side: "left" },
    }),
  ).toEqual({ path: "a.ts", position: { from: 3, to: 5, side: "target" } });

  expect(parseReference("#12")).toEqual({ number: 12 });
  expect(parseReference("https://sourcecraft.dev/team/repo/pr/12/files")).toEqual({
    number: 12,
    repository: "team/repo",
  });
  expect(parseReference("feature/branch")).toBeNull();

  expect(repositoryFromRemoteUrl("https://git@git.sourcecraft.dev/team/repo.git")).toBe(
    "team/repo",
  );
  expect(repositoryFromRemoteUrl("ssh://ssh.sourcecraft.dev/team/repo.git")).toBe("team/repo");
  expect(repositoryFromRemoteUrl("https://git.sourcecraft.dev/team/group/repo.git")).toBeNull();
});
