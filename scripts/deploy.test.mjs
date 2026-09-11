import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const deployScript = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
const repoRoot = dirname(dirname(deployScript));
let fakeBin;
let fakeRoot;

before(() => {
  fakeRoot = mkdtempSync(join(tmpdir(), "html-slide-editor-deploy-"));
  fakeBin = join(fakeRoot, "bin");
  mkdirSync(fakeBin);
  const fakeAws = join(fakeBin, "aws");
  writeFileSync(
    fakeAws,
    `#!/bin/sh
if [ -n "$AWS_ACCESS_KEY_ID" ] || [ -n "$AWS_SECRET_ACCESS_KEY" ] || [ -n "$AWS_SESSION_TOKEN" ] || [ -n "$AWS_ENDPOINT_URL" ] || [ -n "$AWS_ENDPOINT_URL_STS" ]; then
  printf '%s\\n' "ambient credential leaked" >&2
  exit 8
fi
if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then
  printf '%s\\n' '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/coworker","UserId":"AIDATEST"}'
  exit 0
fi
if [ "$1" = "cloudformation" ] && [ "$2" = "describe-stacks" ]; then
  case "$FAKE_STACK_MODE" in
    owned)
      printf '%s\\n' '{"Stacks":[{"StackName":"HtmlSlideEditorStack","Tags":[{"Key":"html-slide-editor:managed-by","Value":"html-slide-editor-deploy"}]}]}'
      ;;
    owned-other-domain)
      printf '%s\\n' '{"Stacks":[{"StackName":"HtmlSlideEditorStack","Tags":[{"Key":"html-slide-editor:managed-by","Value":"html-slide-editor-deploy"}],"Outputs":[{"OutputKey":"HostedUiDomain","OutputValue":"legacy-prefix.auth.us-east-1.amazoncognito.com"}]}]}'
      ;;
    owned-same-domain)
      printf '%s\\n' '{"Stacks":[{"StackName":"HtmlSlideEditorStack","Tags":[{"Key":"html-slide-editor:managed-by","Value":"html-slide-editor-deploy"}],"Outputs":[{"OutputKey":"HostedUiDomain","OutputValue":"hse-htmlslideeditorstack-278b820e93fd.auth.us-east-1.amazoncognito.com"}]}]}'
      ;;
    unowned)
      printf '%s\\n' '{"Stacks":[{"StackName":"HtmlSlideEditorStack","Tags":[]}]}'
      ;;
    empty-success)
      printf '%s\\n' '{"Stacks":[]}'
      ;;
    validation-error)
      printf '%s\\n' 'An error occurred (ValidationError) when calling DescribeStacks: invalid request' >&2
      exit 255
      ;;
    *)
      printf '%s\\n' 'An error occurred (ValidationError) when calling DescribeStacks: Stack with id HtmlSlideEditorStack does not exist' >&2
      exit 255
      ;;
  esac
  exit 0
fi
printf '%s\\n' "unexpected aws command: $*" >&2
exit 9
`,
  );
  chmodSync(fakeAws, 0o755);

  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(
    fakeNpm,
    `#!/bin/sh
if [ -n "$AWS_ACCESS_KEY_ID" ] || [ -n "$AWS_SECRET_ACCESS_KEY" ] || [ -n "$AWS_SESSION_TOKEN" ]; then
  printf '%s\\n' "ambient credential leaked to npm" >&2
  exit 8
fi
printf '%s|%s\\n' "$PWD" "$*" >> "$DEPLOY_LOG"
exit 0
`,
  );
  chmodSync(fakeNpm, 0o755);
});

after(() => {
  rmSync(fakeRoot, { recursive: true, force: true });
});

const runDeploy = (args, env = {}) =>
  spawnSync(process.execPath, [deployScript, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });

test("prints deployment help without invoking AWS", () => {
  const result = spawnSync(process.execPath, [deployScript, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm run infra:deploy/);
  assert.match(result.stdout, /--profile/);
  assert.match(result.stdout, /--region/);
});

test("requires an explicit AWS profile and region", () => {
  const missingProfile = runDeploy([
    "deploy",
    "--region",
    "us-east-1",
    "--dry-run",
  ]);
  const missingRegion = runDeploy([
    "deploy",
    "--profile",
    "coworker-dev",
    "--dry-run",
  ]);

  assert.equal(missingProfile.status, 2);
  assert.match(missingProfile.stderr, /--profile is required/);
  assert.equal(missingRegion.status, 2);
  assert.match(missingRegion.stderr, /--region is required/);
});

test("requires the intended account and rejects an STS mismatch", () => {
  const missingAccount = runDeploy([
    "deploy",
    "--profile",
    "coworker-dev",
    "--region",
    "us-east-1",
    "--dry-run",
  ]);
  const mismatch = runDeploy([
    "deploy",
    "--profile",
    "coworker-dev",
    "--region",
    "us-east-1",
    "--account",
    "999999999999",
    "--dry-run",
  ]);

  assert.equal(missingAccount.status, 2);
  assert.match(missingAccount.stderr, /--account is required/);
  assert.equal(mismatch.status, 2);
  assert.match(
    mismatch.stderr,
    /Profile resolved to account 123456789012, expected 999999999999/,
  );
});

test("rejects raw credential options", () => {
  const result = runDeploy([
    "deploy",
    "--profile",
    "coworker-dev",
    "--region",
    "us-east-1",
    "--account",
    "123456789012",
    "--access-key",
    "AKIAEXAMPLE",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option: --access-key/);
  assert.doesNotMatch(result.stdout, /AKIAEXAMPLE/);
});

test("plans deployment for the account resolved by STS", () => {
  const result = runDeploy([
    "deploy",
    "--profile",
    "coworker-dev",
    "--region",
    "us-east-1",
    "--account",
    "123456789012",
    "--dry-run",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Account: 123456789012/);
  assert.match(
    result.stdout,
    /Principal: arn:aws:iam::123456789012:user\/coworker/,
  );
  assert.match(result.stdout, /Region: us-east-1/);
  assert.match(
    result.stdout,
    /Domain prefix: hse-htmlslideeditorstack-[a-f0-9]{12}/,
  );
  assert.doesNotMatch(
    result.stdout.match(/Domain prefix: (.*)/)?.[1] ?? "",
    /123456789012/,
  );
  assert.match(result.stdout, /npm run build/);
  assert.match(
    result.stdout,
    /\(cd infra && npm exec -- cdk synth HtmlSlideEditorStack/,
  );
  assert.match(
    result.stdout,
    /\(cd infra && npm exec -- cdk diff HtmlSlideEditorStack .*--no-change-set/,
  );
  assert.match(
    result.stdout,
    /\(cd infra && npm exec -- cdk deploy HtmlSlideEditorStack/,
  );
  assert.doesNotMatch(result.stdout, /cdk bootstrap/);
});

test("keeps bootstrap separate from deployment", () => {
  const result = runDeploy([
    "bootstrap",
    "--profile",
    "coworker-dev",
    "--region",
    "ap-northeast-2",
    "--account",
    "123456789012",
    "--dry-run",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /cdk bootstrap aws:\/\/123456789012\/ap-northeast-2/,
  );
  assert.doesNotMatch(result.stdout, /npm run build/);
  assert.doesNotMatch(result.stdout, /cdk deploy/);
});

test("plans destruction against the same explicit account and region", () => {
  const result = runDeploy(
    [
      "destroy",
      "--profile",
      "coworker-dev",
      "--region",
      "eu-west-1",
      "--account",
      "123456789012",
      "--dry-run",
    ],
    { FAKE_STACK_MODE: "owned" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Account: 123456789012/);
  assert.match(result.stdout, /Region: eu-west-1/);
  assert.match(result.stdout, /cdk destroy HtmlSlideEditorStack/);
  assert.doesNotMatch(result.stdout, /npm run build|cdk bootstrap|cdk deploy/);
});

test("refuses to update a stack that lacks the ownership marker", () => {
  const result = runDeploy(
    [
      "deploy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
      "--dry-run",
    ],
    { FAKE_STACK_MODE: "unowned" },
  );

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /HtmlSlideEditorStack exists but is not managed by this deployment tool/,
  );
});

test("refuses to replace the Hosted UI prefix on an existing stack", () => {
  const result = runDeploy(
    [
      "deploy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
      "--domain-prefix",
      "new-prefix",
      "--dry-run",
    ],
    { FAKE_STACK_MODE: "owned-other-domain" },
  );

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /Hosted UI prefix is immutable for an existing stack: legacy-prefix/,
  );
});

test("allows an owned stack update when the Hosted UI prefix matches", () => {
  const result = runDeploy(
    [
      "deploy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
      "--dry-run",
    ],
    { FAKE_STACK_MODE: "owned-same-domain" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cdk deploy HtmlSlideEditorStack/);
});

test("rejects Cognito reserved words in generated and explicit prefixes", () => {
  const explicit = runDeploy([
    "deploy",
    "--profile",
    "coworker-dev",
    "--region",
    "us-east-1",
    "--account",
    "123456789012",
    "--domain-prefix",
    "amazon-slide-editor",
    "--dry-run",
  ]);
  const generated = runDeploy([
    "deploy",
    "--profile",
    "coworker-dev",
    "--region",
    "us-east-1",
    "--account",
    "123456789012",
    "--stack-name",
    "AwsSlideEditor",
    "--dry-run",
  ]);

  assert.equal(explicit.status, 2);
  assert.match(explicit.stderr, /Cognito domain prefix cannot contain amazon/);
  assert.equal(generated.status, 2);
  assert.match(generated.stderr, /Cognito domain prefix cannot contain aws/);
});

test("refuses to destroy a missing stack or bypass confirmation", () => {
  const missing = runDeploy([
    "destroy",
    "--profile",
    "coworker-dev",
    "--region",
    "us-east-1",
    "--account",
    "123456789012",
    "--dry-run",
  ]);
  const bypass = runDeploy(
    [
      "destroy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
      "--yes",
      "--dry-run",
    ],
    { FAKE_STACK_MODE: "owned" },
  );
  const bootstrapBypass = runDeploy([
    "bootstrap",
    "--profile",
    "coworker-dev",
    "--region",
    "us-east-1",
    "--account",
    "123456789012",
    "--yes",
    "--dry-run",
  ]);

  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /HtmlSlideEditorStack does not exist/);
  assert.equal(bypass.status, 2);
  assert.match(bypass.stderr, /--yes is only allowed with deploy/);
  assert.equal(bootstrapBypass.status, 2);
  assert.match(
    bootstrapBypass.stderr,
    /--yes is only allowed with deploy/,
  );
});

test("fails closed on an unexpected CloudFormation validation error", () => {
  const result = runDeploy(
    [
      "deploy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
      "--dry-run",
    ],
    { FAKE_STACK_MODE: "validation-error" },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Unable to inspect stack HtmlSlideEditorStack/,
  );
});

test("fails closed when describe-stacks returns an empty success payload", () => {
  const result = runDeploy(
    [
      "deploy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
      "--dry-run",
    ],
    { FAKE_STACK_MODE: "empty-success" },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Expected exactly one stack named HtmlSlideEditorStack/,
  );
});
test("removes ambient static credentials before resolving the profile", () => {
  const result = runDeploy(
    [
      "deploy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
      "--dry-run",
    ],
    {
      AWS_ACCESS_KEY_ID: "AKIAAMBIENT",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
      AWS_SESSION_TOKEN: "ambient-session",
      AWS_ENDPOINT_URL: "https://example.invalid",
      AWS_ENDPOINT_URL_STS: "https://sts.example.invalid",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /AKIAAMBIENT|ambient-secret|ambient-session|example\.invalid/,
  );
});

test("executes build, synth, diff, and deploy from the intended directories", () => {
  const logPath = join(fakeRoot, "npm-execution.log");
  writeFileSync(logPath, "");
  const result = runDeploy(
    [
      "deploy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
      "--yes",
    ],
    {
      DEPLOY_LOG: logPath,
      AWS_ACCESS_KEY_ID: "AKIAAMBIENT",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
      AWS_SESSION_TOKEN: "ambient-session",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.deepEqual(lines, [
    `${repoRoot}|run build`,
    `${repoRoot}/infra|run build`,
    `${repoRoot}/infra|exec -- cdk synth HtmlSlideEditorStack --profile coworker-dev`,
    `${repoRoot}/infra|exec -- cdk diff HtmlSlideEditorStack --profile coworker-dev --no-change-set`,
    `${repoRoot}/infra|exec -- cdk deploy HtmlSlideEditorStack --profile coworker-dev --require-approval never`,
  ]);
});

test("does not deploy or destroy when interactive confirmation is unavailable", () => {
  const deployLog = join(fakeRoot, "npm-no-confirm-deploy.log");
  writeFileSync(deployLog, "");
  const deploy = runDeploy(
    [
      "deploy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
    ],
    { DEPLOY_LOG: deployLog },
  );

  assert.equal(deploy.status, 2);
  assert.match(deploy.stderr, /Interactive confirmation is unavailable/);
  assert.doesNotMatch(readFileSync(deployLog, "utf8"), /cdk deploy/);

  const destroyLog = join(fakeRoot, "npm-no-confirm-destroy.log");
  writeFileSync(destroyLog, "");
  const destroy = runDeploy(
    [
      "destroy",
      "--profile",
      "coworker-dev",
      "--region",
      "us-east-1",
      "--account",
      "123456789012",
    ],
    {
      DEPLOY_LOG: destroyLog,
      FAKE_STACK_MODE: "owned",
    },
  );

  assert.equal(destroy.status, 2);
  assert.match(
    destroy.stderr,
    /destroy requires an interactive terminal; --yes is not allowed/,
  );
  assert.equal(readFileSync(destroyLog, "utf8"), "");
});
