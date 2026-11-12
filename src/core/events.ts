type Handler<T> = (payload: T) => void;

export class Emitter<E extends object> {
  private handlers: { [K in keyof E]?: Handler<E[K]>[] } = {};
  on<K extends keyof E>(type: K, fn: Handler<E[K]>): void {
    (this.handlers[type] ??= []).push(fn);
  }
  emit<K extends keyof E>(type: K, payload: E[K]): void {
    this.handlers[type]?.forEach((fn) => fn(payload));
  }
}
