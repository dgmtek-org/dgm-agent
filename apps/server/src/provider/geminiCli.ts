// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import type { GeminiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../pathExpansion.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export type GeminiCliSettings = Pick<GeminiSettings, "binaryPath" | "homePath">;

export const resolveGeminiCliHomePath = Effect.fn("resolveGeminiCliHomePath")(function* (
  config: Pick<GeminiSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim() || baseEnv.GEMINI_CLI_HOME?.trim() || "";
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeGeminiEnvironment = Effect.fn("makeGeminiEnvironment")(function* (
  config: Pick<GeminiSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return baseEnv;
  const resolvedHomePath = yield* resolveGeminiCliHomePath(config, baseEnv);
  return {
    ...baseEnv,
    GEMINI_CLI_HOME: resolvedHomePath,
  };
});

export function buildGeminiPromptArgs(input: {
  readonly model: string;
  readonly yolo?: boolean;
}): ReadonlyArray<string> {
  return ["--model", input.model, "--prompt", "", ...(input.yolo === true ? ["--yolo"] : [])];
}

export function runGeminiPrompt(input: {
  readonly settings: GeminiCliSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly model: string;
  readonly prompt: string;
  readonly yolo?: boolean;
}): Effect.Effect<
  { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const command = ChildProcess.make(
      input.settings.binaryPath || "gemini",
      [
        ...buildGeminiPromptArgs({
          model: input.model,
          ...(input.yolo !== undefined ? { yolo: input.yolo } : {}),
        }),
      ],
      {
        cwd: input.cwd,
        env: input.environment,
        shell: process.platform === "win32",
        stdin: {
          stream: Stream.encodeText(Stream.make(input.prompt)),
        },
      },
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout }).pipe(
          Effect.map((collected) => collected.text),
        ),
        collectUint8StreamText({ stream: child.stderr }).pipe(
          Effect.map((collected) => collected.text),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  }).pipe(Effect.scoped);
}
