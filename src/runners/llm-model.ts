const SUBSCRIPTION_CLIS = ["cursor", "claude", "codex"] as const;

export type SubscriptionCli = (typeof SUBSCRIPTION_CLIS)[number];

export type LlmTarget =
  | { kind: "cli"; cli: SubscriptionCli; model?: string }
  | { kind: "gateway"; model: string };

function isSubscriptionCli(value: string): value is SubscriptionCli {
  return (SUBSCRIPTION_CLIS as readonly string[]).includes(value);
}

/** `cursor`, `claude`, and `codex` call that subscription CLI. Any other provider/model calls AI Gateway. */
export function parseLlmModel(model: string): LlmTarget {
  if (isSubscriptionCli(model)) return { kind: "cli", cli: model };
  const slash = model.indexOf("/");
  if (slash > 0) {
    const cli = model.slice(0, slash);
    const name = model.slice(slash + 1);
    if (isSubscriptionCli(cli) && name.length > 0 && !/[\s/]/.test(name)) {
      return { kind: "cli", cli, model: name };
    }
  }
  return { kind: "gateway", model };
}
