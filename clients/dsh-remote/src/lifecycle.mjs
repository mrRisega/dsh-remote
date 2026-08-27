export function childStopped(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}
