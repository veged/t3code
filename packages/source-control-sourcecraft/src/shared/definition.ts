import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";

import { icon } from "./icon.ts";

const CHECKOUT_COMMAND = /^src\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pr\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/([^/]+\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;

const KIND = SourceControlProviderKind.make("sourcecraft");

/** The web host. Git is served from `git.` and `ssh.` subdomains of it. */
export const WEB_HOST = "sourcecraft.dev";

const isSourceCraftHost = (hostname: string) =>
  hostname === WEB_HOST || hostname.endsWith(`.${WEB_HOST}`);

/**
 * Remotes name `git.sourcecraft.dev` or `ssh.sourcecraft.dev`, and every link a person sees
 * names `sourcecraft.dev`, so a repository is keyed under the web host.
 */
function repositoryKeyFromRemote(key: string): string | null {
  const path = /^(?:git|ssh)\.sourcecraft\.dev\/(.+)$/iu.exec(key)?.[1];
  return path === undefined ? null : `${WEB_HOST}/${path}`;
}

function canonicalRepositoryKey(key: string): string | null {
  const path = /^(?:(?:git|ssh)\.)?sourcecraft\.dev\/(.+)$/iu.exec(key)?.[1];
  return path === undefined ? null : `${WEB_HOST}/${path}`;
}

export function changeRequestUrl(repository: string, number: number): string {
  return `https://${WEB_HOST}/${repository}/pr/${number}`;
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "SourceCraft",
  pickerLabel: "SourceCraft",
  icon,
  searchKeywords: ["src", "yandex"],
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "organization/repository",
  publicHost: WEB_HOST,
  publishDescription: WEB_HOST,
  publishHost: () => WEB_HOST,
  // Every account has an organization named after it.
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  // `src auth setup-git` gives git an HTTPS credential helper, so no SSH key is needed.
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number, webUrl }) =>
    webUrl ? changeRequestUrlBelow(webUrl, `pr/${number}`) : changeRequestUrl(repository, number),
  parseChangeRequestUrl: (url) =>
    url.hostname.toLowerCase() === WEB_HOST
      ? parseChangeRequestPath(url, CHANGE_REQUEST_PATH)
      : null,
  changeRequestUrlFromReferenceAutolink: () => null,
  // The remote is on a git subdomain, which serves no pages.
  commitUrl: ({ repository, sha, webUrl }) =>
    buildCommitUrl({ host: WEB_HOST, repository, sha, webUrl }, "commit"),
  parseCommitUrl: (url) =>
    url.hostname.toLowerCase() === WEB_HOST ? parseCommitPath(url, COMMIT_PATH) : null,
  changeRequestActions: new Set(["merge", "ready", "draft", "close", "reopen"] as const),
  checkoutCommand: ({ number }) => `src pr checkout ${number}`,
  changeRequestCloseCommand: /\bsrc\s+pr\s+(?:merge|discard)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (reference) => {
    const url = URL.parse(reference);
    return (
      url !== null &&
      url.hostname.toLowerCase() === WEB_HOST &&
      parseChangeRequestPath(url, CHANGE_REQUEST_PATH) !== null
    );
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ hostname }) =>
    isSourceCraftHost(hostname)
      ? { kind: KIND, name: "SourceCraft", baseUrl: `https://${WEB_HOST}` }
      : null,
  repositoryKeyFromRemote,
  canonicalRepositoryKey,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
});
