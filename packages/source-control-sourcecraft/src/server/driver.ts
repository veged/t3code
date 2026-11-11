import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../shared/definition.ts";

import * as SourceCraftCli from "./SourceCraftCli.ts";
import * as SourceCraftPullRequestProvider from "./SourceCraftPullRequestProvider.ts";
import * as SourceCraftSourceControlProvider from "./SourceCraftSourceControlProvider.ts";

const makeInstance = Effect.all({
  sourceControl: SourceCraftSourceControlProvider.make,
  discovery: Effect.succeed(SourceCraftSourceControlProvider.discovery),
  pullRequests: SourceCraftPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, SourceCraftCli.layer),
});
