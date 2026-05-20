import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export class SecretsProvider {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly client = new SSMClient({})) {}

  async getSecretString(parameterName: string): Promise<string> {
    if (!this.cache.has(parameterName)) {
      this.cache.set(parameterName, this.fetchParameter(parameterName));
    }

    return this.cache.get(parameterName)!;
  }

  private async fetchParameter(parameterName: string): Promise<string> {
    const response = await this.client.send(
      new GetParameterCommand({
        Name: parameterName,
        WithDecryption: true,
      }),
    );
    const value = response.Parameter?.Value;
    if (!value) {
      throw new Error(`SSM parameter ${parameterName} does not contain a value`);
    }
    return value;
  }
}
