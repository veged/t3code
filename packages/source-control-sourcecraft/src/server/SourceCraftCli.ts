import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class SourceCraftCliError extends Schema.TaggedError<SourceCraftCliError>()(
  "SourceCraftCliError",
  {
    cwd: Schema.String,
    detail: Schema.String,
    reason: Schema.optional(
      Schema.Literals([
        "missing-cli",
        "authentication",
        "forbidden",
        "not-found",
        "invalid-response",
      ]),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const INSTALL_HINT =
  "Install SourceCraft CLI (`src`) from https://sourcecraft.dev/portal/docs/en/sourcecraft/operations/cli-quickstart and run `src auth login`.";

/** `src` exits with this when it holds no credential. */
const UNAUTHENTICATED_EXIT_CODE = 4;

/**
 * `src api` reports a refused request on stderr as `src: HTTP <status>: <message>`, and its
 * other commands as `OPERATION FAILED: <message>` above a `Status code: <status>` line.
 */
export function parseSourceCraftFailure(input: {
  readonly cwd: string;
  readonly exitCode: number;
  readonly stderr: string;
}): SourceCraftCliError {
  const text = NodeUtil.stripVTControlCharacters(input.stderr);
  const http = /\bHTTP (\d{3}):\s*(.*?)(?:\s*\(request_id:[^)]*\))?\s*$/mu.exec(text);
  const status = Number(http?.[1] ?? /^\s*Status code:\s*(\d{3})\s*$/mu.exec(text)?.[1]);
  const message = http?.[2] || /OPERATION FAILED:\s*(.+?)\s*$/mu.exec(text)?.[1];
  if (input.exitCode === UNAUTHENTICATED_EXIT_CODE || status === 401)
    return new SourceCraftCliError({
      cwd: input.cwd,
      reason: "authentication",
      detail: "Sign in to SourceCraft with `src auth login`.",
    });
  if (status === 403)
    return new SourceCraftCliError({
      cwd: input.cwd,
      reason: "forbidden",
      detail: "SourceCraft denied access. Check this account's permissions in the repository.",
    });
  if (status === 404)
    return new SourceCraftCliError({
      cwd: input.cwd,
      reason: "not-found",
      detail: "SourceCraft repository or pull request was not found.",
    });
  return new SourceCraftCliError({
    cwd: input.cwd,
    detail: message ? `SourceCraft request failed: ${message}` : "SourceCraft CLI command failed.",
  });
}

export interface SourceCraftApiInput {
  readonly cwd: string;
  /** Below `https://api.sourcecraft.tech/`, query string included. */
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
}

export class SourceCraftCli extends Context.Service<
  SourceCraftCli,
  {
    /** Resolves to stdout. */
    readonly run: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<string, SourceCraftCliError>;
    /** An authenticated REST request through `src api`, resolving to the response body. */
    readonly api: (input: SourceCraftApiInput) => Effect.Effect<string, SourceCraftCliError>;
  }
>()("@t3tools/source-control-sourcecraft/server/SourceCraftCli") {}

const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const run: SourceCraftCli["Service"]["run"] = (input) =>
    process
      .run({
        operation: "SourceCraftCli.run",
        command: "src",
        args: input.args,
        cwd: input.cwd,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        allowNonZeroExit: true,
        timeoutMs: input.timeoutMs ?? 30_000,
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceCraftCliError({
              cwd: input.cwd,
              cause,
              ...(cause._tag === "VcsProcessSpawnError"
                ? { reason: "missing-cli" as const, detail: INSTALL_HINT }
                : { detail: "SourceCraft CLI command failed." }),
            }),
        ),
        Effect.flatMap((result) =>
          result.stdoutTruncated
            ? Effect.fail(
                new SourceCraftCliError({
                  cwd: input.cwd,
                  reason: "invalid-response",
                  detail: "SourceCraft CLI returned an oversized response.",
                }),
              )
            : Number(result.exitCode) === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(
                  parseSourceCraftFailure({
                    cwd: input.cwd,
                    exitCode: Number(result.exitCode),
                    stderr: result.stderr,
                  }),
                ),
        ),
      );
  const api: SourceCraftCli["Service"]["api"] = Effect.fn("SourceCraftCli.api")(function* (input) {
    // The body goes through stdin, so its size and leading dashes never meet the argument list.
    const stdin =
      input.body === undefined
        ? undefined
        : yield* encodeBody(input.body).pipe(
            Effect.mapError(
              (cause) =>
                new SourceCraftCliError({
                  cwd: input.cwd,
                  detail: "Could not encode the SourceCraft request body.",
                  cause,
                }),
            ),
          );
    return yield* run({
      cwd: input.cwd,
      args: [
        "api",
        "--method",
        input.method ?? "GET",
        ...(stdin === undefined ? [] : ["--input", "-"]),
        input.path,
      ],
      ...(stdin === undefined ? {} : { stdin }),
    });
  });
  return SourceCraftCli.of({ run, api });
});

export const layer = Layer.effect(SourceCraftCli, make);

/** Decodes a response body as `schema`. */
export const decode =
  <S extends Schema.Codec<unknown, unknown, never, never>>(cwd: string, schema: S) =>
  (body: string): Effect.Effect<S["Type"], SourceCraftCliError> =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
      Effect.mapError(
        (cause) =>
          new SourceCraftCliError({
            cwd,
            reason: "invalid-response",
            detail: "SourceCraft returned an invalid response.",
            cause,
          }),
      ),
    );

export const repositoryPath = (repository: string) =>
  `repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
