import { randomBytes } from "node:crypto";
import { mkdir, copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertAuthorizedTargets,
  assertDatabaseUrlMatchesRef,
  PROJECT_REF_PATTERN,
} from "./identity";
import { runRedacted, sha256File, type RunResult } from "./process";

export const DRILL_COMMANDS = ["preflight", "upgrade", "backup", "restore", "verify", "all"] as const;
export type DrillCommand = (typeof DRILL_COMMANDS)[number];

export interface DrillArgs {
  command: DrillCommand;
  sourceRef: string;
  restoreRef: string;
  approvedRestoreRef: string;
  confirmRestore?: string;
  dryRun: boolean;
}

export interface PlanInput {
  sourceRef: string;
  restoreRef: string;
  runDirectory: string;
  sourceDatabaseUrl?: string;
  restoreDatabaseUrl?: string;
}

export interface PlannedCommand {
  operation: string;
  executable: string;
  args: readonly string[];
  cwd?: string;
  env: Readonly<Record<string, string>>;
  targetRef?: string;
  readOnly: boolean;
  artifactBasenames?: string;
}

interface RunDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  randomHex?: () => string;
  execute?: (command: PlannedCommand) => Promise<RunResult>;
  writeOutput?: (line: string) => void;
}

const MUTATING_COMMANDS: readonly DrillCommand[] = ["upgrade", "restore", "all"];
const EXPECTED_ENVIRONMENT_KEYS = [
  "BILLING_SOURCE_DB_URL",
  "BILLING_RESTORE_DB_URL",
  "BILLING_PRODUCTION_PROJECT_REFS",
] as const;
const INTERNAL_EXECUTABLE = "billing-db-drill";
const SYSTEM_CHILD_ENVIRONMENT_KEYS = new Set([
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);
const COMMAND_CHILD_ENVIRONMENT_KEYS = new Set([
  "PGDATABASE",
  "PGHOST",
  "PGPASSWORD",
  "PGPORT",
  "PGSSLMODE",
  "PGUSER",
  "SUPABASE_DB_PASSWORD",
]);

function fail(code: string): never {
  throw new Error(code);
}

function requireProjectRef(value: string | undefined): string {
  if (!value || !PROJECT_REF_PATTERN.test(value)) fail("INVALID_PROJECT_REF");
  return value;
}

export function parseDrillArgs(argv: readonly string[]): DrillArgs {
  const [rawCommand, ...tokens] = argv;
  if (!DRILL_COMMANDS.includes(rawCommand as DrillCommand)) fail("DRILL_COMMAND_INVALID");

  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (option === "--dry-run") {
      if (dryRun) fail("DRILL_ARGUMENT_DUPLICATE");
      dryRun = true;
      continue;
    }
    if (!["--source-ref", "--restore-ref", "--approved-restore-ref", "--confirm-restore"].includes(option)) {
      fail("DRILL_ARGUMENT_UNKNOWN");
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) fail("DRILL_ARGUMENT_VALUE_REQUIRED");
    if (values.has(option)) fail("DRILL_ARGUMENT_DUPLICATE");
    values.set(option, value);
    index += 1;
  }

  const sourceRef = requireProjectRef(values.get("--source-ref"));
  const restoreRef = requireProjectRef(values.get("--restore-ref"));
  const approvedRestoreRef = requireProjectRef(values.get("--approved-restore-ref"));
  assertAuthorizedTargets({ sourceRef, restoreRef, approvedRestoreRef, productionRefs: [] });

  const command = rawCommand as DrillCommand;
  const confirmRestore = values.get("--confirm-restore");
  if (MUTATING_COMMANDS.includes(command)) {
    if (!confirmRestore) fail("RESTORE_CONFIRMATION_REQUIRED");
    if (confirmRestore !== approvedRestoreRef) fail("RESTORE_CONFIRMATION_MISMATCH");
  } else if (confirmRestore !== undefined) {
    fail("RESTORE_CONFIRMATION_NOT_ALLOWED");
  }

  return {
    command,
    sourceRef,
    restoreRef,
    approvedRestoreRef,
    ...(confirmRestore === undefined ? {} : { confirmRestore }),
    dryRun,
  };
}

function databaseEnvironment(rawUrl: string | undefined, expectedRef: string): Readonly<Record<string, string>> {
  if (!rawUrl) return {};
  const url = assertDatabaseUrlMatchesRef(rawUrl, expectedRef);
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.slice(1) || "postgres",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: "require",
  };
}

function planned(
  operation: string,
  executable: string,
  args: readonly string[],
  options: Partial<Omit<PlannedCommand, "operation" | "executable" | "args">> = {},
): PlannedCommand {
  return {
    operation,
    executable,
    args,
    env: options.env ?? {},
    readOnly: options.readOnly ?? false,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.targetRef === undefined ? {} : { targetRef: options.targetRef }),
    ...(options.artifactBasenames === undefined ? {} : { artifactBasenames: options.artifactBasenames }),
  };
}

function workspacePath(input: PlanInput, name: string): string {
  return join(input.runDirectory, name);
}

function artifactPath(input: PlanInput, name: string): string {
  return join(input.runDirectory, name);
}

function linkedRefCheck(operation: string, workspace: string, targetRef: string, readOnly: boolean): PlannedCommand {
  return planned(operation, INTERNAL_EXECUTABLE, ["assert-linked-ref", targetRef], {
    cwd: workspace,
    targetRef,
    readOnly,
  });
}

export function buildUpgradePlan(input: PlanInput): readonly PlannedCommand[] {
  const restoreEnv = databaseEnvironment(input.restoreDatabaseUrl, input.restoreRef);
  const workspace = workspacePath(input, "upgrade-workspace");
  const linkEnv: Readonly<Record<string, string>> = restoreEnv.PGPASSWORD ? { SUPABASE_DB_PASSWORD: restoreEnv.PGPASSWORD } : {};
  return [
    planned("prepare-upgrade-009-workspace", INTERNAL_EXECUTABLE, ["copy-migrations", "001-009", "upgrade-workspace"], { cwd: input.runDirectory }),
    planned("link-upgrade-workspace", "supabase", ["link", "--project-ref", input.restoreRef], {
      cwd: workspace, env: linkEnv, targetRef: input.restoreRef,
    }),
    linkedRefCheck("verify-upgrade-workspace-ref-before-009", workspace, input.restoreRef, true),
    planned("push-migrations-001-009", "supabase", ["db", "push", "--linked"], {
      cwd: workspace, env: linkEnv, targetRef: input.restoreRef,
    }),
    planned("load-fixtures-009", "psql", ["-X", "-v", "ON_ERROR_STOP=1", "-v", "drill_commit=true", "-f", resolve("scripts/billing-db-drill/sql/fixtures-009.sql")], {
      env: restoreEnv, targetRef: input.restoreRef,
    }),
    planned("capture-pre-upgrade-manifest", "psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", resolve("scripts/billing-db-drill/sql/manifest.sql"), "-o", artifactPath(input, "upgrade-before.json")], {
      env: restoreEnv, targetRef: input.restoreRef, readOnly: true, artifactBasenames: "upgrade-before.json",
    }),
    planned("copy-migration-010", INTERNAL_EXECUTABLE, ["copy-migrations", "010", "upgrade-workspace"], { cwd: input.runDirectory }),
    linkedRefCheck("verify-upgrade-workspace-ref-before-010", workspace, input.restoreRef, true),
    planned("push-migration-010", "supabase", ["db", "push", "--linked"], {
      cwd: workspace, env: linkEnv, targetRef: input.restoreRef,
    }),
    planned("verify-upgraded-restore", "psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", resolve("scripts/billing-db-drill/sql/verify.sql")], {
      env: restoreEnv, targetRef: input.restoreRef,
    }),
  ];
}

export function buildBackupPlan(input: PlanInput): readonly PlannedCommand[] {
  const sourceEnv = databaseEnvironment(input.sourceDatabaseUrl, input.sourceRef);
  const workspace = workspacePath(input, "backup-workspace");
  const linkEnv: Readonly<Record<string, string>> = sourceEnv.PGPASSWORD ? { SUPABASE_DB_PASSWORD: sourceEnv.PGPASSWORD } : {};
  const artifacts = ["roles.sql", "schema.sql", "data.sql"] as const;
  return [
    planned("prepare-backup-workspace", INTERNAL_EXECUTABLE, ["prepare-workspace", "backup-workspace"], { cwd: input.runDirectory }),
    planned("link-backup-workspace", "supabase", ["link", "--project-ref", input.sourceRef], {
      cwd: workspace, env: linkEnv, targetRef: input.sourceRef, readOnly: true,
    }),
    linkedRefCheck("verify-backup-workspace-ref-before-roles", workspace, input.sourceRef, true),
    planned("dump-roles", "supabase", ["db", "dump", "--linked", "--role-only", "--file", artifactPath(input, artifacts[0])], {
      cwd: workspace, env: linkEnv, targetRef: input.sourceRef, readOnly: true, artifactBasenames: artifacts[0],
    }),
    linkedRefCheck("verify-backup-workspace-ref-before-schema", workspace, input.sourceRef, true),
    planned("dump-schema", "supabase", ["db", "dump", "--linked", "--file", artifactPath(input, artifacts[1])], {
      cwd: workspace, env: linkEnv, targetRef: input.sourceRef, readOnly: true, artifactBasenames: artifacts[1],
    }),
    linkedRefCheck("verify-backup-workspace-ref-before-data", workspace, input.sourceRef, true),
    planned("dump-data", "supabase", ["db", "dump", "--linked", "--data-only", "--use-copy", "--file", artifactPath(input, artifacts[2])], {
      cwd: workspace, env: linkEnv, targetRef: input.sourceRef, readOnly: true, artifactBasenames: artifacts[2],
    }),
    ...artifacts.map((artifact) => planned(`hash-${artifact.slice(0, -4)}`, INTERNAL_EXECUTABLE, ["sha256", artifactPath(input, artifact)], {
      readOnly: true, artifactBasenames: artifact,
    })),
  ];
}

export function buildRestorePlan(input: PlanInput): readonly PlannedCommand[] {
  const restoreEnv = databaseEnvironment(input.restoreDatabaseUrl, input.restoreRef);
  return ["roles.sql", "schema.sql", "data.sql"].map((artifact) => planned(
    `restore-${artifact.slice(0, -4)}`,
    "psql",
    ["-X", "-v", "ON_ERROR_STOP=1", "-f", artifactPath(input, artifact)],
    { env: restoreEnv, targetRef: input.restoreRef, artifactBasenames: artifact },
  ));
}

export function buildPreflightPlan(input: PlanInput): readonly PlannedCommand[] {
  const sourceEnv = databaseEnvironment(input.sourceDatabaseUrl, input.sourceRef);
  const restoreEnv = databaseEnvironment(input.restoreDatabaseUrl, input.restoreRef);
  const identitySql = "select current_database(), current_user";
  const billingVersions = [
    "202607210001", "202607210002", "202607210003", "202607230004", "202607290005",
    "202607290006", "202607290007", "202607290008", "202607290009", "202608050010",
  ];
  const emptySql = `do $preflight$ begin
    if exists (
      select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname like 'billing\\_%' escape '\\'
    ) or exists (
      select 1 from supabase_migrations.schema_migrations
      where version = any (array[${billingVersions.map((version) => `'${version}'`).join(", ")}])
    ) then raise exception 'RESTORE_NOT_EMPTY'; end if;
  end $preflight$;`;
  return [
    planned("check-node-version", "node", ["--version"], { readOnly: true }),
    planned("check-supabase-version", "supabase", ["--version"], { readOnly: true }),
    planned("check-psql-version", "psql", ["--version"], { readOnly: true }),
    planned("verify-source-identity", "psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", identitySql], {
      env: sourceEnv, targetRef: input.sourceRef, readOnly: true,
    }),
    planned("verify-restore-identity", "psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", identitySql], {
      env: restoreEnv, targetRef: input.restoreRef, readOnly: true,
    }),
    planned("verify-restore-empty", "psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", emptySql], {
      env: restoreEnv, targetRef: input.restoreRef, readOnly: true,
    }),
  ];
}

function buildVerifyPlan(input: PlanInput): readonly PlannedCommand[] {
  const restoreEnv = databaseEnvironment(input.restoreDatabaseUrl, input.restoreRef);
  return [planned("verify-restore", "psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", resolve("scripts/billing-db-drill/sql/verify.sql")], {
    env: restoreEnv, targetRef: input.restoreRef, readOnly: false,
  })];
}

function buildPlan(command: DrillCommand, input: PlanInput): readonly PlannedCommand[] {
  switch (command) {
    case "preflight": return buildPreflightPlan(input);
    case "upgrade": return buildUpgradePlan(input);
    case "backup": return buildBackupPlan(input);
    case "restore": return buildRestorePlan(input);
    case "verify": return buildVerifyPlan(input);
    case "all": return [
      ...buildPreflightPlan(input),
      ...buildUpgradePlan(input),
      ...buildBackupPlan(input),
      ...buildRestorePlan(input),
      ...buildVerifyPlan(input),
    ];
  }
}

function productionRefs(raw: string | undefined): readonly string[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((ref) => requireProjectRef(ref.trim()));
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeArgs(command: PlannedCommand): readonly string[] {
  return command.args.map((argument, index) => {
    if (index > 0 && command.args[index - 1] === "-c") return "[READ_ONLY_SQL]";
    if (/[/\\]/.test(argument)) return basename(argument);
    return argument;
  });
}

function sanitizedPlanLine(args: DrillArgs, runDirectory: string, commands: readonly PlannedCommand[]): string {
  return JSON.stringify({
    status: "DRY_RUN",
    sourceRef: args.sourceRef,
    restoreRef: args.restoreRef,
    runDirectory: runDirectory.replaceAll("\\", "/"),
    operations: commands.map((command) => ({
      operation: command.operation,
      executable: basename(command.executable),
      args: safeArgs(command),
      ...(command.artifactBasenames ? { artifact: command.artifactBasenames } : {}),
      status: "PLANNED",
    })),
  });
}

async function copyMigrations(range: string, workspace: string): Promise<void> {
  const destination = join(workspace, "supabase", "migrations");
  await mkdir(destination, { recursive: true });
  const migrationNames = (await readdir(resolve("supabase/migrations"))).sort();
  const selected = migrationNames.filter((name) => range === "001-009" ? /00[1-9]_/.test(name) : /0010_/.test(name));
  if (selected.length !== (range === "001-009" ? 9 : 1)) fail("MIGRATION_SET_INVALID");
  await Promise.all(selected.map((name) => copyFile(resolve("supabase/migrations", name), join(destination, name))));
  await copyFile(resolve("supabase/config.toml"), join(workspace, "supabase", "config.toml"));
}

function childPath(parent: string, childName: string): string {
  if (!/^[a-z0-9-]+$/.test(childName)) fail("WORKSPACE_NAME_INVALID");
  const parentPath = resolve(parent);
  const candidate = resolve(parentPath, childName);
  if (!candidate.startsWith(`${parentPath}\\`) && !candidate.startsWith(`${parentPath}/`)) fail("WORKSPACE_PATH_INVALID");
  return candidate;
}

async function executeInternal(command: PlannedCommand): Promise<RunResult> {
  const [action, value] = command.args;
  if (action === "prepare-workspace") {
    if (!command.cwd) fail("WORKSPACE_PATH_REQUIRED");
    const workspace = childPath(command.cwd, value);
    await mkdir(join(workspace, "supabase"), { recursive: true });
    await copyFile(resolve("supabase/config.toml"), join(workspace, "supabase", "config.toml"));
  } else if (action === "copy-migrations") {
    if (!command.cwd) fail("WORKSPACE_PATH_REQUIRED");
    const workspace = childPath(command.cwd, command.args[2]);
    await copyMigrations(value, workspace);
  } else if (action === "assert-linked-ref") {
    if (!command.cwd) fail("WORKSPACE_PATH_REQUIRED");
    const linkedRef = (await readFile(join(command.cwd, "supabase", ".temp", "project-ref"), "utf8")).trim();
    if (linkedRef !== value) fail("LINKED_PROJECT_REF_MISMATCH");
  } else if (action === "sha256") {
    return { stdout: await sha256File(value), stderr: "" };
  } else {
    fail("INTERNAL_OPERATION_INVALID");
  }
  return { stdout: "", stderr: "" };
}

export function buildSafeChildEnvironment(
  systemEnvironment: Readonly<Record<string, string | undefined>>,
  commandEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(systemEnvironment)) {
    if (value !== undefined && SYSTEM_CHILD_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(commandEnvironment)) {
    if (!COMMAND_CHILD_ENVIRONMENT_KEYS.has(key)) fail("CHILD_ENVIRONMENT_KEY_INVALID");
    environment[key] = value;
  }
  return environment;
}

async function defaultExecute(command: PlannedCommand): Promise<RunResult> {
  if (command.executable === INTERNAL_EXECUTABLE) return executeInternal(command);
  const secretValues = Object.values(command.env);
  return runRedacted(command.executable, [...command.args], {
    cwd: command.cwd,
    env: buildSafeChildEnvironment(process.env, command.env) as NodeJS.ProcessEnv,
    secretValues,
  });
}

function requireRuntimeUrls(env: Readonly<Record<string, string | undefined>>, args: DrillArgs): { sourceDatabaseUrl?: string; restoreDatabaseUrl?: string } {
  const sourceDatabaseUrl = env.BILLING_SOURCE_DB_URL;
  const restoreDatabaseUrl = env.BILLING_RESTORE_DB_URL;
  if (!sourceDatabaseUrl || !restoreDatabaseUrl) fail("DATABASE_URLS_REQUIRED");
  assertDatabaseUrlMatchesRef(sourceDatabaseUrl, args.sourceRef);
  assertDatabaseUrlMatchesRef(restoreDatabaseUrl, args.restoreRef);
  return { sourceDatabaseUrl, restoreDatabaseUrl };
}

export async function runDrill(argv: readonly string[], dependencies: RunDependencies = {}): Promise<number> {
  const args = parseDrillArgs(argv);
  const env = dependencies.env ?? process.env;
  for (const key of Object.keys(env).filter((key) => key.startsWith("BILLING_") && !EXPECTED_ENVIRONMENT_KEYS.includes(key as never))) {
    if (env[key]) fail("BILLING_ENVIRONMENT_KEY_UNKNOWN");
  }
  assertAuthorizedTargets({
    sourceRef: args.sourceRef,
    restoreRef: args.restoreRef,
    approvedRestoreRef: args.approvedRestoreRef,
    productionRefs: productionRefs(env.BILLING_PRODUCTION_PROJECT_REFS),
  });

  const now = dependencies.now?.() ?? new Date();
  const randomHex = dependencies.randomHex?.() ?? randomBytes(4).toString("hex");
  if (!/^[a-f0-9]{8}$/.test(randomHex)) fail("RUN_RANDOM_SUFFIX_INVALID");
  const relativeRunDirectory = `.artifacts/billing-db-drill/${timestamp(now)}-${randomHex}`;
  const runDirectory = resolve(relativeRunDirectory);
  const urls = args.dryRun ? {} : requireRuntimeUrls(env, args);
  const input: PlanInput = { sourceRef: args.sourceRef, restoreRef: args.restoreRef, runDirectory, ...urls };
  const commands = buildPlan(args.command, input);
  const writeOutput = dependencies.writeOutput ?? console.log;

  if (args.dryRun) {
    writeOutput(sanitizedPlanLine(args, relativeRunDirectory, commands));
    return 0;
  }

  await mkdir(runDirectory, { recursive: false });
  const execute = dependencies.execute ?? defaultExecute;
  const operations: Array<Record<string, string>> = [];
  for (const command of commands) {
    const result = await execute(command);
    operations.push({
      operation: command.operation,
      status: "PASSED",
      ...(command.artifactBasenames ? { artifact: command.artifactBasenames } : {}),
      ...(command.operation.startsWith("hash-") ? { checksum: result.stdout.trim() } : {}),
    });
  }
  const summary = { sourceRef: args.sourceRef, restoreRef: args.restoreRef, operations };
  await writeFile(join(runDirectory, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  writeOutput(JSON.stringify({ status: "PASSED", sourceRef: args.sourceRef, restoreRef: args.restoreRef, runDirectory: relativeRunDirectory }));
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runDrill(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "DRILL_FAILED");
      process.exitCode = 1;
    },
  );
}
