export interface LogContext {
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly baseContext: LogContext = {}) {}

  child(context: LogContext): Logger {
    return new Logger({ ...this.baseContext, ...context });
  }

  info(message: string, context: LogContext = {}): void {
    this.write("INFO", message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.write("WARN", message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.write("ERROR", message, context);
  }

  private write(level: string, message: string, context: LogContext): void {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...this.baseContext,
        ...context,
      }),
    );
  }
}

export const logger = new Logger();
