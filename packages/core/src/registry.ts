/** Minimal, typed plugin registry. Registration order is preserved for display. */
export interface Registry<T extends { readonly meta: { readonly id: string } }> {
  register(plugin: T): Registry<T>;
  get(id: string): T | undefined;
  require(id: string): T;
  list(): readonly T[];
}

export function createRegistry<T extends { readonly meta: { readonly id: string } }>(initial: readonly T[] = []): Registry<T> {
  const items = new Map<string, T>();
  const registry: Registry<T> = {
    register(plugin) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(plugin.meta.id)) throw new Error(`Invalid plugin id "${plugin.meta.id}" (use kebab-case)`);
      if (items.has(plugin.meta.id)) throw new Error(`Plugin "${plugin.meta.id}" is already registered`);
      items.set(plugin.meta.id, plugin);
      return registry;
    },
    get: (id) => items.get(id),
    require(id) {
      const p = items.get(id);
      if (!p) throw new Error(`Unknown plugin "${id}"`);
      return p;
    },
    list: () => [...items.values()],
  };
  initial.forEach((p) => registry.register(p));
  return registry;
}
