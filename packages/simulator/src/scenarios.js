const day = (offsetH, opts = {}) => [
    { at: (offsetH + 1) * 60, grams: 45, announced: true, bolusFraction: 1, ...opts },
    { at: (offsetH + 6) * 60, grams: 70, announced: true, bolusFraction: 1, ...opts },
    { at: (offsetH + 12) * 60, grams: 80, announced: true, bolusFraction: 1, ...opts },
];
export const SCENARIOS = [
    { id: 'standard-day', name: 'Standard day', description: 'Three announced and bolused meals.', hours: 24, meals: day(0), profileMismatch: 1 },
    {
        id: 'unannounced',
        name: 'Unannounced meals',
        description: 'Same meals, but nothing is logged or bolused. Tests UAM / meal detection.',
        hours: 24,
        meals: day(0, { announced: false, bolusFraction: 0 }),
        profileMismatch: 1,
    },
    {
        id: 'carb-counting-error',
        name: 'Carb counting error',
        description: 'Meals logged 30 % too low with a full bolus for the logged amount.',
        hours: 24,
        meals: day(0, { countingError: 0.7 }),
        profileMismatch: 1,
    },
    { id: 'resistant-day', name: 'Profile too weak', description: 'Profile underdoses by 25 % (illness, hormones).', hours: 24, meals: day(0), profileMismatch: 0.75 },
    { id: 'sensitive-day', name: 'Profile too strong', description: 'Profile overdoses by 25 % (exercise, heat).', hours: 24, meals: day(0), profileMismatch: 1.25 },
    { id: 'overnight', name: 'Overnight', description: '12 h fasting overnight after a late snack.', hours: 12, meals: [{ at: 30, grams: 25, announced: true, bolusFraction: 1 }], profileMismatch: 1 },
];
export const findScenario = (id) => {
    const s = SCENARIOS.find((x) => x.id === id);
    if (!s)
        throw new Error(`Unknown scenario "${id}"`);
    return s;
};
