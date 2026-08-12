function isWalletRejection(value: unknown): boolean {
  if (!value || (typeof value !== "object" && typeof value !== "string")) return false;
  if (typeof value === "object") {
    const error = value as { code?: unknown; cause?: { code?: unknown }; data?: { cause?: { code?: unknown } }; message?: unknown };
    if (error.code === 4001 || error.cause?.code === 4001 || error.data?.cause?.code === 4001) return true;
    value = error.message;
  }
  return typeof value === "string" && /^user rejected (the )?request$/i.test(value);
}

function isMetaMaskInitializationFailure(args: unknown[]): boolean {
  return args.some((value) => {
    const message = typeof value === "string"
      ? value
      : value && typeof value === "object" && "message" in value
        ? String((value as { message: unknown }).message)
        : "";
    return /^MetaMask: Failed to get initial state\. Please report this bug\./.test(message);
  });
}

function installConsoleGuard() {
  const current = window.console.error as typeof window.console.error & { sprintPilotGuard?: boolean };
  if (current.sprintPilotGuard) return;
  const guarded = ((...args: unknown[]) => {
    if (!isMetaMaskInitializationFailure(args)) current.apply(window.console, args);
  }) as typeof current;
  Object.defineProperty(guarded, "sprintPilotGuard", { value: true });
  let active = guarded;
  Object.defineProperty(window.console, "error", {
    configurable: true,
    enumerable: true,
    get: () => active,
    set: (next: typeof window.console.error & { sprintPilotGuard?: boolean }) => {
      if (next.sprintPilotGuard) {
        active = next;
        return;
      }
      const wrapped = ((...args: unknown[]) => {
        if (!isMetaMaskInitializationFailure(args)) next.apply(window.console, args);
      }) as typeof next;
      Object.defineProperty(wrapped, "sprintPilotGuard", { value: true });
      active = wrapped;
    },
  });
}

installConsoleGuard();
queueMicrotask(installConsoleGuard);
setTimeout(installConsoleGuard, 0);

window.addEventListener("unhandledrejection", (event) => {
  if (isWalletRejection(event.reason) || isMetaMaskInitializationFailure([event.reason])) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

window.addEventListener("error", (event) => {
  if (event.filename.startsWith("chrome-extension://") && /metamask|failed to get initial state|user rejected/i.test(event.message)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
