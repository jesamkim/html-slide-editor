#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cdkBin = join(
  repoRoot,
  "infra",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "cdk.cmd" : "cdk",
);
const ownershipTag = {
  key: "html-slide-editor:managed-by",
  value: "html-slide-editor-deploy",
};

const usage = `HTML Slide Editor AWS deployment

Usage:
  npm run infra:bootstrap -- --profile <name> --region <region> --account <id>
  npm run infra:deploy -- --profile <name> --region <region> --account <id>
  npm run infra:destroy -- --profile <name> --region <region> --account <id>

Options:
  --profile <name>         AWS CLI profile to use (required)
  --region <region>        AWS Region to use (required)
  --account <id>           Expected 12-digit AWS account ID (required)
  --stack-name <name>      CloudFormation stack name
  --domain-prefix <prefix> Cognito Hosted UI prefix
  --dry-run                Resolve identity and print commands only
  --yes                    Deploy only: skip target and CDK IAM confirmation
  --help                   Show this help

Credentials stay in the standard AWS CLI profile. This command never accepts
or stores an access key, secret key, or session token.
`;

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

const takeValue = (argv, index, option) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`${option} requires a value`);
  }
  return value;
};

const validateText = (label, value, pattern) => {
  if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CliError(`${label} contains unsupported characters`);
  }
  if (pattern && !pattern.test(value)) {
    throw new CliError(`${label} has an invalid format`);
  }
};

const validateDomainPrefix = (value) => {
  validateText(
    "--domain-prefix",
    value,
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
  for (const reserved of ["amazon", "aws", "cognito"]) {
    if (value.includes(reserved)) {
      throw new CliError(
        `Cognito domain prefix cannot contain ${reserved}`,
      );
    }
  }
  return value;
};

const parseArgs = (argv) => {
  const command = argv[0];
  if (!["bootstrap", "deploy", "destroy"].includes(command)) {
    throw new CliError("Command must be bootstrap, deploy, or destroy");
  }

  const options = {
    command,
    stackName: "HtmlSlideEditorStack",
    dryRun: false,
    yes: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--dry-run" || option === "--yes") {
      options[option === "--dry-run" ? "dryRun" : "yes"] = true;
      continue;
    }
    const keys = {
      "--profile": "profile",
      "--region": "region",
      "--account": "account",
      "--stack-name": "stackName",
      "--domain-prefix": "domainPrefix",
    };
    const key = keys[option];
    if (!key) throw new CliError(`Unknown option: ${option}`);
    options[key] = takeValue(argv, index, option);
    index += 1;
  }

  if (!options.profile) throw new CliError("--profile is required");
  if (!options.region) throw new CliError("--region is required");
  if (!options.account) throw new CliError("--account is required");
  if (options.command !== "deploy" && options.yes) {
    throw new CliError("--yes is only allowed with deploy");
  }
  validateText("--profile", options.profile);
  validateText("--region", options.region, /^[a-z0-9-]+-\d+$/);
  validateText("--account", options.account, /^\d{12}$/);
  validateText(
    "--stack-name",
    options.stackName,
    /^[A-Za-z][A-Za-z0-9-]{0,127}$/,
  );
  if (options.domainPrefix) {
    validateDomainPrefix(options.domainPrefix);
  }
  return options;
};

const scrubAmbientCredentials = () => {
  const allowedAwsVariables = new Set([
    "AWS_CA_BUNDLE",
    "AWS_CONFIG_FILE",
    "AWS_SDK_LOAD_CONFIG",
    "AWS_SHARED_CREDENTIALS_FILE",
  ]);
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("AWS_") && !allowedAwsVariables.has(name)) continue;
    if (name.startsWith("CDK_")) continue;
    if (name.startsWith("HTML_SLIDE_EDITOR_")) continue;
    environment[name] = value;
  }
  environment.AWS_CLI_AUTO_PROMPT = "off";
  environment.AWS_PAGER = "";
  return environment;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw new CliError(`${command} could not start: ${result.error.message}`, 1);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? result.stderr.trim() : "";
    throw new CliError(
      `${command} exited with status ${result.status}${detail ? `: ${detail}` : ""}`,
      1,
    );
  }
  return result;
};

const resolveIdentity = ({ profile, region }) => {
  const result = run(
    "aws",
    [
      "sts",
      "get-caller-identity",
      "--profile",
      profile,
      "--region",
      region,
      "--output",
      "json",
    ],
    {
      capture: true,
      env: {
        ...scrubAmbientCredentials(),
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
      },
    },
  );
  let identity;
  try {
    identity = JSON.parse(result.stdout);
  } catch (cause) {
    throw new CliError(`AWS identity response is not JSON: ${cause.message}`, 1);
  }
  if (!/^\d{12}$/.test(identity.Account ?? "") || !identity.Arn) {
    throw new CliError("AWS identity response is missing Account or Arn", 1);
  }
  return identity;
};

const describeStack = (options) => {
  const result = run(
    "aws",
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      options.stackName,
      "--profile",
      options.profile,
      "--region",
      options.region,
      "--output",
      "json",
    ],
    {
      allowFailure: true,
      capture: true,
      env: {
        ...scrubAmbientCredentials(),
        AWS_REGION: options.region,
        AWS_DEFAULT_REGION: options.region,
      },
    },
  );
  if (result.status !== 0) {
    if (/Stack with id .* does not exist/i.test(result.stderr)) return null;
    throw new CliError(
      `Unable to inspect stack ${options.stackName}: ${result.stderr.trim()}`,
      1,
    );
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (cause) {
    throw new CliError(`Stack response is not JSON: ${cause.message}`, 1);
  }
  if (!Array.isArray(payload.Stacks) || payload.Stacks.length !== 1) {
    throw new CliError(
      `Expected exactly one stack named ${options.stackName}`,
      1,
    );
  }
  return payload.Stacks[0];
};

const verifyStackOwnership = (options, stack, domainPrefix) => {
  if (!stack) {
    if (options.command === "destroy") {
      throw new CliError(`${options.stackName} does not exist`);
    }
    return;
  }
  const managed = stack.Tags?.some(
    (tag) => tag.Key === ownershipTag.key && tag.Value === ownershipTag.value,
  );
  if (!managed) {
    throw new CliError(
      `${options.stackName} exists but is not managed by this deployment tool`,
    );
  }
  if (options.command !== "deploy") return;

  const hostedUiDomain = stack.Outputs?.find(
    (output) => output.OutputKey === "HostedUiDomain",
  )?.OutputValue;
  const existingPrefix = hostedUiDomain?.split(".auth.")[0];
  if (!existingPrefix) {
    throw new CliError(
      `${options.stackName} has no HostedUiDomain output; refusing to update it`,
    );
  }
  if (existingPrefix !== domainPrefix) {
    throw new CliError(
      `Hosted UI prefix is immutable for an existing stack: ${existingPrefix}`,
    );
  }
};

const defaultDomainPrefix = ({ account, region, stackName }) => {
  const slug = stackName
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 43);
  const digest = createHash("sha256")
    .update(`${account}:${region}:${stackName}`)
    .digest("hex")
    .slice(0, 12);
  return validateDomainPrefix(`hse-${slug}-${digest}`);
};

const createPlan = (options, account) => {
  const cdk = ["exec", "--", "cdk"];
  const profile = ["--profile", options.profile];
  const step = (command, args, cwd) => ({ command, args, cwd });
  if (options.command === "bootstrap") {
    return [
      step(
        "npm",
        [
          ...cdk,
          "bootstrap",
          `aws://${account}/${options.region}`,
          ...profile,
        ],
        "infra",
      ),
    ];
  }
  if (options.command === "destroy") {
    return [
      step(
        "npm",
        [
          ...cdk,
          "destroy",
          options.stackName,
          ...profile,
        ],
        "infra",
      ),
    ];
  }
  return [
    step("npm", ["run", "build"]),
    step("npm", ["run", "build"], "infra"),
    step("npm", [...cdk, "synth", options.stackName, ...profile], "infra"),
    step(
      "npm",
      [...cdk, "diff", options.stackName, ...profile, "--no-change-set"],
      "infra",
    ),
    step(
      "npm",
      [
        ...cdk,
        "deploy",
        options.stackName,
        ...profile,
        "--require-approval",
        options.yes ? "never" : "broadening",
      ],
      "infra",
    ),
  ];
};

const shellQuote = (value) =>
  /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

const printPlan = (plan) => {
  process.stdout.write("\nCommands:\n");
  for (const { command, args, cwd } of plan) {
    const rendered = [command, ...args].map(shellQuote).join(" ");
    process.stdout.write(
      `  ${cwd ? `(cd ${shellQuote(cwd)} && ${rendered})` : rendered}\n`,
    );
  }
};

const confirmTarget = async (options) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (options.command === "destroy") {
      throw new CliError(
        "destroy requires an interactive terminal; --yes is not allowed",
      );
    }
    throw new CliError(
      "Interactive confirmation is unavailable; inspect --dry-run, then pass --yes",
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const question =
    options.command === "destroy"
      ? `Type ${options.stackName} to destroy it in ${options.account}/${options.region}: `
      : `Proceed with ${options.command} for ${options.stackName} in ${options.account}/${options.region}? [y/N] `;
  const answer = await prompt.question(question);
  prompt.close();
  const confirmed =
    options.command === "destroy"
      ? answer.trim() === options.stackName
      : /^y(?:es)?$/i.test(answer.trim());
  if (!confirmed) {
    throw new CliError("Deployment cancelled", 1);
  }
};

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage);
    return;
  }

  const options = parseArgs(argv);
  if (!existsSync(cdkBin)) {
    throw new CliError(
      "Run `npm --prefix infra ci` before AWS deployment commands.",
      1,
    );
  }
  const identity = resolveIdentity(options);
  if (identity.Account !== options.account) {
    throw new CliError(
      `Profile resolved to account ${identity.Account}, expected ${options.account}`,
    );
  }
  const domainPrefix =
    options.domainPrefix ??
    defaultDomainPrefix({
      account: identity.Account,
      region: options.region,
      stackName: options.stackName,
    });
  if (options.command !== "bootstrap") {
    verifyStackOwnership(options, describeStack(options), domainPrefix);
  }
  const environment = {
    ...scrubAmbientCredentials(),
    AWS_REGION: options.region,
    AWS_DEFAULT_REGION: options.region,
    CDK_DEFAULT_ACCOUNT: identity.Account,
    CDK_DEFAULT_REGION: options.region,
    HTML_SLIDE_EDITOR_DOMAIN_PREFIX: domainPrefix,
    HTML_SLIDE_EDITOR_STACK_NAME: options.stackName,
    HTML_SLIDE_EDITOR_SITE_ASSET_DIR:
      options.command === "deploy"
        ? join(repoRoot, "dist")
        : join(repoRoot, "tests", "fixtures"),
  };
  const plan = createPlan(options, identity.Account);

  process.stdout.write(`Account: ${identity.Account}\n`);
  process.stdout.write(`Principal: ${identity.Arn}\n`);
  process.stdout.write(`Region: ${options.region}\n`);
  process.stdout.write(`Stack: ${options.stackName}\n`);
  process.stdout.write(`Domain prefix: ${domainPrefix}\n`);
  printPlan(plan);

  if (options.dryRun) return;
  const approvalIndex = options.command === "deploy" ? plan.length - 1 : 0;
  for (const { command, args, cwd } of plan.slice(0, approvalIndex)) {
    run(command, args, {
      cwd: cwd ? join(repoRoot, cwd) : repoRoot,
      env: environment,
    });
  }
  if (!options.yes) await confirmTarget(options);
  for (const { command, args, cwd } of plan.slice(approvalIndex)) {
    run(command, args, {
      cwd: cwd ? join(repoRoot, cwd) : repoRoot,
      env: environment,
    });
  }
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
}
