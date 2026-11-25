/**
 * Declarative settings schema. Plugins (algorithms, pumps, CGMs) describe their settings
 * with these fields and the app renders a settings form automatically — no UI code needed
 * to add a plugin.
 */
export type SettingField =
  | {
      readonly kind: 'number';
      readonly key: string;
      readonly label: string;
      readonly help?: string;
      readonly unit?: string;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      /** Marks fields that directly scale insulin delivery; the UI highlights them. */
      readonly affectsDosing?: boolean;
    }
  | { readonly kind: 'boolean'; readonly key: string; readonly label: string; readonly help?: string; readonly affectsDosing?: boolean }
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly help?: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | { readonly kind: 'text'; readonly key: string; readonly label: string; readonly help?: string; readonly secret?: boolean; readonly placeholder?: string };

export interface SettingsSection {
  readonly title: string;
  readonly fields: readonly SettingField[];
}

export type SettingsValues = Readonly<Record<string, number | boolean | string>>;

/** Validates values against a schema and returns a list of human-readable errors. */
export function validateSettings(sections: readonly SettingsSection[], values: SettingsValues): string[] {
  const errors: string[] = [];
  for (const field of sections.flatMap((s) => s.fields)) {
    const v = values[field.key];
    switch (field.kind) {
      case 'number':
        if (typeof v !== 'number' || Number.isNaN(v)) errors.push(`${field.label}: must be a number`);
        else if (v < field.min || v > field.max) errors.push(`${field.label}: must be between ${field.min} and ${field.max}`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`${field.label}: must be on or off`);
        break;
      case 'select':
        if (!field.options.some((o) => o.value === v)) errors.push(`${field.label}: invalid choice`);
        break;
      case 'text':
        if (typeof v !== 'string') errors.push(`${field.label}: must be text`);
        break;
    }
  }
  return errors;
}

/** Fills missing keys from defaults and clamps numbers into range. Returns a new object. */
export function normalizeSettings<T extends SettingsValues>(sections: readonly SettingsSection[], defaults: T, values: SettingsValues | undefined): T {
  const merged: Record<string, number | boolean | string> = { ...defaults, ...(values ?? {}) };
  for (const field of sections.flatMap((s) => s.fields)) {
    const v = merged[field.key];
    if (field.kind === 'number' && typeof v === 'number') merged[field.key] = Math.min(field.max, Math.max(field.min, v));
  }
  return merged as T;
}
