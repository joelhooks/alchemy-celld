import type { Effect } from "effect";
import { Context } from "effect";

export class BucketFixture extends Context.Service<
  BucketFixture,
  {
    readonly drain: Effect.Effect<void>;
    readonly put: (key: string) => Effect.Effect<void>;
    readonly objects: Effect.Effect<readonly string[]>;
    readonly requests: Effect.Effect<readonly string[]>;
    readonly clearRequests: Effect.Effect<void>;
  }
>()("Test/InstanceBucketFixture") {}
