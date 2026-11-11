import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import {
  providerAuth,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { definition, WEB_HOST } from "../shared/definition.ts";

import * as SourceCraftCli from "./SourceCraftCli.ts";
import {
  AuthStatusSchema,
  PullRequestListSchema,
  PullRequestSchema,
  RepositorySchema,
  toPullRequest,
  type SourceCraftPullRequest,
} from "./sourceCraftJson.ts";

const KIND = SourceControlProviderKind.make("sourcecraft");
const isCliError = Schema.is(SourceCraftCli.SourceCraftCliError);
const parseAuthStatus = decodeJsonResult(AuthStatusSchema);

export const discovery = {
  type: "cli",
  kind: KIND,
  label: "SourceCraft",
  executable: "src",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json"],
  parseAuth: (input) => {
    const status = parseAuthStatus(input.stdout);
    return Number(input.exitCode) === 0 && Result.isSuccess(status) && status.success.authenticated
      ? providerAuth({
          status: "authenticated",
          account: status.success.login ?? undefined,
          host: WEB_HOST,
        })
      : providerAuth({
          status: "unauthenticated",
          host: WEB_HOST,
          detail: "Run `src auth login` to sign in to SourceCraft.",
        });
  },
  installHint: SourceCraftCli.INSTALL_HINT,
} satisfies SourceControlCliDiscoverySpec;

/** `organization/repository`, or null for anything that is not exactly two path segments. */
export function repositoryFromRemoteUrl(url: string): string | null {
  const path = SourceControlProvider.repositoryPathFromRemoteUrl(url);
  return path !== null && /^[^/\s]+\/[^/\s]+$/u.test(path) ? path : null;
}

/** A pull request number, from `12`, `#12`, or a pull request URL, which also names its repository. */
export function parseReference(
  reference: string,
): { readonly number: number; readonly repository?: string } | null {
  const trimmed = reference.trim();
  const plain = /^#?(\d+)$/u.exec(trimmed)?.[1];
  if (plain) return { number: Number(plain) };
  const url = URL.parse(trimmed);
  const link = url && definition.parseChangeRequestUrl(url);
  return link ? { number: link.number, repository: link.repository } : null;
}

function toChangeRequest(pullRequest: SourceCraftPullRequest): ChangeRequest {
  const head = pullRequest.headRepository;
  return {
    provider: KIND,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    baseRefName: pullRequest.baseBranch,
    headRefName: pullRequest.headBranch,
    ...(pullRequest.headSha ? { headSha: pullRequest.headSha } : {}),
    state: pullRequest.state,
    ...(pullRequest.isDraft ? { isDraft: true } : {}),
    // SourceCraft reports no merge or close time.
    updatedAt: DateTime.make(pullRequest.updatedAt),
    ...(head === null
      ? {}
      : {
          isCrossRepository: head.toLowerCase() !== pullRequest.repository.toLowerCase(),
          headRepositoryNameWithOwner: head,
          headRepositoryOwnerLogin: head.split("/")[0] ?? null,
        }),
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* SourceCraftCli.SourceCraftCli;
  const fs = yield* FileSystem.FileSystem;
  const { git } = yield* SourceControlHost.SourceControlHost;

  const fail = (cwd: string, detail: string) =>
    new SourceCraftCli.SourceCraftCliError({ cwd, detail });

  const mapError = (operation: string, cwd: string) =>
    Effect.mapError(
      (cause: unknown) =>
        new SourceControlProviderError({
          provider: KIND,
          operation,
          cwd,
          command: "src",
          detail: isCliError(cause) ? cause.detail : "SourceCraft operation failed.",
          cause,
        }),
    );

  const resolveRepository = Effect.fn("SourceCraftSourceControlProvider.resolveRepository")(
    function* (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) {
      const remoteUrl =
        input.context?.remoteUrl ??
        (yield* git
          .resolvePrimaryRemoteName(input.cwd)
          .pipe(Effect.flatMap((name) => git.readConfigValue(input.cwd, `remote.${name}.url`))));
      const repository = remoteUrl ? repositoryFromRemoteUrl(remoteUrl) : null;
      if (repository === null)
        return yield* fail(input.cwd, "Could not resolve the SourceCraft repository remote.");
      return repository;
    },
  );

  const getRepository = (cwd: string, repository: string) =>
    cli
      .api({ cwd, path: SourceCraftCli.repositoryPath(repository) })
      .pipe(Effect.flatMap(SourceCraftCli.decode(cwd, RepositorySchema)));

  const cloneUrls = (raw: typeof RepositorySchema.Type) => ({
    nameWithOwner: `${raw.organization.slug}/${raw.slug}`,
    url: raw.clone_url.https,
    sshUrl: raw.clone_url.ssh,
  });

  const listByBranch = Effect.fn("SourceCraftSourceControlProvider.listByBranch")(function* (
    cwd: string,
    repository: string,
    branch: string,
  ) {
    // The filter language quotes strings and documents no escape, and no branch needs one.
    if (/["\\]/u.test(branch)) return [];
    const query = new URLSearchParams({
      filter: `source_branch="${branch}"`,
      sort_by: "-updated_at",
      page_size: "100",
    });
    const page = yield* cli
      .api({ cwd, path: `${SourceCraftCli.repositoryPath(repository)}/pulls?${query}` })
      .pipe(Effect.flatMap(SourceCraftCli.decode(cwd, PullRequestListSchema)));
    return (page.pull_requests ?? []).flatMap((raw) => toPullRequest(raw, repository) ?? []);
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    repositoryNameFromRemoteUrl: repositoryFromRemoteUrl,
    // Remotes are on `git.` or `ssh.`, and pull requests are keyed under the web host.
    resolveRemoteWebHost: Effect.fn("SourceCraftSourceControlProvider.resolveRemoteWebHost")(() =>
      Effect.succeed(WEB_HOST),
    ),
    listChangeRequests: Effect.fn("SourceCraftSourceControlProvider.listChangeRequests")(
      function* (input) {
        const repository = yield* resolveRepository(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const owner = source?.owner?.toLowerCase();
        const items = (yield* listByBranch(
          input.cwd,
          repository,
          SourceControlProvider.sourceBranch(input),
        )).filter(
          (item) =>
            (input.state === "all" || item.state === input.state) &&
            (owner === undefined ||
              (item.headRepository ?? item.repository).split("/")[0]?.toLowerCase() === owner),
        );
        return items.slice(0, input.limit ?? items.length).map(toChangeRequest);
      },
      (effect, input) => effect.pipe(mapError("listChangeRequests", input.cwd)),
    ),
    getChangeRequest: Effect.fn("SourceCraftSourceControlProvider.getChangeRequest")(
      function* (input) {
        const reference = parseReference(input.reference);
        if (reference === null)
          return yield* fail(
            input.cwd,
            "Specify a pull request number or SourceCraft pull request URL.",
          );
        const repository = reference.repository ?? (yield* resolveRepository(input));
        const raw = yield* cli
          .api({
            cwd: input.cwd,
            path: `${SourceCraftCli.repositoryPath(repository)}/pulls/${reference.number}`,
          })
          .pipe(Effect.flatMap(SourceCraftCli.decode(input.cwd, PullRequestSchema)));
        const pullRequest = toPullRequest(raw, repository);
        if (pullRequest === null)
          return yield* fail(input.cwd, "SourceCraft returned an invalid response.");
        return toChangeRequest(pullRequest);
      },
      (effect, input) => effect.pipe(mapError("getChangeRequest", input.cwd)),
    ),
    createChangeRequest: Effect.fn("SourceCraftSourceControlProvider.createChangeRequest")(
      function* (input) {
        const repository = yield* resolveRepository(input);
        const [organization, name] = repository.split("/");
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const fork =
          source?.owner !== undefined &&
          (source.owner.toLowerCase() !== organization?.toLowerCase() ||
            (source.repository !== undefined && source.repository !== name))
            ? `${source.owner}/${source.repository ?? name}`
            : null;
        yield* cli.api({
          cwd: input.cwd,
          method: "POST",
          path: `${SourceCraftCli.repositoryPath(repository)}/pulls`,
          body: {
            title: input.title,
            description: yield* fs.readFileString(input.bodyFile),
            source_branch: SourceControlProvider.sourceBranch(input),
            target_branch: input.target?.refName ?? input.baseRefName,
            // Left out, the API creates a draft.
            publish: true,
            ...(fork === null ? {} : { fork_repo_id: (yield* getRepository(input.cwd, fork)).id }),
          },
        });
      },
      (effect, input) => effect.pipe(mapError("createChangeRequest", input.cwd)),
    ),
    getRepositoryCloneUrls: Effect.fn("SourceCraftSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        return cloneUrls(yield* getRepository(input.cwd, input.repository));
      },
      (effect, input) => effect.pipe(mapError("getRepositoryCloneUrls", input.cwd)),
    ),
    createRepository: Effect.fn("SourceCraftSourceControlProvider.createRepository")(
      function* (input) {
        const [organization, slug, ...rest] = input.repository.split("/");
        if (!organization || !slug || rest.length > 0)
          return yield* fail(
            input.cwd,
            "Specify a SourceCraft repository as organization/repository.",
          );
        return cloneUrls(
          yield* cli
            .api({
              cwd: input.cwd,
              method: "POST",
              path: `orgs/${encodeURIComponent(organization)}/repos`,
              body: { name: slug, slug, visibility: input.visibility },
            })
            .pipe(Effect.flatMap(SourceCraftCli.decode(input.cwd, RepositorySchema))),
        );
      },
      (effect, input) => effect.pipe(mapError("createRepository", input.cwd)),
    ),
    getDefaultBranch: Effect.fn("SourceCraftSourceControlProvider.getDefaultBranch")(
      function* (input) {
        const repository = yield* resolveRepository(input);
        return (yield* getRepository(input.cwd, repository)).default_branch ?? null;
      },
      (effect, input) => effect.pipe(mapError("getDefaultBranch", input.cwd)),
    ),
    checkoutChangeRequest: Effect.fn("SourceCraftSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const reference = parseReference(input.reference);
        // `src pr checkout` also takes a branch name, which is passed through as written.
        yield* cli.run({
          cwd: input.cwd,
          args: [
            "pr",
            "checkout",
            ...(input.force ? ["--force"] : []),
            "--",
            reference === null ? input.reference : String(reference.number),
          ],
          timeoutMs: 120_000,
        });
      },
      (effect, input) => effect.pipe(mapError("checkoutChangeRequest", input.cwd)),
    ),
  });
});
