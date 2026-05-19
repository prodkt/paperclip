import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

type CostSource = "reported" | "estimated";

type Rate = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number;
  source: string;
};

type CandidateRow = {
  id: string;
  company_id: string;
  agent_id: string;
  agent_name: string;
  adapter_type: string;
  adapter_config: unknown;
  provider: string;
  biller: string;
  billing_type: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  cost_source: string;
  cost_metadata: unknown;
  heartbeat_run_id: string | null;
  usage_json: Record<string, unknown> | null;
  result_json: Record<string, unknown> | null;
  occurred_at: Date;
};

type Repair = {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string;
  heartbeatRunId: string | null;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  previousBiller: string;
  nextBiller: "openai";
  previousCostCents: number;
  nextCostCents: number;
  previousCostSource: string;
  nextCostSource: CostSource;
  costUsd: number;
  metadata: Record<string, unknown>;
};

type Args = {
  apply: boolean;
  json: boolean;
  databaseUrl: string | null;
  configPath: string | null;
  companyId: string | null;
  agentId: string | null;
  agentName: string | null;
  eventId: string | null;
  from: string | null;
  to: string | null;
};

const DIRECT_OPENAI_RATES: Record<string, Rate> = {
  "gpt-5.5": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.5-pro": { inputUsdPerMillion: 30, cachedInputUsdPerMillion: null, outputUsdPerMillion: 180, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.4": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.4-mini": { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.4-nano": { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.4-pro": { inputUsdPerMillion: 30, cachedInputUsdPerMillion: null, outputUsdPerMillion: 180, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.3-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.2-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.2": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14, source: "openai_api_pricing_2026-05-19" },
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readMetadata(value: unknown): Record<string, unknown> {
  const object = readObject(value);
  if (object) return object;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return readObject(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    json: false,
    databaseUrl: null,
    configPath: null,
    companyId: null,
    agentId: null,
    agentName: null,
    eventId: null,
    from: null,
    to: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    switch (arg) {
      case "--apply":
        args.apply = true;
        break;
      case "--dry-run":
        args.apply = false;
        break;
      case "--json":
        args.json = true;
        break;
      case "--database-url":
        args.databaseUrl = next();
        break;
      case "--config":
        args.configPath = next();
        break;
      case "--company-id":
        args.companyId = next();
        break;
      case "--agent-id":
        args.agentId = next();
        break;
      case "--agent-name":
        args.agentName = next();
        break;
      case "--event-id":
        args.eventId = next();
        break;
      case "--from":
        args.from = next();
        break;
      case "--to":
        args.to = next();
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function estimateDirectOpenAiCostUsd(row: Pick<CandidateRow, "model" | "input_tokens" | "cached_input_tokens" | "output_tokens">): { costUsd: number; rate: Rate } | null {
  const rate = DIRECT_OPENAI_RATES[normalizeModelId(row.model)];
  if (!rate) return null;

  const cachedInputTokens = Math.max(0, Math.floor(row.cached_input_tokens));
  const uncachedInputTokens = Math.max(0, Math.floor(row.input_tokens) - cachedInputTokens);
  const outputTokens = Math.max(0, Math.floor(row.output_tokens));
  const cachedInputRate = rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion;
  return {
    rate,
    costUsd:
      (uncachedInputTokens * rate.inputUsdPerMillion / 1_000_000) +
      (cachedInputTokens * cachedInputRate / 1_000_000) +
      (outputTokens * rate.outputUsdPerMillion / 1_000_000),
  };
}

function normalizeCostCents(costUsd: number): number {
  return Math.max(0, Math.round(costUsd * 100));
}

function adapterConfigProvesDirectOpenAi(adapterConfig: unknown): boolean {
  const config = readObject(adapterConfig);
  const env = readObject(config?.env);
  if (!env) return false;

  const hasOpenAiKey = Object.prototype.hasOwnProperty.call(env, "OPENAI_API_KEY");
  const hasOpenRouterKey = Object.prototype.hasOwnProperty.call(env, "OPENROUTER_API_KEY");
  const baseUrl =
    readString(env.OPENAI_BASE_URL) ??
    readString(env.OPENAI_API_BASE) ??
    readString(env.OPENAI_API_BASE_URL);

  return hasOpenAiKey && !hasOpenRouterKey && !(baseUrl && /openrouter\.ai/i.test(baseUrl));
}

function readPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function readReportedCost(row: CandidateRow): { costUsd: number; costField: string | null } | null {
  const usage = readObject(row.usage_json);
  const result = readObject(row.result_json);
  const costUsd = readPositiveNumber(
    usage?.costUsd,
    usage?.cost_usd,
    result?.costUsd,
    result?.cost_usd,
  );
  if (costUsd == null) return null;

  return {
    costUsd,
    costField: readString(usage?.costField) ?? readString(result?.costField),
  };
}

function buildRepair(row: CandidateRow): Repair | null {
  if (!adapterConfigProvesDirectOpenAi(row.adapter_config)) return null;

  const reported = readReportedCost(row);
  const estimated = reported ? null : estimateDirectOpenAiCostUsd(row);
  const costUsd = reported?.costUsd ?? estimated?.costUsd ?? null;
  if (costUsd == null || costUsd <= 0) return null;

  const nextCostSource: CostSource = reported ? "reported" : "estimated";
  const metadata: Record<string, unknown> = {
    ...readMetadata(row.cost_metadata),
    repair: {
      command: "repair-direct-openai-cost-events",
      reason: "direct_openai_metered_usage_had_zero_cost_or_wrong_biller",
      repairedAt: new Date().toISOString(),
      previousBiller: row.biller,
      previousCostCents: row.cost_cents,
      previousCostSource: row.cost_source,
    },
    costUsd,
  };

  if (reported) {
    metadata.providerCostField = reported.costField;
    metadata.source = "heartbeat_run_usage_or_result_json";
  } else if (estimated) {
    metadata.estimator = "openai_model_rate_table";
    metadata.rateSource = estimated.rate.source;
    metadata.inputUsdPerMillion = estimated.rate.inputUsdPerMillion;
    metadata.cachedInputUsdPerMillion = estimated.rate.cachedInputUsdPerMillion;
    metadata.outputUsdPerMillion = estimated.rate.outputUsdPerMillion;
  }

  return {
    id: row.id,
    companyId: row.company_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    heartbeatRunId: row.heartbeat_run_id,
    model: row.model,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    previousBiller: row.biller,
    nextBiller: "openai",
    previousCostCents: row.cost_cents,
    nextCostCents: normalizeCostCents(costUsd),
    previousCostSource: row.cost_source,
    nextCostSource,
    costUsd,
    metadata,
  };
}

function monthWindow(now = new Date()) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)),
  };
}

function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/")
    ? path.join(os.homedir(), input.slice(2))
    : input;
}

async function resolveDatabaseUrl(args: Args): Promise<string> {
  if (args.databaseUrl) return args.databaseUrl;
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();

  const configPath =
    args.configPath ??
    process.env.PAPERCLIP_CONFIG ??
    path.join(os.homedir(), ".paperclip/instances/default/config.json");
  const config = JSON.parse(await readFile(expandHome(configPath), "utf8")) as Record<string, unknown>;
  const database = readObject(config.database);
  const configuredUrl = readString(database?.url) ?? readString(config.databaseUrl);
  if (configuredUrl) return configuredUrl;

  const embeddedPort = Number(database?.embeddedPostgresPort ?? 54329);
  if (!Number.isFinite(embeddedPort) || embeddedPort <= 0) {
    throw new Error(`Could not resolve embedded Postgres port from ${configPath}`);
  }
  return `postgres://paperclip:paperclip@127.0.0.1:${embeddedPort}/paperclip`;
}

function maskDatabaseUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

async function loadPostgres() {
  const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
  return requireFromCwd("postgres") as typeof import("postgres").default;
}

type PostgresSql = ReturnType<typeof import("postgres").default>;

async function assertSchema(sql: PostgresSql) {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cost_events'
      AND column_name IN ('cost_source', 'cost_metadata')
  `;
  const columns = new Set(rows.map((row) => row.column_name));
  if (!columns.has("cost_source") || !columns.has("cost_metadata")) {
    throw new Error("cost_events provenance columns are missing; run `pnpm db:migrate` before this repair.");
  }
}

async function selectCandidates(sql: PostgresSql, args: Args) {
  const rows = await sql<CandidateRow[]>`
    SELECT
      ce.id,
      ce.company_id,
      ce.agent_id,
      a.name AS agent_name,
      a.adapter_type,
      a.adapter_config,
      ce.provider,
      ce.biller,
      ce.billing_type,
      ce.model,
      ce.input_tokens,
      ce.cached_input_tokens,
      ce.output_tokens,
      ce.cost_cents,
      ce.cost_source,
      ce.cost_metadata,
      ce.heartbeat_run_id,
      hr.usage_json,
      hr.result_json,
      ce.occurred_at
    FROM cost_events ce
    JOIN agents a ON a.id = ce.agent_id AND a.company_id = ce.company_id
    LEFT JOIN heartbeat_runs hr ON hr.id = ce.heartbeat_run_id AND hr.company_id = ce.company_id
    WHERE ce.provider = 'openai'
      AND ce.billing_type = 'metered_api'
      AND (ce.input_tokens + ce.cached_input_tokens + ce.output_tokens) > 0
      AND (
        ce.cost_cents = 0
        OR ce.biller <> 'openai'
        OR ce.cost_source = 'unavailable'
        OR jsonb_typeof(ce.cost_metadata) = 'string'
      )
      ${args.companyId ? sql`AND ce.company_id = ${args.companyId}` : sql``}
      ${args.agentId ? sql`AND ce.agent_id = ${args.agentId}` : sql``}
      ${args.agentName ? sql`AND a.name = ${args.agentName}` : sql``}
      ${args.eventId ? sql`AND ce.id = ${args.eventId}` : sql``}
      ${args.from ? sql`AND ce.occurred_at >= ${args.from}` : sql``}
      ${args.to ? sql`AND ce.occurred_at < ${args.to}` : sql``}
    ORDER BY ce.occurred_at ASC, ce.id ASC
  `;
  return rows;
}

async function applyRepairs(sql: PostgresSql, repairs: Repair[]) {
  if (repairs.length === 0) return { updatedEvents: 0, recomputedAgents: 0, recomputedCompanies: 0 };

  const affectedAgents = new Map<string, string>();
  const affectedCompanies = new Set<string>();
  let updatedEvents = 0;
  await sql.begin(async (tx) => {
    for (const repair of repairs) {
      const result = await tx`
        UPDATE cost_events
        SET
          biller = ${repair.nextBiller},
          cost_cents = ${repair.nextCostCents},
          cost_source = ${repair.nextCostSource},
          cost_metadata = ${tx.json(repair.metadata)}
        WHERE id = ${repair.id}
          AND company_id = ${repair.companyId}
          AND provider = 'openai'
          AND billing_type = 'metered_api'
          AND (input_tokens + cached_input_tokens + output_tokens) > 0
      `;
      if (result.count > 0) {
        updatedEvents += result.count;
        affectedAgents.set(repair.agentId, repair.companyId);
        affectedCompanies.add(repair.companyId);
      }
    }

    const { start, end } = monthWindow();
    for (const [agentId, companyId] of affectedAgents.entries()) {
      await tx`
        UPDATE agents
        SET
          spent_monthly_cents = (
            SELECT coalesce(sum(cost_cents), 0)::int
            FROM cost_events
            WHERE company_id = ${companyId}
              AND agent_id = ${agentId}
              AND occurred_at >= ${start}
              AND occurred_at < ${end}
          ),
          updated_at = now()
        WHERE id = ${agentId}
          AND company_id = ${companyId}
      `;
    }

    for (const companyId of affectedCompanies) {
      await tx`
        UPDATE companies
        SET
          spent_monthly_cents = (
            SELECT coalesce(sum(cost_cents), 0)::int
            FROM cost_events
            WHERE company_id = ${companyId}
              AND occurred_at >= ${start}
              AND occurred_at < ${end}
          ),
          updated_at = now()
        WHERE id = ${companyId}
      `;
    }
  });

  return {
    updatedEvents,
    recomputedAgents: affectedAgents.size,
    recomputedCompanies: affectedCompanies.size,
  };
}

function printHelp() {
  console.log(`Repair direct OpenAI metered cost_events rows with nonzero tokens and missing cost/provenance.

Usage:
  pnpm --filter @paperclipai/db exec tsx ../../scripts/repair-direct-openai-cost-events.ts --agent-name "Senior Planning Engineer Pro"
  pnpm --filter @paperclipai/db exec tsx ../../scripts/repair-direct-openai-cost-events.ts --agent-name "Senior Planning Engineer Pro" --apply

Options:
  --apply              Persist repairs. Omit for dry-run.
  --database-url URL   Postgres URL. Defaults to DATABASE_URL or Paperclip config.
  --config PATH        Paperclip config path when DATABASE_URL is unset.
  --company-id ID      Limit to one company.
  --agent-id ID        Limit to one agent.
  --agent-name NAME    Limit to one agent name.
  --event-id ID        Limit to one cost_event.
  --from ISO           Inclusive occurred_at lower bound.
  --to ISO             Exclusive occurred_at upper bound.
  --json               Print machine-readable output.
`);
}

function printSummary(repairs: Repair[], applied: boolean, dbUrl: string, result?: Awaited<ReturnType<typeof applyRepairs>>) {
  const totalCents = repairs.reduce((sum, repair) => sum + repair.nextCostCents, 0);
  console.log(`${applied ? "Applied" : "Dry run"} direct OpenAI cost repair against ${maskDatabaseUrl(dbUrl)}`);
  console.log(`Repairable events: ${repairs.length}`);
  console.log(`Next ledger total for repaired events: $${(totalCents / 100).toFixed(2)}`);
  for (const repair of repairs) {
    console.log(
      `- ${repair.id} ${repair.agentName} ${repair.model}: ` +
      `${repair.previousBiller}/${repair.previousCostCents}c/${repair.previousCostSource} -> ` +
      `openai/${repair.nextCostCents}c/${repair.nextCostSource}`,
    );
  }
  if (result) {
    console.log(`Updated events: ${result.updatedEvents}`);
    console.log(`Recomputed agents: ${result.recomputedAgents}`);
    console.log(`Recomputed companies: ${result.recomputedCompanies}`);
  } else {
    console.log("No database changes written. Re-run with --apply to persist.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbUrl = await resolveDatabaseUrl(args);
  const postgres = await loadPostgres();
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    await assertSchema(sql);
    const rows = await selectCandidates(sql, args);
    const repairs = rows.map(buildRepair).filter((repair): repair is Repair => repair !== null);
    const result = args.apply ? await applyRepairs(sql, repairs) : undefined;

    if (args.json) {
      console.log(JSON.stringify({ apply: args.apply, databaseUrl: maskDatabaseUrl(dbUrl), repairs, result }, null, 2));
    } else {
      printSummary(repairs, args.apply, dbUrl, result);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export {
  adapterConfigProvesDirectOpenAi,
  buildRepair,
  estimateDirectOpenAiCostUsd,
  normalizeCostCents,
  parseArgs,
};
