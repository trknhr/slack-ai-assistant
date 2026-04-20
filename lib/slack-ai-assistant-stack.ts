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
import * as s3 from "aws-cdk-lib/aws-s3";
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
    const googleCalendarSecretName =
      this.node.tryGetContext("googleCalendarSecretName") ??
      "/slack-ai-assistant/google-calendar";
    const googleCalendarTimeZone =
      this.node.tryGetContext("googleCalendarTimeZone") ?? "Asia/Tokyo";
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

    const calendarDraftsTable = new dynamodb.Table(this, "CalendarDraftsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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

    const sourceDocumentsTable = new dynamodb.Table(this, "SourceDocumentsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const attachmentArchiveBucket = new s3.Bucket(this, "SlackAttachmentArchiveBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
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

    const documentImportDlq = new sqs.Queue(this, "DocumentImportDlq", {
      retentionPeriod: Duration.days(14),
    });

    const documentImportQueue = new sqs.Queue(this, "DocumentImportQueue", {
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: {
        queue: documentImportDlq,
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

    const toolEnvironment = {
      CALENDAR_DRAFTS_TABLE_NAME: calendarDraftsTable.tableName,
      GOOGLE_CALENDAR_SECRET_ID: googleCalendarSecretName,
      GOOGLE_CALENDAR_TIME_ZONE: googleCalendarTimeZone,
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
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
        SOURCE_DOCUMENTS_TABLE_NAME: sourceDocumentsTable.tableName,
        SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME: attachmentArchiveBucket.bucketName,
      },
      bundling: {
        target: "node20",
      },
    });

    const documentImportApi = new nodejs.NodejsFunction(this, "DocumentImportApiFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(__dirname, "../src/functions/document-import-api/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...commonEnvironment,
        SOURCE_DOCUMENTS_TABLE_NAME: sourceDocumentsTable.tableName,
        DOCUMENT_IMPORT_QUEUE_URL: documentImportQueue.queueUrl,
        DOCUMENT_ARCHIVE_BUCKET_NAME: attachmentArchiveBucket.bucketName,
      },
      bundling: {
        target: "node20",
      },
    });

    const documentImportWorker = new nodejs.NodejsFunction(this, "DocumentImportWorkerFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(__dirname, "../src/functions/document-import-worker/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
        SOURCE_DOCUMENTS_TABLE_NAME: sourceDocumentsTable.tableName,
        DOCUMENT_ARCHIVE_BUCKET_NAME: attachmentArchiveBucket.bucketName,
      },
      bundling: {
        target: "node20",
      },
    });

    const chatApi = new nodejs.NodejsFunction(this, "ChatApiFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(__dirname, "../src/functions/chat-api/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
      },
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
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
      },
      bundling: {
        target: "node20",
      },
    });

    worker.addEventSource(
      new eventsources.SqsEventSource(slackEventsQueue, {
        batchSize: 1,
      }),
    );

    documentImportWorker.addEventSource(
      new eventsources.SqsEventSource(documentImportQueue, {
        batchSize: 1,
      }),
    );

    slackEventsQueue.grantSendMessages(ingress);
    documentImportQueue.grantSendMessages(documentImportApi);
    sessionTable.grantReadWriteData(worker);
    sessionTable.grantReadWriteData(scheduledRunner);
    userMemoryTable.grantReadWriteData(worker);
    userMemoryTable.grantReadWriteData(scheduledRunner);
    memoryItemsTable.grantReadWriteData(worker);
    memoryItemsTable.grantReadWriteData(scheduledRunner);
    memoryItemsTable.grantReadWriteData(documentImportWorker);
    memoryItemsTable.grantReadWriteData(chatApi);
    sourceDocumentsTable.grantReadWriteData(worker);
    sourceDocumentsTable.grantReadWriteData(documentImportApi);
    sourceDocumentsTable.grantReadWriteData(documentImportWorker);
    tasksTable.grantReadWriteData(worker);
    tasksTable.grantReadWriteData(scheduledRunner);
    tasksTable.grantReadWriteData(documentImportWorker);
    tasksTable.grantReadWriteData(chatApi);
    calendarDraftsTable.grantReadWriteData(worker);
    calendarDraftsTable.grantReadWriteData(scheduledRunner);
    calendarDraftsTable.grantReadWriteData(documentImportWorker);
    calendarDraftsTable.grantReadWriteData(chatApi);
    taskEventsTable.grantReadWriteData(worker);
    taskEventsTable.grantReadWriteData(scheduledRunner);
    taskEventsTable.grantReadWriteData(documentImportWorker);
    taskEventsTable.grantReadWriteData(chatApi);
    processedEventsTable.grantReadWriteData(ingress);
    scheduledTasksTable.grantReadWriteData(scheduledRunner);
    userMemoryTable.grantReadWriteData(chatApi);
    attachmentArchiveBucket.grantPut(worker, "raw/private/slack/*");
    attachmentArchiveBucket.grantPut(documentImportApi, "raw/private/imports/*");
    attachmentArchiveBucket.grantPut(documentImportApi, "raw/private/notes/*");
    attachmentArchiveBucket.grantRead(documentImportApi, "raw/private/imports/*");
    attachmentArchiveBucket.grantRead(documentImportApi, "derived/private/extractions/*");
    attachmentArchiveBucket.grantRead(documentImportWorker, "raw/private/imports/*");
    attachmentArchiveBucket.grantRead(documentImportWorker, "raw/private/notes/*");
    attachmentArchiveBucket.grantPut(documentImportWorker, "derived/private/extractions/*");

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
    const googleCalendarSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GoogleCalendarSecret",
      googleCalendarSecretName,
    );

    slackSigningSecret.grantRead(ingress);
    slackBotTokenSecret.grantRead(worker);
    slackBotTokenSecret.grantRead(scheduledRunner);
    anthropicApiKeySecret.grantRead(worker);
    anthropicApiKeySecret.grantRead(scheduledRunner);
    anthropicApiKeySecret.grantRead(documentImportWorker);
    anthropicApiKeySecret.grantRead(chatApi);
    googleCalendarSecret.grantRead(worker);
    googleCalendarSecret.grantRead(scheduledRunner);
    googleCalendarSecret.grantRead(documentImportWorker);
    googleCalendarSecret.grantRead(chatApi);

    const api = new apigateway.RestApi(this, "SlackEventsApi", {
      restApiName: "slack-ai-assistant-events",
      deployOptions: {
        stageName: "prod",
      },
    });

    const slackEventsResource = api.root.addResource("slack").addResource("events");
    slackEventsResource.addMethod("POST", new apigateway.LambdaIntegration(ingress));
    const importsResource = api.root.addResource("imports");
    importsResource.addResource("uploads").addMethod("POST", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    importsResource.addResource("documents").addMethod("POST", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    importsResource.addResource("markdown").addMethod("POST", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    importsResource
      .addResource("extractions")
      .addResource("markdown")
      .addMethod("POST", new apigateway.LambdaIntegration(documentImportApi), {
        authorizationType: apigateway.AuthorizationType.IAM,
      });
    const importSourceResource = importsResource
      .addResource("workspaces")
      .addResource("{workspaceId}")
      .addResource("sources")
      .addResource("{sourceId}");
    importSourceResource.addMethod("GET", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    importSourceResource.addResource("markdown").addMethod("GET", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    api.root
      .addResource("chat")
      .addResource("messages")
      .addMethod("POST", new apigateway.LambdaIntegration(chatApi), {
        authorizationType: apigateway.AuthorizationType.IAM,
      });

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
    new cdk.CfnOutput(this, "DocumentImportApiFunctionName", {
      value: documentImportApi.functionName,
    });
    new cdk.CfnOutput(this, "ChatApiFunctionName", {
      value: chatApi.functionName,
    });
    new cdk.CfnOutput(this, "DocumentImportWorkerFunctionName", {
      value: documentImportWorker.functionName,
    });
    new cdk.CfnOutput(this, "DocumentImportQueueUrl", {
      value: documentImportQueue.queueUrl,
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
    new cdk.CfnOutput(this, "SourceDocumentsTableName", {
      value: sourceDocumentsTable.tableName,
    });
    new cdk.CfnOutput(this, "TasksTableName", {
      value: tasksTable.tableName,
    });
    new cdk.CfnOutput(this, "TaskEventsTableName", {
      value: taskEventsTable.tableName,
    });
    new cdk.CfnOutput(this, "CalendarDraftsTableName", {
      value: calendarDraftsTable.tableName,
    });
    new cdk.CfnOutput(this, "SlackAttachmentArchiveBucketName", {
      value: attachmentArchiveBucket.bucketName,
    });
  }
}
