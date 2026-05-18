import { type GitHubCopilotSettings, type ProviderOptionSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import {
  resolveCopilotAcpBaseModelId,
  resolveCopilotAcpConfigUpdates,
} from "../Layers/CopilotProvider.ts";

type CopilotAcpRuntimeSettings = Pick<GitHubCopilotSettings, "binaryPath" | "homePath">;

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CopilotAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function makeCopilotEnvironment(
  copilotSettings: CopilotAcpRuntimeSettings | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const homePath = copilotSettings?.homePath?.trim();
  return homePath ? { ...environment, COPILOT_HOME: homePath } : { ...environment };
}

export function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: ["--acp"],
    cwd,
    env: makeCopilotEnvironment(copilotSettings, environment),
  };
}

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCopilotAcpSpawnInput(input.copilotSettings, input.cwd, input.environment),
        authMethodId: "copilot-login",
        clientCapabilities: {
          _meta: {
            parameterizedModelPicker: true,
          },
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

interface CopilotAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyCopilotAcpModelSelection<E>(input: {
  readonly runtime: CopilotAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: CopilotAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* input.runtime.setModel(resolveCopilotAcpBaseModelId(input.model)).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    const configUpdates = resolveCopilotAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.selections,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}
