/** What a History row removes (Trio's History.DeletionTarget). */
export type RecordKind = 'insulin' | 'carbs' | 'glucose';

/**
 * History deletions go through the runtime (`@/runtime/record-deletion`), which removes the record from the data
 * store, Nightscout, Tidepool and Apple Health / Health Connect (each only when switched on) and re-runs the loop.
 * It is loaded on first use, so importing History actions does not pull in the whole services chain.
 *
 * `id` is the dose id, the carb entry id, or the glucose reading's source; `date` is the record's timestamp.
 */
export async function deleteRecordEverywhere(kind: RecordKind, id: string, date: number): Promise<void> {
  const { deleteRecordEverywhere: run } = await import('@/runtime/record-deletion');
  await run(kind, id, date);
}
