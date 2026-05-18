import {
  type GeminiSettings,
  type ModelCapabilities,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeGeminiEnvironment, resolveGeminiCliHomePath } from "../geminiCli.ts";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
  type ProviderCommandExecutionError,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("gemini");
const GEMINI_PRESENTATION = {
  displayName: "Gemini",
  badgeLabel: "Preview",
  showInteractionModeToggle: true,
} as const;

const DEFAULT_GEMINI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const BUILT_IN_GEMINI_MODELS = [
  {
    slug: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    subProvider: "Google",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    subProvider: "Google",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    subProvider: "Google",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
];

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function hasAuthEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    environment.GEMINI_API_KEY ||
    environment.GOOGLE_API_KEY ||
    environment.GOOGLE_APPLICATION_CREDENTIALS ||
    environment.GOOGLE_GENAI_USE_VERTEXAI === "true",
  );
}

function parseSelectedAuthType(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const selected = (parsed as Record<string, unknown>).selectedAuthType;
    return typeof selected === "string" && selected.trim() ? selected.trim() : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: { readonly message?: string }): string {
  return error.message ?? String(error);
}

const readGeminiSelectedAuthType = Effect.fn("readGeminiSelectedAuthType")(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* resolveGeminiCliHomePath(geminiSettings, environment);
  const configPath = path.join(homePath, ".gemini", "settings.json");
  const exists = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return undefined;
  }
  const raw = yield* fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  return parseSelectedAuthType(raw);
});

const runGeminiCommand = Effect.fn("runGeminiCommand")(function* (
  geminiSettings: GeminiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  CommandResult,
  PlatformError.PlatformError | ProviderCommandExecutionError,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const geminiEnvironment = yield* makeGeminiEnvironment(geminiSettings, environment);
  const command = ChildProcess.make(geminiSettings.binaryPath, [...args], {
    env: geminiEnvironment,
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(geminiSettings.binaryPath, command);
});

function makeGeminiModels(geminiSettings: GeminiSettings) {
  return providerModelsFromSettings(
    BUILT_IN_GEMINI_MODELS,
    PROVIDER,
    geminiSettings.customModels,
    DEFAULT_GEMINI_MODEL_CAPABILITIES,
  );
}

export const makePendingGeminiProvider = (
  geminiSettings: GeminiSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = makeGeminiModels(geminiSettings);

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Gemini is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini provider status has not been checked in this session yet.",
      },
    });
  });

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = yield* nowIso;
  const models = makeGeminiModels(geminiSettings);

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runGeminiCommand(geminiSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause({ message: errorMessage(error) }),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause({ message: errorMessage(error) })
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : `Failed to execute Gemini CLI health check: ${errorMessage(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Gemini CLI is installed but failed to run. ${detail}`
          : "Gemini CLI is installed but failed to run.",
      },
    });
  }

  const selectedAuthType = yield* readGeminiSelectedAuthType(geminiSettings, environment);
  const hasConfiguredAuth = selectedAuthType !== undefined || hasAuthEnvironment(environment);
  const isOauth = selectedAuthType === "oauth-personal";

  return buildServerProvider({
    presentation: GEMINI_PRESENTATION,
    enabled: geminiSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: hasConfiguredAuth ? "ready" : "warning",
      auth: {
        status: hasConfiguredAuth ? "authenticated" : "unauthenticated",
        type: isOauth ? "oauth" : "api-key",
        ...(isOauth ? { label: "Gemini CLI OAuth" } : {}),
      },
      message: hasConfiguredAuth
        ? isOauth
          ? "Configured to use Gemini CLI OAuth."
          : "Configured to use Gemini CLI authentication."
        : "Gemini CLI needs authentication. Run `gemini` and choose Login with Google, or configure GEMINI_API_KEY.",
    },
  });
});
