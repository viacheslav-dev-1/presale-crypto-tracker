import type { BotEvent, BotEventOfType } from "./bot-event.js";

type EventHandler<T extends BotEvent["type"]> = (event: BotEventOfType<T>) => Promise<void> | void;

export interface EventBus {
  on<T extends BotEvent["type"]>(type: T, handler: EventHandler<T>): () => void;
  emit(event: BotEvent): Promise<void>;
}

export function createEventBus(): EventBus {
  const handlers = new Map<BotEvent["type"], Set<(event: BotEvent) => Promise<void> | void>>();
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      const wrapped = handler as (event: BotEvent) => Promise<void> | void;
      set.add(wrapped);
      handlers.set(type, set);
      return () => set.delete(wrapped);
    },
    async emit(event) {
      await Promise.all([...(handlers.get(event.type) ?? [])].map((handler) => handler(event)));
    },
  };
}
