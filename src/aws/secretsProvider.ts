import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export class SecretsProvider {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly client = new SecretsManagerClient({})) {}

  async getSecretString(secretId: string): Promise<string> {
    if (!this.cache.has(secretId)) {
      this.cache.set(secretId, this.fetchSecret(secretId));
    }

    return this.cache.get(secretId)!;
  }

  private async fetchSecret(secretId: string): Promise<string> {
    const response = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!response.SecretString) {
      throw new Error(`Secret ${secretId} does not contain SecretString`);
    }
    return response.SecretString;
  }
}
