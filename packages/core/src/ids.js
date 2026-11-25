let counter = 0;
/** Unique-enough id for locally created records. */
export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
