export class WorkflowContext {
  private readonly state: Record<string, unknown> = {};
  private readonly returns: Record<string, unknown[]> = {};

  getState<T = unknown>(key: string): T | undefined {
    return this.state[key] as T | undefined;
  }

  setState(key: string, value: unknown): void {
    this.state[key] = value;
  }

  getReturn<T = unknown>(name: string): T | undefined {
    return this.returns[name]?.at(-1) as T | undefined;
  }

  getReturns<T = unknown>(name: string): T[] {
    return [...(this.returns[name] ?? [])] as T[];
  }

  env(key: string): string | undefined {
    return process.env[key];
  }

  snapshot(): {
    state: Record<string, unknown>;
    returns: Record<string, unknown[]>;
  } {
    return {
      state: { ...this.state },
      returns: Object.fromEntries(
        Object.entries(this.returns).map(([name, values]) => [
          name,
          [...values],
        ]),
      ),
    };
  }

  commit(changes: Record<string, unknown>): void {
    Object.assign(this.state, changes);
  }

  recordReturn(name: string, value: unknown): void {
    (this.returns[name] ??= []).push(value);
  }
}
