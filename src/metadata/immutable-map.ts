/**
 * A small immutable Map implementation used inside metadata snapshots.
 *
 * `Object.freeze(new Map())` is still mutable through Map.prototype.set().
 * This wrapper exposes no mutation operations and keeps its backing Map in a
 * private field. The repository snapshot validator recognizes only genuine
 * instances of this class and traverses their captured entries explicitly.
 */
export class ImmutableMetadataMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#values[Symbol.iterator]();
  }
  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      Reflect.apply(callbackfn, thisArg, [value, key, this]);
    }
  }
}

Object.freeze(ImmutableMetadataMap.prototype);

/** Internal trust predicate used by the bounded repository snapshot walk. */
export function isImmutableMetadataMap(
  value: object,
): value is ImmutableMetadataMap<unknown, unknown> {
  return value instanceof ImmutableMetadataMap &&
    Object.getPrototypeOf(value) === ImmutableMetadataMap.prototype;
}

/** Capture entries without exposing the private mutable backing collection. */
export function immutableMetadataMapEntries(
  value: ImmutableMetadataMap<unknown, unknown>,
): readonly (readonly [unknown, unknown])[] {
  return Object.freeze(
    [...value].map(([key, entry]) => Object.freeze([key, entry] as const)),
  );
}
