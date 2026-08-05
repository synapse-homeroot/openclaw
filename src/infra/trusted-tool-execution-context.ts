const lifecycleGenerationByEvent = new WeakMap<object, string>();

export function captureTrustedToolExecutionLifecycleGeneration(
  event: object,
  lifecycleGeneration: string,
): void {
  lifecycleGenerationByEvent.set(event, lifecycleGeneration);
}

export function getTrustedToolExecutionLifecycleGeneration(event: object): string | undefined {
  return lifecycleGenerationByEvent.get(event);
}
