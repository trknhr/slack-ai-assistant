#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as cdk from "aws-cdk-lib";
import { parse } from "dotenv";
import { SlackAiAssistantStack } from "../lib/slack-ai-assistant-stack";

loadLocalEnvFiles();

const app = new cdk.App();

new SlackAiAssistantStack(app, "SlackAiAssistantStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
});

function loadLocalEnvFiles(): void {
  const mergedValues: Record<string, string> = {};
  const envPaths = [".env", ".env.local"].map((filePath) => resolve(process.cwd(), filePath));

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) {
      continue;
    }

    Object.assign(mergedValues, parse(readFileSync(envPath)));
  }

  for (const [key, value] of Object.entries(mergedValues)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
