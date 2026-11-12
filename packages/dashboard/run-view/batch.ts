// Hands items over in batches: a burst (the replay of a long log, a command that prints a thousand lines) is one render, not one
// per item.

export interface Batcher<T> {
  /** Adds an item; the batch is delivered `ms` after the first item that found it empty. */
  push(item: T): void;
  /** Delivers what is waiting now (nothing, when nothing is). */
  flush(): void;
}

export function batcher<T>(deliver: (items: T[]) => void, ms: number): Batcher<T> {
  let items: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (items.length === 0) return;
    const arrived = items;
    items = [];
    deliver(arrived);
  };
  return {
    push(item) {
      items.push(item);
      timer ??= setTimeout(flush, ms);
    },
    flush,
  };
}
