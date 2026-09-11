import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const infraDir = join(repoRoot, "infra");
const cdkBin = join(infraDir, "node_modules", ".bin", "cdk");

const assertCdkInstalled = () => {
  assert.ok(
    existsSync(cdkBin),
    "Run `npm --prefix infra ci` before deployment tests.",
  );
};

const isolatedAwsEnvironment = (directory, overrides) => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("AWS_") &&
        !name.startsWith("CDK_") &&
        !name.startsWith("HTML_SLIDE_EDITOR_"),
    ),
  );
  const configFile = join(directory, "aws-config");
  const credentialsFile = join(directory, "aws-credentials");
  writeFileSync(configFile, "");
  writeFileSync(credentialsFile, "");
  return {
    ...environment,
    AWS_CONFIG_FILE: configFile,
    AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
    AWS_EC2_METADATA_DISABLED: "true",
    ...overrides,
  };
};

test("synthesizes for the caller-selected AWS environment", () => {
  assertCdkInstalled();
  const outputDir = mkdtempSync(join(tmpdir(), "html-slide-editor-cdk-"));
  const siteDir = mkdtempSync(join(tmpdir(), "html-slide-editor-site-"));
  writeFileSync(join(siteDir, "index.html"), "<!doctype html><title>test</title>");
  try {
    const result = spawnSync(
      cdkBin,
      ["synth", "CoworkerSlideEditor", "--output", outputDir],
      {
        cwd: infraDir,
        encoding: "utf8",
        env: isolatedAwsEnvironment(outputDir, {
          AWS_REGION: "ap-northeast-2",
          AWS_DEFAULT_REGION: "ap-northeast-2",
          CDK_DEFAULT_ACCOUNT: "123456789012",
          CDK_DEFAULT_REGION: "ap-northeast-2",
          HTML_SLIDE_EDITOR_DOMAIN_PREFIX: "coworker-editor-123",
          HTML_SLIDE_EDITOR_STACK_NAME: "CoworkerSlideEditor",
          HTML_SLIDE_EDITOR_SITE_ASSET_DIR: siteDir,
        }),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const templateName = readdirSync(outputDir).find((name) =>
      name.endsWith(".template.json"),
    );
    assert.equal(templateName, "CoworkerSlideEditor.template.json");

    const templateText = readFileSync(join(outputDir, templateName), "utf8");
    const template = JSON.parse(templateText);
    const userPoolDomain = Object.values(template.Resources).find(
      (resource) => resource.Type === "AWS::Cognito::UserPoolDomain",
    );
    const userPool = Object.values(template.Resources).find(
      (resource) => resource.Type === "AWS::Cognito::UserPool",
    );
    assert.equal(
      userPoolDomain.Properties.Domain,
      "coworker-editor-123",
    );
    assert.equal(userPool.Properties.DeletionProtection, "ACTIVE");
    assert.equal(
      userPool.Properties.Policies.PasswordPolicy
        .TemporaryPasswordValidityDays,
      7,
    );

    const manifestText = readFileSync(join(outputDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.match(manifestText, /aws:\/\/123456789012\/ap-northeast-2/);
    assert.deepEqual(
      manifest.artifacts.CoworkerSlideEditor.properties.tags,
      {
        "html-slide-editor:managed-by": "html-slide-editor-deploy",
      },
    );
    assert.doesNotMatch(templateText, /html-slide-editor-123456789012/);
    assert.doesNotMatch(templateText, /localhost|127\.0\.0\.1/);

    const bucket = Object.values(template.Resources).find(
      (resource) => resource.Type === "AWS::S3::Bucket",
    );
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    assert.equal(bucket.DeletionPolicy, "Retain");
    assert.equal(bucket.UpdateReplacePolicy, "Retain");

    const originAccessControl = Object.values(template.Resources).find(
      (resource) => resource.Type === "AWS::CloudFront::OriginAccessControl",
    );
    assert.equal(
      originAccessControl.Properties.OriginAccessControlConfig.SigningBehavior,
      "always",
    );
    assert.equal(
      originAccessControl.Properties.OriginAccessControlConfig.SigningProtocol,
      "sigv4",
    );

    const distribution = Object.values(template.Resources).find(
      (resource) => resource.Type === "AWS::CloudFront::Distribution",
    );
    assert.equal(
      distribution.Properties.DistributionConfig.DefaultCacheBehavior
        .ViewerProtocolPolicy,
      "redirect-to-https",
    );

    const userPoolClient = Object.values(template.Resources).find(
      (resource) => resource.Type === "AWS::Cognito::UserPoolClient",
    );
    assert.equal(userPool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
    assert.equal(userPool.DeletionPolicy, "Retain");
    assert.equal(userPoolClient.Properties.GenerateSecret, false);
    assert.deepEqual(userPoolClient.Properties.AllowedOAuthFlows, ["code"]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(siteDir, { recursive: true, force: true });
  }
});

test("refuses a direct synth without an explicit Hosted UI prefix", () => {
  assertCdkInstalled();
  const outputDir = mkdtempSync(join(tmpdir(), "html-slide-editor-cdk-"));
  const siteDir = mkdtempSync(join(tmpdir(), "html-slide-editor-site-"));
  writeFileSync(join(siteDir, "index.html"), "<!doctype html><title>test</title>");
  try {
    const result = spawnSync(cdkBin, ["synth", "--output", outputDir], {
      cwd: infraDir,
      encoding: "utf8",
      env: isolatedAwsEnvironment(outputDir, {
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-east-1",
        CDK_DEFAULT_ACCOUNT: "123456789012",
        CDK_DEFAULT_REGION: "us-east-1",
        HTML_SLIDE_EDITOR_SITE_ASSET_DIR: siteDir,
      }),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTML_SLIDE_EDITOR_DOMAIN_PREFIX is required/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(siteDir, { recursive: true, force: true });
  }
});

test("refuses a direct synth without an explicit site asset directory", () => {
  assertCdkInstalled();
  const outputDir = mkdtempSync(join(tmpdir(), "html-slide-editor-cdk-"));
  try {
    const result = spawnSync(cdkBin, ["synth", "--output", outputDir], {
      cwd: infraDir,
      encoding: "utf8",
      env: isolatedAwsEnvironment(outputDir, {
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-east-1",
        CDK_DEFAULT_ACCOUNT: "123456789012",
        CDK_DEFAULT_REGION: "us-east-1",
        HTML_SLIDE_EDITOR_DOMAIN_PREFIX: "coworker-editor-123",
      }),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTML_SLIDE_EDITOR_SITE_ASSET_DIR is required/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
