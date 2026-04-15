import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { join } from "node:path";

export class SlackAiAssistantStack extends Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const anthropicAgentId = this.node.tryGetContext("anthropicAgentId") ?? "agent_placeholder";
    const anthropicEnvironmentId =
      this.node.tryGetContext("anthropicEnvironmentId") ?? "env_placeholder";
    const anthropicVaultIds = this.node.tryGetContext("anthropicVaultIds") ?? "";
    const slackSigningSecretName =
      this.node.tryGetContext("slackSigningSecretName") ??
      "/slack-ai-assistant/slack-signing-secret";
    const slackBotTokenSecretName =
      this.node.tryGetContext("slackBotTokenSecretName") ??
      "/slack-ai-assistant/slack-bot-token";
    const anthropicApiKeySecretName =
      this.node.tryGetContext("anthropicApiKeySecretName") ??
      "/slack-ai-assistant/anthropic-api-key";
    const defaultScheduleChannel =
      this.node.tryGetContext("defaultScheduleChannel") ?? "C_PLACEHOLDER";

    const sessionTable = new dynamodb.Table(this, "SlackThreadSessionsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const userMemoryTable = new dynamodb.Table(this, "UserMemoriesTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const memoryItemsTable = new dynamodb.Table(this, "MemoryItemsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    memoryItemsTable.addGlobalSecondaryIndex({
      indexName: "EntityIndex",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const tasksTable = new dynamodb.Table(this, "TasksTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    tasksTable.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const taskEventsTable = new dynamodb.Table(this, "TaskEventsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const processedEventsTable = new dynamodb.Table(this, "ProcessedEventsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const scheduledTasksTable = new dynamodb.Table(this, "ScheduledTasksTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const dlq = new sqs.Queue(this, "SlackEventsDlq", {
      retentionPeriod: Duration.days(14),
    });

    const slackEventsQueue = new sqs.Queue(this, "SlackEventsQueue", {
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    const commonEnvironment = {
      SESSION_TABLE_NAME: sessionTable.tableName,
      USER_MEMORY_TABLE_NAME: userMemoryTable.tableName,
      MEMORY_ITEMS_TABLE_NAME: memoryItemsTable.tableName,
      TASKS_TABLE_NAME: tasksTable.tableName,
      TASK_EVENTS_TABLE_NAME: taskEventsTable.tableName,
      PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.tableName,
      TASK_TABLE_NAME: scheduledTasksTable.tableName,
      SLACK_SIGNING_SECRET_SECRET_ID: slackSigningSecretName,
      SLACK_BOT_TOKEN_SECRET_ID: slackBotTokenSecretName,
      ANTHROPIC_API_KEY_SECRET_ID: anthropicApiKeySecretName,
      ANTHROPIC_AGENT_ID: anthropicAgentId,
      ANTHROPIC_ENVIRONMENT_ID: anthropicEnvironmentId,
      ANTHROPIC_VAULT_IDS: anthropicVaultIds,
      ANTHROPIC_MANAGED_AGENTS_BETA: "managed-agents-2026-04-01",
      ENABLE_USER_MEMORY: "false",
      DEFAULT_SCHEDULE_CHANNEL: defaultScheduleChannel,
      EVENT_DEDUP_TTL_SECONDS: "86400",
      AGENT_RESPONSE_TIMEOUT_MS: "120000",
      MAX_SLACK_FILE_BYTES: "10000000",
    };

    const ingress = new nodejs.NodejsFunction(this, "SlackEventsIngressFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(__dirname, "../src/functions/slack-events-ingress/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        ...commonEnvironment,
        SLACK_QUEUE_URL: slackEventsQueue.queueUrl,
      },
      bundling: {
        target: "node20",
      },
    });

    const worker = new nodejs.NodejsFunction(this, "SlackEventsWorkerFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(__dirname, "../src/functions/slack-events-worker/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: commonEnvironment,
      bundling: {
        target: "node20",
      },
    });

    const scheduledRunner = new nodejs.NodejsFunction(this, "ScheduledAgentRunnerFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(__dirname, "../src/functions/scheduled-agent-runner/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: commonEnvironment,
      bundling: {
        target: "node20",
      },
    });

    worker.addEventSource(
      new eventsources.SqsEventSource(slackEventsQueue, {
        batchSize: 1,
      }),
    );

    slackEventsQueue.grantSendMessages(ingress);
    sessionTable.grantReadWriteData(worker);
    sessionTable.grantReadWriteData(scheduledRunner);
    userMemoryTable.grantReadWriteData(worker);
    userMemoryTable.grantReadWriteData(scheduledRunner);
    memoryItemsTable.grantReadWriteData(worker);
    memoryItemsTable.grantReadWriteData(scheduledRunner);
    tasksTable.grantReadWriteData(worker);
    tasksTable.grantReadWriteData(scheduledRunner);
    taskEventsTable.grantReadWriteData(worker);
    taskEventsTable.grantReadWriteData(scheduledRunner);
    processedEventsTable.grantReadWriteData(ingress);
    scheduledTasksTable.grantReadWriteData(scheduledRunner);

    const slackSigningSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SlackSigningSecret",
      slackSigningSecretName,
    );
    const slackBotTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SlackBotTokenSecret",
      slackBotTokenSecretName,
    );
    const anthropicApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AnthropicApiKeySecret",
      anthropicApiKeySecretName,
    );

    slackSigningSecret.grantRead(ingress);
    slackBotTokenSecret.grantRead(worker);
    slackBotTokenSecret.grantRead(scheduledRunner);
    anthropicApiKeySecret.grantRead(worker);
    anthropicApiKeySecret.grantRead(scheduledRunner);

    const api = new apigateway.RestApi(this, "SlackEventsApi", {
      restApiName: "slack-ai-assistant-events",
      deployOptions: {
        stageName: "prod",
      },
    });

    const slackEventsResource = api.root.addResource("slack").addResource("events");
    slackEventsResource.addMethod("POST", new apigateway.LambdaIntegration(ingress));

    const schedulerInvokeRole = new iam.Role(this, "SchedulerInvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    scheduledRunner.grantInvoke(schedulerInvokeRole);

    new scheduler.CfnSchedule(this, "DailySummarySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "cron(0 9 * * ? *)",
      scheduleExpressionTimezone: "Asia/Tokyo",
      state: "ENABLED",
      target: {
        arn: scheduledRunner.functionArn,
        roleArn: schedulerInvokeRole.roleArn,
        input: JSON.stringify({
          taskId: "daily-summary",
        }),
      },
    });

    new cdk.CfnOutput(this, "SlackEventsUrl", {
      value: `${api.url}slack/events`,
    });
    new cdk.CfnOutput(this, "SlackEventsQueueUrl", {
      value: slackEventsQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "ScheduledAgentRunnerFunctionName", {
      value: scheduledRunner.functionName,
    });
    new cdk.CfnOutput(this, "SlackEventsIngressFunctionName", {
      value: ingress.functionName,
    });
    new cdk.CfnOutput(this, "SlackEventsWorkerFunctionName", {
      value: worker.functionName,
    });
    new cdk.CfnOutput(this, "ScheduledTasksTableName", {
      value: scheduledTasksTable.tableName,
    });
    new cdk.CfnOutput(this, "MemoryItemsTableName", {
      value: memoryItemsTable.tableName,
    });
    new cdk.CfnOutput(this, "TasksTableName", {
      value: tasksTable.tableName,
    });
    new cdk.CfnOutput(this, "TaskEventsTableName", {
      value: taskEventsTable.tableName,
    });
  }
}
