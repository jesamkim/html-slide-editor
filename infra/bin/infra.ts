#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HtmlSlideEditorStack } from '../lib/html-slide-editor-stack';

const app = new cdk.App();
const requiredEnvironment = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required. Use the repository deployment command with an AWS profile.`,
    );
  }
  return value;
};

const account = requiredEnvironment('CDK_DEFAULT_ACCOUNT');
const region = requiredEnvironment('CDK_DEFAULT_REGION');
const stackName =
  process.env.HTML_SLIDE_EDITOR_STACK_NAME ?? 'HtmlSlideEditorStack';
const hostedUiPrefix = requiredEnvironment(
  'HTML_SLIDE_EDITOR_DOMAIN_PREFIX',
);
const siteAssetDir = requiredEnvironment(
  'HTML_SLIDE_EDITOR_SITE_ASSET_DIR',
);

new HtmlSlideEditorStack(app, stackName, {
  env: {
    account,
    region,
  },
  hostedUiPrefix,
  siteAssetDir,
  tags: {
    'html-slide-editor:managed-by': 'html-slide-editor-deploy',
  },
  description: 'Static hosting and Cognito authentication for the HTML slide editor',
});
