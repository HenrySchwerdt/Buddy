/** Validates values against a schema and returns a list of human-readable errors. */
export function validateSettings(sections, values) {
    const errors = [];
    for (const field of sections.flatMap((s) => s.fields)) {
        const v = values[field.key];
        switch (field.kind) {
            case 'number':
                if (typeof v !== 'number' || Number.isNaN(v))
                    errors.push(`${field.label}: must be a number`);
                else if (v < field.min || v > field.max)
                    errors.push(`${field.label}: must be between ${field.min} and ${field.max}`);
                break;
            case 'boolean':
                if (typeof v !== 'boolean')
                    errors.push(`${field.label}: must be on or off`);
                break;
            case 'select':
                if (!field.options.some((o) => o.value === v))
                    errors.push(`${field.label}: invalid choice`);
                break;
            case 'text':
                if (typeof v !== 'string')
                    errors.push(`${field.label}: must be text`);
                break;
        }
    }
    return errors;
}
/** Fills missing keys from defaults and clamps numbers into range. Returns a new object. */
export function normalizeSettings(sections, defaults, values) {
    const merged = { ...defaults, ...(values ?? {}) };
    for (const field of sections.flatMap((s) => s.fields)) {
        const v = merged[field.key];
        if (field.kind === 'number' && typeof v === 'number')
            merged[field.key] = Math.min(field.max, Math.max(field.min, v));
    }
    return merged;
}
