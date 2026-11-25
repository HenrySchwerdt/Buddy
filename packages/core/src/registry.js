export function createRegistry(initial = []) {
    const items = new Map();
    const registry = {
        register(plugin) {
            if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(plugin.meta.id))
                throw new Error(`Invalid plugin id "${plugin.meta.id}" (use kebab-case)`);
            if (items.has(plugin.meta.id))
                throw new Error(`Plugin "${plugin.meta.id}" is already registered`);
            items.set(plugin.meta.id, plugin);
            return registry;
        },
        get: (id) => items.get(id),
        require(id) {
            const p = items.get(id);
            if (!p)
                throw new Error(`Unknown plugin "${id}"`);
            return p;
        },
        list: () => [...items.values()],
    };
    initial.forEach((p) => registry.register(p));
    return registry;
}
