// Shared by every runtime test that uses the fake SDK, as a type-level check no runner executes: `fake-sdk.ts` against the real
// `@cursor/sdk`. `npm run typecheck` compiles this file with `tsc -p packages/runtime/test`, a project with no `paths` swap (the
// swap lives in tsconfig.test.json, which only tsx reads), so `@cursor/sdk` below is the real package and `./fake-sdk.js` is the
// fake. Each `satisfies` says that one member of the fake still fits the real signature, for the members `packages/runtime/src`
// uses. An SDK upgrade that moves one of them, or an edit that drops or retypes one in the fake, fails the typecheck. A member
// the runtime starts to use is added here and to the fake together. A narrowed result (`Using`, `UsedRun`, `UsedAgent`) names
// the members of the real object the runtime reads; the fake need not model the rest.
import type { Agent, Cursor, CursorSdkError, Run, SDKAgent } from "@cursor/sdk";
import * as fake from "./fake-sdk.js";
import type { Run as FakeRun } from "./fake-sdk.js";

type Sdk = typeof import("@cursor/sdk");
type AsyncFn = (...args: never[]) => Promise<unknown>;

/** The real signature of `F`, parameters as they are, with the object it resolves to cut down to the members `Key` names. */
type Using<F extends AsyncFn, Key extends keyof Awaited<ReturnType<F>>> = (...args: Parameters<F>) => Promise<Pick<Awaited<ReturnType<F>>, Key>>;
/** A list result with its items cut down to `Item`: the rest of the real result (a cursor) stays as it is. */
type WithItems<R extends { items: unknown[] }, Item> = { [K in keyof R]: K extends "items" ? Item[] : R[K] };
/** An error class as the runtime and the tests use it: built like the real one, carrying what `classifyError` reads. */
type ErrorClass<C extends new (...args: never[]) => CursorSdkError> = new (...args: ConstructorParameters<C>) => Pick<InstanceType<C>, "message" | "isRetryable" | "code" | "status">;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type UsedAgent = "agentId" | "send" | "getUsage" | "listArtifacts" | "downloadArtifact" | typeof Symbol.asyncDispose;
type UsedRun = "id" | "agentId" | "status" | "createdAt" | "wait" | "cancel";

// Without the `paths` swap the real package has no `calls`; the fake has. If a config maps `@cursor/sdk` to the fake here, this
// file would compare the fake with itself and pass for nothing: it fails to compile instead.
true satisfies "calls" extends keyof Sdk ? false : true;

// The SDK's types come out of the fake too, so the sources can be typechecked against it (`tsc -p tsconfig.test.json`).
true satisfies Same<FakeRun, Run>;

fake.Agent.create satisfies Using<typeof Agent.create, UsedAgent>;
fake.Agent.resume satisfies Using<typeof Agent.resume, UsedAgent>;
fake.Agent.listRuns satisfies (...args: Parameters<typeof Agent.listRuns>) => Promise<WithItems<Awaited<ReturnType<typeof Agent.listRuns>>, Pick<Run, UsedRun>>>;
fake.Agent.getRun satisfies Using<typeof Agent.getRun, UsedRun>;
fake.Agent.getUsage satisfies typeof Agent.getUsage;

fake.Cursor.me satisfies typeof Cursor.me;
fake.Cursor.models.list satisfies typeof Cursor.models.list;
fake.Cursor.auth.login satisfies typeof Cursor.auth.login;

fake.CursorAgentError satisfies ErrorClass<Sdk["CursorAgentError"]>;
fake.AgentBusyError satisfies ErrorClass<Sdk["AgentBusyError"]>;
fake.AuthenticationError satisfies ErrorClass<Sdk["AuthenticationError"]>;
fake.ConfigurationError satisfies ErrorClass<Sdk["ConfigurationError"]>;
fake.RateLimitError satisfies ErrorClass<Sdk["RateLimitError"]>;

// What `agentOf` hands out, as the real agent declares it: a fake agent is usable wherever the runtime holds an `SDKAgent`.
export type { SDKAgent };
