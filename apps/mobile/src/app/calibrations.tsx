import { CalibrationSections } from '@/features/calibrations/calibration-view';
import { TrioScreen } from '@/trio';

/** Trio's Calibrations module, Buddy flavour: the Libre sensor calibration the drivers use (read-only). */
export default function CalibrationsScreen() {
  return (
    <TrioScreen back title="Calibrations">
      <CalibrationSections />
    </TrioScreen>
  );
}
