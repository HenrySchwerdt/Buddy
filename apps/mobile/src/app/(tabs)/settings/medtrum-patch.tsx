import { TrioScreen } from '@/trio';
import { MedtrumPatchFlow } from '@/features/devices/medtrum-patch-flow';

/** Medtrum Nano patch lifecycle (prime → activate → deactivate); also reachable from the pump sheet. */
export default function MedtrumPatch() {
  return (
    <TrioScreen title="Patch" back>
      <MedtrumPatchFlow />
    </TrioScreen>
  );
}
