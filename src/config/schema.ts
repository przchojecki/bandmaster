import { z } from "zod";

const ProviderNameSchema = z.enum(["codex", "claude", "gemini", "ollama"]);

const ModelRefSchema = z.object({
  provider: ProviderNameSchema,
  model: z.string().min(1)
});

const UserProxyConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    permissionScope: z.string().min(1).default("manual"),
    guidanceStyle: z.string().min(1).default("direct")
  })
  .default({});

const PolicyConfigSchema = z
  .object({
    mode: z.enum(["auto", "safe-only", "manual"]).default("manual")
  })
  .default({});

const CheckpointConfigSchema = z
  .object({
    intervalMinutes: z.number().int().positive().default(20)
  })
  .default({});

const DialogueConfigSchema = z
  .object({
    enableWorkerPmLoop: z.boolean().default(true),
    interveneOnPermission: z.boolean().default(true),
    interveneOnDirectionRequest: z.boolean().default(true),
    interveneOnStall: z.boolean().default(true),
    stallMinutes: z.number().int().positive().default(8)
  })
  .default({});

const BudgetCycleConfigSchema = z.object({
  maxTokens: z.number().int().positive(),
  maxTurns: z.number().int().positive()
});

const BudgetConfigSchema = z.object({
  maxMinutes: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  stopMode: z.enum(["drain", "hard"]).default("drain"),
  cycle: BudgetCycleConfigSchema
});

const LoopConfigSchema = z.object({
  runCommand: z.string().min(1),
  metricPattern: z.string().min(1),
  metricSource: z.enum(["stdout", "stderr", "combined"]).default("combined"),
  optimize: z.enum(["max", "min"]).default("max"),
  keepThreshold: z.number().default(0),
  maxRounds: z.number().int().positive().default(20),
  timeoutSeconds: z.number().int().positive().default(1800),
  editScope: z.array(z.string().min(1)).min(1).default(["**/*"])
});

const SwarmConfigSchema = z.object({
  enabled: z.boolean().default(false),
  backend: z.enum(["file"]).default("file"),
  root: z.string().min(1).default(".bandmaster/swarm"),
  swarmId: z.string().min(1).default("default"),
  agentId: z.string().min(1).optional(),
  claimTtlSeconds: z.number().int().positive().default(1200),
  syncEveryNRounds: z.number().int().positive().default(3),
  maxMetricJump: z.number().positive().default(1000000)
});

const ProviderAuthSchema = z
  .object({
    mode: z.enum(["api", "subscription"]).default("api"),
    apiKeyEnv: z.string().min(1).optional(),
    subscriptionCommand: z.string().min(1).optional()
  })
  .superRefine((value, context) => {
    if (value.mode === "api" && !value.apiKeyEnv) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyEnv"],
        message: "apiKeyEnv is required when auth mode is 'api'."
      });
    }
    if (value.mode === "subscription" && !value.subscriptionCommand) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subscriptionCommand"],
        message: "subscriptionCommand is required when auth mode is 'subscription'."
      });
    }
  });

const ProviderConfigSchema = z.object({
  auth: ProviderAuthSchema.optional()
});

export type ProviderName = z.infer<typeof ProviderNameSchema>;
export type ProviderAuth = z.infer<typeof ProviderAuthSchema>;

export const ProjectConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    objective: z.string().min(1),
    workspace: z.string().min(1).default("."),
    entryDocs: z.array(z.string().min(1)).min(1)
  }),
  worker: z.object({
    primary: ModelRefSchema,
    fallback: z.array(ModelRefSchema).default([])
  }),
  pm: z.object({
    primary: ModelRefSchema,
    fallback: z.array(ModelRefSchema).default([]),
    userProxy: UserProxyConfigSchema
  }),
  policy: PolicyConfigSchema,
  checkpoint: CheckpointConfigSchema,
  dialogue: DialogueConfigSchema,
  budget: BudgetConfigSchema,
  loop: LoopConfigSchema.optional(),
  swarm: SwarmConfigSchema.optional(),
  providers: z.record(ProviderConfigSchema).default({})
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
