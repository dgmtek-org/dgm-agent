import {
  type GitHubCopilotSettings,
  type ModelCapabilities,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  createModelCapabilities,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { AcpSessionRuntime, type AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { buildCopilotAcpSpawnInput } from "../acp/CopilotAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("githubCopilot");
const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Preview",
  showInteractionModeToggle: true,
} as const;

const DEFAULT_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function nonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function selectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<{ readonly value: string; readonly label: string; readonly isDefault?: boolean }> {
  if (!option || option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) => {
    const options = "options" in entry ? entry.options : [entry];
    return options.flatMap((candidate) => {
      const value = nonEmptyString(candidate.value);
      const label = nonEmptyString(candidate.name) ?? value;
      if (!value || !label) {
        return [];
      }
      return [
        option.currentValue === value
          ? { value, label, isDefault: true as const }
          : { value, label },
      ];
    });
  });
}

function findConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  category: string,
  id?: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find(
    (option) => option.category === category && (id === undefined || option.id === id),
  );
}

function buildCopilotModelCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const reasoningOption =
    findConfigOption(configOptions, "thought_level", "reasoning_effort") ??
    configOptions?.find((option) => option.id === "reasoning_effort");
  const reasoningOptions = selectOptions(reasoningOption);
  return createModelCapabilities({
    optionDescriptors:
      reasoningOptions.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "reasoning",
              label: reasoningOption?.name?.trim() || "Reasoning",
              options: reasoningOptions,
            }),
          ]
        : [],
  });
}

function flattenCopilotModels(
  sessionSetupResult: AcpSessionRuntimeStartResult["sessionSetupResult"],
): ReadonlyArray<ServerProviderModel> {
  const modelOption = findConfigOption(sessionSetupResult.configOptions, "model");
  const currentModel = modelOption?.type === "select" ? modelOption.currentValue : undefined;
  const currentCapabilities = buildCopilotModelCapabilities(sessionSetupResult.configOptions);
  const modelsFromResponse = sessionSetupResult.models?.availableModels ?? [];
  const sourceModels =
    modelsFromResponse.length > 0
      ? modelsFromResponse.map((model) => ({
          slug: model.modelId,
          name: model.name,
          description: model.description,
        }))
      : selectOptions(modelOption).map((model) => ({
          slug: model.value,
          name: model.label,
          description: undefined,
        }));
  const seen = new Set<string>();
  return sourceModels.flatMap((model) => {
    const slug = nonEmptyString(model.slug);
    const name = nonEmptyString(model.name) ?? slug;
    if (!slug || !name || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name,
        ...(nonEmptyString(model.description) && model.description !== name
          ? { shortName: name }
          : {}),
        isCustom: false,
        capabilities:
          slug === currentModel ? currentCapabilities : DEFAULT_COPILOT_MODEL_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function normalizeCopilotReasoning(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  switch (normalized) {
    case "xhigh":
    case "extra-high":
    case "extra_high":
      return "xhigh";
    case "high":
    case "medium":
    case "low":
      return normalized;
    default:
      return normalized;
  }
}

export function resolveCopilotAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "auto";
}

export function resolveCopilotAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  const reasoningOption =
    findConfigOption(configOptions, "thought_level", "reasoning_effort") ??
    configOptions?.find((option) => option.id === "reasoning_effort");
  const requestedReasoning = normalizeCopilotReasoning(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (!reasoningOption || !requestedReasoning) {
    return [];
  }
  const selectedReasoning = selectOptions(reasoningOption).find(
    (option) =>
      normalizeCopilotReasoning(option.value) === requestedReasoning ||
      normalizeCopilotReasoning(option.label) === requestedReasoning,
  );
  return selectedReasoning
    ? [{ configId: reasoningOption.id, value: selectedReasoning.value }]
    : [];
}

const runCopilotCommand = Effect.fn("runCopilotCommand")(function* (
  copilotSettings: GitHubCopilotSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const command = ChildProcess.make(copilotSettings.binaryPath, [...args], {
    env: buildCopilotAcpSpawnInput(copilotSettings, process.cwd(), environment).env,
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(copilotSettings.binaryPath, command);
});

const probeCopilotAcp = (
  copilotSettings: GitHubCopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        authMethodId: "copilot-login",
        spawn: buildCopilotAcpSpawnInput(copilotSettings, process.cwd(), environment),
        cwd: process.cwd(),
        clientCapabilities: {
          _meta: {
            parameterizedModelPicker: true,
          },
        },
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
    return yield* runtime.start();
  }).pipe(Effect.scoped);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingCopilotProvider = (
  copilotSettings: GitHubCopilotSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      [],
      PROVIDER,
      copilotSettings.customModels,
      DEFAULT_COPILOT_MODEL_CAPABILITIES,
    );

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot provider status has not been checked in this session yet.",
      },
    });
  });

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: GitHubCopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = yield* nowIso;
  const fallbackModels = providerModelsFromSettings(
    [],
    PROVIDER,
    copilotSettings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runCopilotCommand(copilotSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : `Failed to execute GitHub Copilot CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "GitHub Copilot CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `GitHub Copilot CLI is installed but failed to run. ${detail}`
          : "GitHub Copilot CLI is installed but failed to run.",
      },
    });
  }

  const acpProbe = yield* probeCopilotAcp(copilotSettings, environment).pipe(
    Effect.timeoutOption(10_000),
    Effect.exit,
  );
  if (Exit.isFailure(acpProbe)) {
    const detail = Cause.prettyErrors(acpProbe.cause)
      .map((error) => error.message.trim())
      .filter(Boolean)
      .join("\n");
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unauthenticated", type: "oauth" },
        message: detail
          ? `GitHub Copilot needs authentication. Run \`copilot login\`. ${detail}`
          : "GitHub Copilot needs authentication. Run `copilot login`.",
      },
    });
  }

  if (Option.isNone(acpProbe.value)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown", type: "oauth" },
        message: "Timed out while checking GitHub Copilot authentication.",
      },
    });
  }

  const models = providerModelsFromSettings(
    flattenCopilotModels(acpProbe.value.value.sessionSetupResult),
    PROVIDER,
    copilotSettings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );
  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: copilotSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        type: "oauth",
        label: "Copilot CLI OAuth",
      },
      message: "Authenticated with GitHub Copilot CLI.",
    },
  });
});
