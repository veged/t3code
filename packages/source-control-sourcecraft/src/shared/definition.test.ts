import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

describe("SourceCraft definition", () => {
  it("keys git and SSH remotes under the web host", () => {
    for (const key of ["git.sourcecraft.dev/team/repo", "ssh.sourcecraft.dev/team/repo"]) {
      expect(definition.repositoryKeyFromRemote(key)).toBe("sourcecraft.dev/team/repo");
      expect(definition.canonicalRepositoryKey(key)).toBe("sourcecraft.dev/team/repo");
    }
    expect(definition.repositoryKeyFromRemote("sourcecraft.dev/team/repo")).toBeNull();
    expect(definition.canonicalRepositoryKey("git.example.com/team/repo")).toBeNull();
  });

  it("recognizes its remotes and no look-alike host", () => {
    for (const url of [
      "https://git@git.sourcecraft.dev/team/repo.git",
      "ssh://ssh.sourcecraft.dev/team/repo.git",
    ])
      expect(recognizeRemoteWith(definition, url)).toMatchObject({
        kind: "sourcecraft",
        baseUrl: "https://sourcecraft.dev",
      });
    expect(recognizeRemoteWith(definition, "https://notsourcecraft.dev/team/repo.git")).toBeNull();
  });

  it("reads and builds pull request and commit links on the web host only", () => {
    expect(
      definition.parseChangeRequestUrl(new URL("https://sourcecraft.dev/Team/Repo/pr/50/files")),
    ).toEqual({
      host: "sourcecraft.dev",
      repository: "team/repo",
      number: 50,
      repositoryUrl: "https://sourcecraft.dev/Team/Repo",
    });
    expect(
      definition.parseChangeRequestUrl(new URL("https://git.sourcecraft.dev/team/repo/pr/50")),
    ).toBeNull();
    expect(
      definition.parseChangeRequestUrl(new URL("https://sourcecraft.dev/team/repo/issues/50")),
    ).toBeNull();
    // The remote's host serves git only, so links never name it.
    const remote = {
      host: "git.sourcecraft.dev",
      repository: "team/repo",
      remoteUrl: "https://git@git.sourcecraft.dev/team/repo.git",
    };
    expect(definition.changeRequestUrl({ ...remote, number: 50 })).toBe(
      "https://sourcecraft.dev/team/repo/pr/50",
    );
    const sha = "a".repeat(40);
    expect(definition.commitUrl({ ...remote, sha })).toBe(
      `https://sourcecraft.dev/team/repo/commit/${sha}`,
    );
  });
});
